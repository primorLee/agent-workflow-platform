# openSUSE Leap 15.x — systemd-in-docker path
FROM opensuse/leap:15.5

RUN zypper -n refresh && \
    zypper -n install --no-recommends \
        curl wget gpg2 systemd shadow procps hostname ca-certificates \
    && zypper clean -a

ENV AWP_SMOKE_INIT=systemd
STOPSIGNAL SIGRTMIN+3

WORKDIR /smoke
CMD ["/bin/sh", "/src/test/distros/common/smoke.sh", "opensuse-leap-15", "systemd"]
