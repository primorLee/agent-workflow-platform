# Debian 12 (Bookworm) — systemd-in-docker path
FROM debian:12

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl wget ca-certificates gnupg systemd systemd-sysv \
        procps hostname dash adduser \
    && rm -rf /var/lib/apt/lists/*

ENV AWP_SMOKE_INIT=systemd
STOPSIGNAL SIGRTMIN+3

WORKDIR /smoke
CMD ["/bin/sh", "/src/test/distros/common/smoke.sh", "debian12", "systemd"]
