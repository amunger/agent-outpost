#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

install -d -m 0755 /etc/apt/keyrings
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates \
  bubblewrap \
  curl \
  git \
  gnupg \
  jq \
  rsync \
  tmux

curl --proto '=https' --tlsv1.2 -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
  > /etc/apt/sources.list.d/nodesource.list

curl --proto '=https' --tlsv1.2 -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg \
  > /etc/apt/keyrings/tailscale-archive-keyring.gpg
echo "deb [signed-by=/etc/apt/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/ubuntu noble main" \
  > /etc/apt/sources.list.d/tailscale.list

curl --proto '=https' --tlsv1.2 -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  > /etc/apt/keyrings/githubcli-archive-keyring.gpg
chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  > /etc/apt/sources.list.d/github-cli.list

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y gh nodejs tailscale
npm install --global @github/copilot

if ! id agent-outpost >/dev/null 2>&1; then
  useradd \
    --create-home \
    --home-dir /var/lib/agent-outpost \
    --shell /bin/bash \
    agent-outpost
fi

install -d -o agent-outpost -g agent-outpost -m 0700 \
  /var/lib/agent-outpost \
  /var/lib/agent-outpost/copilot \
  /srv/agent-outpost/workspace
install -d -o root -g root -m 0755 /etc/agent-outpost /opt/agent-outpost/releases

install -o root -g root -m 0644 \
  "$(dirname "$0")/agent-outpost.service" \
  /etc/systemd/system/agent-outpost.service

if [[ ! -f /etc/agent-outpost/agent-outpost.env ]]; then
  cat > /etc/agent-outpost/agent-outpost.env <<'EOF'
OUTPOST_HOST=127.0.0.1
OUTPOST_PORT=3000
OUTPOST_WORKSPACE=/srv/agent-outpost/workspace
OUTPOST_DATA_DIR=/var/lib/agent-outpost/data
OUTPOST_PUBLIC_DIR=/opt/agent-outpost/current/public
OUTPOST_SESSION_ID=agent-outpost-main
OUTPOST_MODEL=auto
OUTPOST_ALLOWED_TAILSCALE_USER=
OUTPOST_ALLOWED_GIT_REMOTE=https://github.com/amunger/agent-outpost.git
COPILOT_HOME=/var/lib/agent-outpost/copilot
EOF
  chmod 0600 /etc/agent-outpost/agent-outpost.env
fi

systemctl daemon-reload
systemctl enable tailscaled.service

echo
echo "Base packages and service accounts are installed."
echo "Next: enroll Tailscale, authenticate GitHub and Copilot, then install a release."
