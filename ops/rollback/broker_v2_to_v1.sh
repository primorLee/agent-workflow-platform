#!/bin/sh
# Disabled compatibility stub.
#
# The public control-plane entrypoint does not read the former broker-version
# environment flags, so changing them would not perform a real rollback. Keep
# this command fail-closed until a composed deployment defines and tests an
# actual rollback mechanism.
set -eu
printf '%s\n' 'broker_v2_to_v1.sh: unsupported: no wired public rollback target' >&2
exit 77
