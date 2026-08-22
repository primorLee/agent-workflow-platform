# CentOS 7 — sysvinit path (no systemd in container)
# CentOS 7 is EOL; vault mirrors required.
FROM centos:7

RUN sed -i 's|^mirrorlist=|#mirrorlist=|g' /etc/yum.repos.d/CentOS-*.repo && \
    sed -i 's|^#baseurl=http://mirror.centos.org|baseurl=http://vault.centos.org|g' /etc/yum.repos.d/CentOS-*.repo && \
    yum -y install \
        curl wget which gnupg2 initscripts shadow-utils \
        ca-certificates hostname procps-ng \
    && yum clean all

# Smoke test expects init=sysv on this image.
ENV AWP_SMOKE_INIT=sysv

WORKDIR /smoke
CMD ["/bin/sh", "/src/test/distros/common/smoke.sh", "centos7", "sysv"]
