// LD_PRELOAD shim that emulates NETLINK_ROUTE sockets for programs running in
// proot on Android 11+, where binding netlink sockets is denied for apps.
// Firefox uses netlink to list local addresses for WebRTC ICE; without it no
// candidates are gathered and calls fail. Address data comes from the
// SIOCGIFCONF/SIOCGIF* ioctls, which Android still allows.
//
// Only IPv4 addresses are reported. Netlink notifications (multicast groups)
// are accepted but never delivered.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <linux/netlink.h>
#include <linux/rtnetlink.h>
#include <net/if.h>
#include <net/if_arp.h>
#include <netinet/in.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdarg.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <unistd.h>

#define MAX_FDS 4096
#define MAX_IFS 32
#define RESP_SIZE 16384

// peer[fd] is the socketpair end we write replies to, or 0 if fd is not fake.
static int peer[MAX_FDS];
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;

static int debug;
static int (*real_socket)(int, int, int);
static int (*real_close)(int);
static ssize_t (*real_sendto)(int, const void *, size_t, int, const struct sockaddr *, socklen_t);
static ssize_t (*real_sendmsg)(int, const struct msghdr *, int);
static ssize_t (*real_recvfrom)(int, void *, size_t, int, struct sockaddr *, socklen_t *);
static ssize_t (*real_recvmsg)(int, struct msghdr *, int);
static ssize_t (*real_write)(int, const void *, size_t);
static int (*real_bind)(int, const struct sockaddr *, socklen_t);
static int (*real_connect)(int, const struct sockaddr *, socklen_t);
static int (*real_getsockname)(int, struct sockaddr *, socklen_t *);
static int (*real_setsockopt)(int, int, int, const void *, socklen_t);

__attribute__((constructor)) static void init(void) {
  debug = getenv("NETLINK_SHIM_DEBUG") != NULL;
  real_socket = dlsym(RTLD_NEXT, "socket");
  real_close = dlsym(RTLD_NEXT, "close");
  real_sendto = dlsym(RTLD_NEXT, "sendto");
  real_sendmsg = dlsym(RTLD_NEXT, "sendmsg");
  real_recvfrom = dlsym(RTLD_NEXT, "recvfrom");
  real_recvmsg = dlsym(RTLD_NEXT, "recvmsg");
  real_write = dlsym(RTLD_NEXT, "write");
  real_bind = dlsym(RTLD_NEXT, "bind");
  real_connect = dlsym(RTLD_NEXT, "connect");
  real_getsockname = dlsym(RTLD_NEXT, "getsockname");
  real_setsockopt = dlsym(RTLD_NEXT, "setsockopt");
}

static int is_fake(int fd) {
  return fd >= 0 && fd < MAX_FDS && peer[fd] > 0;
}

static void fill_nladdr(struct sockaddr *addr, socklen_t *len, unsigned pid) {
  if (!addr || !len) return;
  struct sockaddr_nl nl = {.nl_family = AF_NETLINK, .nl_pid = pid};
  socklen_t n = *len < sizeof(nl) ? *len : sizeof(nl);
  memcpy(addr, &nl, n);
  *len = sizeof(nl);
}

struct iface {
  char name[IFNAMSIZ];
  struct in_addr addr;
  struct in_addr mask;
  int index;
  unsigned flags;
  int mtu;
};

static int list_ifaces(struct iface *out, int max) {
  int s = real_socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  if (s < 0) return 0;
  struct ifreq reqs[MAX_IFS];
  struct ifconf ifc = {.ifc_len = sizeof(reqs), .ifc_req = reqs};
  int n = 0;
  if (ioctl(s, SIOCGIFCONF, &ifc) == 0) {
    int count = ifc.ifc_len / sizeof(struct ifreq);
    for (int i = 0; i < count && n < max; i++) {
      struct iface *f = &out[n];
      struct ifreq r;
      memset(f, 0, sizeof(*f));
      strncpy(f->name, reqs[i].ifr_name, IFNAMSIZ - 1);
      f->addr = ((struct sockaddr_in *)&reqs[i].ifr_addr)->sin_addr;
      memset(&r, 0, sizeof(r));
      strncpy(r.ifr_name, f->name, IFNAMSIZ - 1);
      if (ioctl(s, SIOCGIFINDEX, &r) == 0) f->index = r.ifr_ifindex;
      else f->index = i + 1;
      if (ioctl(s, SIOCGIFFLAGS, &r) == 0) f->flags = (unsigned short)r.ifr_flags;
      if (ioctl(s, SIOCGIFNETMASK, &r) == 0) f->mask = ((struct sockaddr_in *)&r.ifr_netmask)->sin_addr;
      if (ioctl(s, SIOCGIFMTU, &r) == 0) f->mtu = r.ifr_mtu;
      n++;
    }
  }
  real_close(s);
  return n;
}

