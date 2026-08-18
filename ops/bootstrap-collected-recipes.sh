#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

readonly source_directory=/srv/agent-outpost/workspace
readonly recipes_workspace=/srv/agent-outpost/projects/collected-recipes/workspace
readonly recipes_remote=https://github.com/amunger/collected-recipes.git
readonly integration_branch=agent/current

cd /

if [[
  ! -f "${source_directory}/ops/collected-recipes-deploy" ||
  ! -f "${source_directory}/ops/projects.json.example"
]]; then
  echo "The Agent Outpost workspace does not contain Collected Recipes provisioning files." >&2
  exit 1
fi

memory_kib=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)
available_memory_kib=$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo)
available_disk_kib=$(df --output=avail -k / | tail -n 1 | tr -d ' ')
if [[
  $(nproc) -lt 2 ||
  "${memory_kib}" -lt 3500000 ||
  "${available_memory_kib}" -lt 2000000 ||
  "${available_disk_kib}" -lt 20000000
]]; then
  echo "At least 2 CPUs, 3.5 GB total RAM, 2 GB currently available RAM, and 20 GB free disk are required before co-location." >&2
  exit 1
fi

if ! runuser -u agent-outpost -- git ls-remote \
  --exit-code \
  "${recipes_remote}" \
  "refs/heads/${integration_branch}" >/dev/null; then
  echo "Seed ${recipes_remote} branch ${integration_branch} before provisioning." >&2
  exit 1
fi

apt-get \
  -o Acquire::Retries=5 \
  -o Acquire::http::Timeout=30 \
  update
DEBIAN_FRONTEND=noninteractive apt-get \
  -o Acquire::Retries=5 \
  -o Acquire::http::Timeout=30 \
  install -y --fix-missing \
  curl \
  fuse-overlayfs \
  jq \
  podman \
  rsync \
  slirp4netns \
  sqlite3 \
  uidmap

install -d -o root -g root -m 0755 /var/lib/collected-recipes
for account in collected-recipes-build collected-recipes-runtime; do
  if ! id "${account}" >/dev/null 2>&1; then
    account_home=/var/lib/collected-recipes/runtime
    if [[ "${account}" == collected-recipes-build ]]; then
      account_home=/var/lib/collected-recipes/build-home
    fi
    useradd \
      --create-home \
      --home-dir "${account_home}" \
      --shell /usr/sbin/nologin \
      "${account}"
  fi
  if ! grep -q "^${account}:" /etc/subuid || ! grep -q "^${account}:" /etc/subgid; then
    echo "Rootless Podman subordinate IDs were not allocated for ${account}." >&2
    exit 1
  fi
done

install -d -o agent-outpost -g agent-outpost -m 0755 \
  /srv/agent-outpost/projects \
  /srv/agent-outpost/projects/collected-recipes
install -d -o agent-outpost -g agent-outpost -m 0700 \
  /var/lib/collected-recipes/deploy-requests \
  /var/lib/collected-recipes/operator-builds
install -d -o collected-recipes-build -g collected-recipes-build -m 0700 \
  /var/lib/collected-recipes/build-home \
  /var/lib/collected-recipes/builds \
  /var/lib/collected-recipes/images \
  /run/collected-recipes-build
install -d -o collected-recipes-runtime -g collected-recipes-runtime -m 0700 \
  /var/lib/collected-recipes/runtime \
  /var/lib/collected-recipes/data \
  /run/collected-recipes
install -d -o root -g root -m 0700 \
  /var/lib/collected-recipes/deployment \
  /var/lib/collected-recipes/backups \
  /etc/collected-recipes

if [[ ! -d "${recipes_workspace}/.git" ]]; then
  runuser -u agent-outpost -- git clone \
    --branch "${integration_branch}" \
    --single-branch \
    "${recipes_remote}" \
    "${recipes_workspace}"
fi
if [[
  $(runuser -u agent-outpost -- git -C "${recipes_workspace}" remote get-url origin) != "${recipes_remote}" ||
  $(runuser -u agent-outpost -- git -C "${recipes_workspace}" branch --show-current) != "${integration_branch}"
]]; then
  echo "Collected Recipes workspace remote or branch is not allowlisted." >&2
  exit 1
fi

install -o root -g root -m 0755 \
  "${source_directory}/ops/collected-recipes-deploy" \
  /usr/local/sbin/collected-recipes-deploy
