# Amazon Linux 2 — sysvinit path (no systemd-in-docker for this matrix)
FROM amazonlinux:2

RUN yum -y install \
        curl wget gnupg2 initscripts shadow-utils procps-ng \
        hostname ca-certificates which \
    && yum clean all

# amzn2 ships systemd but running full systemd in docker is flaky; fall back
# to sysv init scripts for the smoke.
ENV AWP_SMOKE_INIT=sysv

WORKDIR /smoke
CMD ["/bin/sh", "/src/test/distros/common/smoke.sh", "amazonlinux2", "sysv"]
