# Rocky Linux 9 — systemd-in-docker
FROM rockylinux:9

RUN dnf -y install \
        curl wget gnupg2 systemd shadow-utils procps-ng hostname ca-certificates \
    && dnf clean all

ENV AWP_SMOKE_INIT=systemd
STOPSIGNAL SIGRTMIN+3

WORKDIR /smoke
# In CI we usually run `smoke.sh` directly since booting full systemd-in-docker
# is flaky. The smoke script tolerates an absent /run/systemd/system and falls
# back to log-based verification. Full-boot mode:
#   docker run --privileged --tmpfs /tmp --tmpfs /run --tmpfs /run/lock \
#       -v /sys/fs/cgroup:/sys/fs/cgroup:ro <image> /sbin/init
CMD ["/bin/sh", "/src/test/distros/common/smoke.sh", "rocky9", "systemd"]
