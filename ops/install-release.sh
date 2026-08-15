#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 /path/to/agent-outpost-checkout" >&2
  exit 1
fi

source_directory=$(realpath "$1")
workspace_root=/srv/agent-outpost/workspace
if [[ "${source_directory}" != "${workspace_root}" ]]; then
  echo "Source directory must be ${workspace_root}." >&2
  exit 1
fi
if [[ ! -f "${source_directory}/package-lock.json" || ! -d "${source_directory}/public" ]]; then
  echo "Source directory does not look like an Agent Outpost checkout." >&2
  exit 1
fi

release_id=$(date -u +%Y%m%d%H%M%S)
release_directory="/opt/agent-outpost/releases/${release_id}"
previous_release=
if [[ -L /opt/agent-outpost/current ]]; then
  previous_release=$(readlink -f /opt/agent-outpost/current || true)
fi
install -d -o agent-outpost -g agent-outpost -m 0755 "${release_directory}"

cd "${source_directory}"
runuser -u agent-outpost -- npm ci
runuser -u agent-outpost -- npm run typecheck
runuser -u agent-outpost -- npm test
runuser -u agent-outpost -- npm run build

runuser -u agent-outpost -- rsync -a --delete \
  --exclude node_modules \
  --exclude data \
  --exclude .git \
  "${source_directory}/" "${release_directory}/"

runuser -u agent-outpost -- bash -c "cd '${release_directory}' && npm ci --omit=dev"
chown -R root:root "${release_directory}"
find "${release_directory}" -type d -exec chmod 0755 {} +
find "${release_directory}" -type f -exec chmod 0644 {} +

ln -sfn "${release_directory}" /opt/agent-outpost/current.next
mv -Tf /opt/agent-outpost/current.next /opt/agent-outpost/current
systemctl restart agent-outpost.service || true

for _ in {1..60}; do
  if curl --fail --silent http://127.0.0.1:3000/ready >/dev/null; then
    systemctl enable agent-outpost.service
    echo "Installed release ${release_id}."
    exit 0
  fi
  sleep 1
done

systemctl status agent-outpost.service --no-pager >&2 || true
echo "The release did not become healthy; restoring the previous release." >&2
if [[ -n "${previous_release}" && -d "${previous_release}" ]]; then
  ln -sfn "${previous_release}" /opt/agent-outpost/current.next
  mv -Tf /opt/agent-outpost/current.next /opt/agent-outpost/current
  systemctl restart agent-outpost.service || true
  for _ in {1..60}; do
    if curl --fail --silent http://127.0.0.1:3000/ready >/dev/null; then
      echo "Restored ${previous_release}." >&2
      exit 1
    fi
    sleep 1
  done
  echo "The previous release also failed readiness after restoration." >&2
fi
exit 1