static int prefix_len(struct in_addr mask) {
  return __builtin_popcount(mask.s_addr);
}

// Appends one rtattr to the message at buf+*off; returns 0 if out of space.
static int add_attr(char *buf, size_t *off, unsigned short type, const void *data, size_t len) {
  size_t total = RTA_SPACE(len);
  if (*off + total > RESP_SIZE) return 0;
  struct rtattr *rta = (struct rtattr *)(buf + *off);
  rta->rta_type = type;
  rta->rta_len = RTA_LENGTH(len);
  memcpy(RTA_DATA(rta), data, len);
  memset((char *)RTA_DATA(rta) + len, 0, total - RTA_LENGTH(len));
  *off += total;
  return 1;
}

static struct nlmsghdr *begin_msg(char *buf, size_t *off, unsigned short type,
                                  unsigned short flags, unsigned seq, unsigned pid, size_t body) {
  if (*off + NLMSG_SPACE(body) > RESP_SIZE) return NULL;
  struct nlmsghdr *h = (struct nlmsghdr *)(buf + *off);
  memset(h, 0, NLMSG_SPACE(body));
  h->nlmsg_type = type;
  h->nlmsg_flags = flags;
  h->nlmsg_seq = seq;
  h->nlmsg_pid = pid;
  *off += NLMSG_SPACE(body);
  return h;
}

static void end_msg(char *buf, struct nlmsghdr *h, size_t off) {
  h->nlmsg_len = (char *)buf + off - (char *)h;
}

static void build_addrs(char *buf, size_t *off, const struct nlmsghdr *req, unsigned pid) {
  const struct ifaddrmsg *want = NLMSG_DATA(req);
  if (req->nlmsg_len >= NLMSG_LENGTH(sizeof(*want)) &&
      want->ifa_family != AF_UNSPEC && want->ifa_family != AF_INET)
    return;
  struct iface ifs[MAX_IFS];
  int n = list_ifaces(ifs, MAX_IFS);
  for (int i = 0; i < n; i++) {
    struct nlmsghdr *h = begin_msg(buf, off, RTM_NEWADDR, NLM_F_MULTI, req->nlmsg_seq, pid,
                                   sizeof(struct ifaddrmsg));
    if (!h) return;
    struct ifaddrmsg *ifa = NLMSG_DATA(h);
    ifa->ifa_family = AF_INET;
    ifa->ifa_prefixlen = prefix_len(ifs[i].mask);
    ifa->ifa_flags = IFA_F_PERMANENT;
    ifa->ifa_scope = (ifs[i].flags & IFF_LOOPBACK) ? RT_SCOPE_HOST : RT_SCOPE_UNIVERSE;
    ifa->ifa_index = ifs[i].index;
    add_attr(buf, off, IFA_ADDRESS, &ifs[i].addr, 4);
    add_attr(buf, off, IFA_LOCAL, &ifs[i].addr, 4);
    add_attr(buf, off, IFA_LABEL, ifs[i].name, strlen(ifs[i].name) + 1);
    end_msg(buf, h, *off);
  }
}

