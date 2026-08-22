# RPM source-preview structure for awp-vm-agent.
# Building and every host lifecycle phase fail closed until a signed release exists.

%global debug_package %{nil}
%global _binaries_in_noarch_packages_terminate_build 0

%define _version %{!?_version:0.1.0}%{?_version}
%define _agent_user awp-vm-agent
%define _bindir /usr/local/bin
%define _confdir /etc/awp-vm-agent
%define _datadir_agent /var/lib/awp-vm-agent
%define _logdir_agent /var/log/awp-vm-agent
%define _unitdir_agent /usr/lib/systemd/system

Name:           awp-vm-agent
Version:        %{_version}
Release:        1%{?dist}
Summary:        Agent Workflow Platform outbound WebSocket worker
License:        MIT
URL:            https://github.com/primorLee/agent-workflow-platform
Vendor:         Agent Workflow Platform
Packager:       Agent Workflow Platform <support@example.invalid>
BuildArch:      x86_64

Source0:        awp-vm-agent-%{version}-linux-amd64
Source1:        awp-vm-agent.service
Source2:        awp-vm-agent.init.d
Source3:        config.yaml.example

Requires:       ca-certificates
Requires(pre):  shadow-utils
Requires(post): systemd
Requires(preun): systemd
Requires(postun): systemd

%description
This file preserves the proposed RPM composition for review. The repository is
a source preview: it publishes no signed binary or tag, so package build,
installation, upgrade, removal, and purge are intentionally unsupported.

%prep
echo "awp-vm-agent RPM build is unsupported in this source preview until a signed release is published" >&2
exit 77

%build
echo "awp-vm-agent RPM build is unsupported in this source preview until a signed release is published" >&2
exit 77

%install
echo "awp-vm-agent RPM build is unsupported in this source preview until a signed release is published" >&2
exit 77

%pre
echo "awp-vm-agent RPM installation is unsupported in this source preview until a signed release is published" >&2
exit 77

%post
echo "awp-vm-agent RPM package lifecycle is unsupported in this source preview until a signed release is published" >&2
exit 77

%preun
echo "awp-vm-agent RPM package lifecycle is unsupported in this source preview until a signed release is published" >&2
exit 77

%postun
echo "awp-vm-agent RPM package lifecycle is unsupported in this source preview until a signed release is published" >&2
exit 77

%files
%defattr(-,root,root,-)
%{_bindir}/awp-vm-agent
%{_unitdir_agent}/awp-vm-agent.service
/etc/init.d/awp-vm-agent
%dir %{_confdir}
%config(noreplace) %{_confdir}/config.yaml
%dir %attr(0750, %{_agent_user}, %{_agent_user}) %{_datadir_agent}
%dir %attr(0750, %{_agent_user}, %{_agent_user}) %{_logdir_agent}

%changelog
* Sat Aug 22 2026 Agent Workflow Platform <support@example.invalid> - 0.1.0-1
- Marked all RPM build and lifecycle paths unsupported for the source preview.