install -o root -g root -m 0755 \
  "${source_directory}/ops/collected-recipes-backup" \
  /usr/local/sbin/collected-recipes-backup
install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0755 \
  "${source_directory}/ops/collected-recipes-run" \
  /usr/local/libexec/collected-recipes-run
for unit in \
  collected-recipes.service \
  collected-recipes-deploy.service \
  collected-recipes-deploy.path \
  collected-recipes-backup.service \
  collected-recipes-backup.timer; do
  install -o root -g root -m 0644 \
    "${source_directory}/ops/${unit}" \
    "/etc/systemd/system/${unit}"
done
for unit in agent-outpost-deploy.service agent-outpost-deploy.path; do
  install -o root -g root -m 0644 \
    "${source_directory}/ops/${unit}" \
    "/etc/systemd/system/${unit}"
done

if [[ ! -f /etc/collected-recipes/collected-recipes.env ]]; then
  cat > /etc/collected-recipes/collected-recipes.env <<'EOF'
COPILOT_GITHUB_TOKEN=
FDC_API_KEY=
RECIPE_PUBLIC_BASE_URL=
RECIPE_REQUIRE_TAILSCALE_IDENTITY=true
EOF
  chmod 0600 /etc/collected-recipes/collected-recipes.env
fi
if [[ ! -f /etc/collected-recipes/backup.env ]]; then
  cat > /etc/collected-recipes/backup.env <<'EOF'
AZURE_BLOB_CONTAINER_URL=
EOF
  chmod 0600 /etc/collected-recipes/backup.env
fi

if [[ ! -f /etc/agent-outpost/projects.json ]]; then
  install -o root -g root -m 0644 \
    "${source_directory}/ops/projects.json.example" \
    /etc/agent-outpost/projects.json
fi
jq -e \
  '.version == 1 and .defaultProjectId == "agent-outpost" and
   any(.projects[]; .id == "collected-recipes")' \
  /etc/agent-outpost/projects.json >/dev/null
if grep -q '^OUTPOST_PROJECT_REGISTRY=' /etc/agent-outpost/agent-outpost.env; then
  sed -i \
    's|^OUTPOST_PROJECT_REGISTRY=.*|OUTPOST_PROJECT_REGISTRY=/etc/agent-outpost/projects.json|' \
    /etc/agent-outpost/agent-outpost.env
else
  printf '%s\n' \
    'OUTPOST_PROJECT_REGISTRY=/etc/agent-outpost/projects.json' \
    >> /etc/agent-outpost/agent-outpost.env
fi

runuser -u collected-recipes-build -- env \
  HOME=/var/lib/collected-recipes/build-home \
  XDG_RUNTIME_DIR=/run/collected-recipes-build \
  podman --cgroup-manager=cgroupfs info >/dev/null
runuser -u collected-recipes-runtime -- env \
  HOME=/var/lib/collected-recipes/runtime \
  XDG_RUNTIME_DIR=/run/collected-recipes \
  podman --cgroup-manager=cgroupfs info >/dev/null

systemctl daemon-reload
systemctl enable --now agent-outpost-deploy.path
systemctl enable --now collected-recipes-deploy.path
if grep -Eq '^AZURE_BLOB_CONTAINER_URL=https://[a-z0-9-]+\.blob\.core\.windows\.net/[a-z0-9-]+$' \
  /etc/collected-recipes/backup.env; then
  systemctl enable --now collected-recipes-backup.timer
else
  echo "Backup timer is installed but not enabled until its Blob container URL is configured." >&2
fi

read -r active_slot _ < /var/lib/agent-outpost/deployment/active
case "${active_slot}" in
  a) active_port=3001 ;;
  b) active_port=3002 ;;
  *) echo "Agent Outpost active slot is invalid." >&2; exit 1 ;;
esac
if [[ ! -f "/opt/agent-outpost/slots/${active_slot}/current/dist/src/project-registry.js" ]]; then
  echo "Deploy the project-aware Agent Outpost release before enabling the registry." >&2
  exit 1
fi
systemctl restart "agent-outpost@${active_slot}.service"
for _ in {1..90}; do
  if curl --fail --silent "http://127.0.0.1:${active_port}/ready" >/dev/null; then
    echo "Collected Recipes operator plumbing is installed."
    echo "Fill the two root-owned environment files, provision Blob RBAC and Tailscale Service access, then request the first deployment."
    exit 0
  fi
  sleep 1
done

echo "Agent Outpost did not become ready after project registry activation." >&2
exit 1