static void build_links(char *buf, size_t *off, const struct nlmsghdr *req, unsigned pid) {
  struct iface ifs[MAX_IFS];
  int n = list_ifaces(ifs, MAX_IFS);
  for (int i = 0; i < n; i++) {
    struct nlmsghdr *h = begin_msg(buf, off, RTM_NEWLINK, NLM_F_MULTI, req->nlmsg_seq, pid,
                                   sizeof(struct ifinfomsg));
    if (!h) return;
    struct ifinfomsg *ifi = NLMSG_DATA(h);
    ifi->ifi_family = AF_UNSPEC;
    ifi->ifi_type = (ifs[i].flags & IFF_LOOPBACK) ? ARPHRD_LOOPBACK : ARPHRD_ETHER;
    ifi->ifi_index = ifs[i].index;
    ifi->ifi_flags = ifs[i].flags;
    ifi->ifi_change = 0xffffffff;
    add_attr(buf, off, IFLA_IFNAME, ifs[i].name, strlen(ifs[i].name) + 1);
    if (ifs[i].mtu > 0) add_attr(buf, off, IFLA_MTU, &ifs[i].mtu, 4);
    end_msg(buf, h, *off);
  }
}

// Answers every request in buf with a single reply datagram on the peer end.
static void handle_request(int fd, const char *data, size_t len) {
  static char buf[RESP_SIZE];
  pthread_mutex_lock(&lock);
  size_t off = 0;
  unsigned pid = (unsigned)getpid();
  const struct nlmsghdr *req = (const struct nlmsghdr *)data;
  int remaining = (int)len;
  for (; NLMSG_OK(req, remaining); req = NLMSG_NEXT(req, remaining)) {
    int dump = req->nlmsg_flags & NLM_F_DUMP;
    if (debug)
      fprintf(stderr, "[netlink-shim %d] request type=%d flags=0x%x\n", getpid(), req->nlmsg_type,
              req->nlmsg_flags);
    if (req->nlmsg_type == RTM_GETADDR && dump) build_addrs(buf, &off, req, pid);
    else if (req->nlmsg_type == RTM_GETLINK && dump) build_links(buf, &off, req, pid);
    if (dump) {
      struct nlmsghdr *h = begin_msg(buf, &off, NLMSG_DONE, NLM_F_MULTI, req->nlmsg_seq, pid, sizeof(int));
      if (h) end_msg(buf, h, off);
    } else if (req->nlmsg_flags & NLM_F_ACK) {
      struct nlmsghdr *h = begin_msg(buf, &off, NLMSG_ERROR, 0, req->nlmsg_seq, pid, sizeof(struct nlmsgerr));
      if (h) {
        struct nlmsgerr *err = NLMSG_DATA(h);
        err->error = 0;
        err->msg = *req;
        end_msg(buf, h, off);
      }
    }
  }
  if (off > 0) real_write(peer[fd], buf, off);
  pthread_mutex_unlock(&lock);
}

int socket(int domain, int type, int protocol) {
  if (domain == AF_NETLINK && debug)
    fprintf(stderr, "[netlink-shim %d] socket(AF_NETLINK, %d, %d)\n", getpid(), type, protocol);
  if (domain != AF_NETLINK || protocol != NETLINK_ROUTE) return real_socket(domain, type, protocol);
  int sv[2];
  int flags = type & (SOCK_NONBLOCK | SOCK_CLOEXEC);
  if (socketpair(AF_UNIX, SOCK_DGRAM | flags, 0, sv) < 0) return -1;
  if (sv[0] >= MAX_FDS || sv[1] >= MAX_FDS) {
    real_close(sv[0]);
    real_close(sv[1]);
    errno = EMFILE;
    return -1;
  }
  peer[sv[0]] = sv[1];
  return sv[0];
}

int close(int fd) {
  if (is_fake(fd)) {
    real_close(peer[fd]);
    peer[fd] = 0;
  }
  return real_close(fd);
}

int bind(int fd, const struct sockaddr *addr, socklen_t len) {
  if (is_fake(fd)) return 0;
  return real_bind(fd, addr, len);
}

int connect(int fd, const struct sockaddr *addr, socklen_t len) {
  if (is_fake(fd)) return 0;
  return real_connect(fd, addr, len);
}

int getsockname(int fd, struct sockaddr *addr, socklen_t *len) {
  if (is_fake(fd)) {
    fill_nladdr(addr, len, (unsigned)getpid());
    return 0;
  }
  return real_getsockname(fd, addr, len);
}

int setsockopt(int fd, int level, int name, const void *val, socklen_t len) {
  if (is_fake(fd) && (level == SOL_NETLINK || level == SOL_SOCKET)) return 0;
  return real_setsockopt(fd, level, name, val, len);
}

ssize_t sendto(int fd, const void *buf, size_t len, int flags, const struct sockaddr *to, socklen_t tolen) {
  if (is_fake(fd)) {
    handle_request(fd, buf, len);
    return (ssize_t)len;
  }
  return real_sendto(fd, buf, len, flags, to, tolen);
}

ssize_t send(int fd, const void *buf, size_t len, int flags) {
  return sendto(fd, buf, len, flags, NULL, 0);
}

ssize_t write(int fd, const void *buf, size_t len) {
  if (is_fake(fd)) {
    handle_request(fd, buf, len);
    return (ssize_t)len;
  }
  return real_write(fd, buf, len);
}

ssize_t sendmsg(int fd, const struct msghdr *msg, int flags) {
  if (!is_fake(fd)) return real_sendmsg(fd, msg, flags);
  char data[RESP_SIZE];
  size_t len = 0;
  for (size_t i = 0; i < msg->msg_iovlen; i++) {
    size_t n = msg->msg_iov[i].iov_len;
    if (len + n > sizeof(data)) n = sizeof(data) - len;
    memcpy(data + len, msg->msg_iov[i].iov_base, n);
    len += n;
  }
  handle_request(fd, data, len);
  return (ssize_t)len;
}

ssize_t recvfrom(int fd, void *buf, size_t len, int flags, struct sockaddr *from, socklen_t *fromlen) {
  if (!is_fake(fd)) return real_recvfrom(fd, buf, len, flags, from, fromlen);
  ssize_t n = real_recvfrom(fd, buf, len, flags, NULL, NULL);
  if (n >= 0) fill_nladdr(from, fromlen, 0);
  return n;
}

ssize_t recv(int fd, void *buf, size_t len, int flags) {
  return recvfrom(fd, buf, len, flags, NULL, NULL);
}

ssize_t recvmsg(int fd, struct msghdr *msg, int flags) {
  if (!is_fake(fd)) return real_recvmsg(fd, msg, flags);
  void *name = msg->msg_name;
  socklen_t namelen = msg->msg_namelen;
  msg->msg_name = NULL;
  msg->msg_namelen = 0;
  ssize_t n = real_recvmsg(fd, msg, flags);
  msg->msg_name = name;
  msg->msg_namelen = namelen;
  if (n >= 0) fill_nladdr(name, &msg->msg_namelen, 0);
  return n;
}

// glibc implements these with an internal netlink socket that the socket()
// override above cannot reach, so they are reimplemented with ioctls.
char *if_indextoname(unsigned index, char name[IF_NAMESIZE]) {
  int s = real_socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  if (s < 0) return NULL;
  struct ifreq r;
  memset(&r, 0, sizeof(r));
  r.ifr_ifindex = (int)index;
  int rc = ioctl(s, SIOCGIFNAME, &r);
  int err = errno;
  real_close(s);
  if (rc < 0) {
    errno = err == ENODEV ? ENXIO : err;
    return NULL;
  }
  memcpy(name, r.ifr_name, IFNAMSIZ);
  name[IFNAMSIZ - 1] = '\0';
  return name;
}

unsigned if_nametoindex(const char *name) {
  int s = real_socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  if (s < 0) return 0;
  struct ifreq r;
  memset(&r, 0, sizeof(r));
  strncpy(r.ifr_name, name, IFNAMSIZ - 1);
  int rc = ioctl(s, SIOCGIFINDEX, &r);
  real_close(s);
  return rc < 0 ? 0 : (unsigned)r.ifr_ifindex;
}

struct if_nameindex *if_nameindex(void) {
  struct iface ifs[MAX_IFS];
  int n = list_ifaces(ifs, MAX_IFS);
  struct if_nameindex *out = calloc(n + 1, sizeof(*out));
  if (!out) return NULL;
  for (int i = 0; i < n; i++) {
    out[i].if_index = ifs[i].index;
    out[i].if_name = strdup(ifs[i].name);
  }
  return out;
}

void if_freenameindex(struct if_nameindex *ptr) {
  if (!ptr) return;
  for (struct if_nameindex *p = ptr; p->if_name; p++) free(p->if_name);
  free(ptr);
}
