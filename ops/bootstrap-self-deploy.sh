#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

readonly source_directory=/srv/agent-outpost/workspace
current_release=$(readlink -f /opt/agent-outpost/current)
if [[ -z "${current_release}" || ! -d "${current_release}" ]]; then
  echo "A healthy legacy release is required before slot migration." >&2
  exit 1
fi
current_commit=$(cat "${current_release}/.agent-outpost-commit")
if [[ ! "${current_commit}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "The current release does not contain a valid commit marker." >&2
  exit 1
fi

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y nginx

install -d -o root -g root -m 0755 \
  /opt/agent-outpost/slots/a \
  /opt/agent-outpost/slots/b \
  /var/lib/agent-outpost/deployment
install -d -o agent-outpost -g agent-outpost -m 0700 \
  /var/lib/agent-outpost/deploy-requests \
  /var/lib/agent-outpost/builds

install -o root -g root -m 0755 \
  "${source_directory}/ops/agent-outpost-deploy" \
  /usr/local/sbin/agent-outpost-deploy
install -o root -g root -m 0755 \
  "${source_directory}/ops/agent-outpost-start-active" \
  /usr/local/sbin/agent-outpost-start-active
install -o root -g root -m 0644 \
  "${source_directory}/ops/agent-outpost@.service" \
  /etc/systemd/system/agent-outpost@.service
install -o root -g root -m 0644 \
  "${source_directory}/ops/agent-outpost-deploy.service" \
  /etc/systemd/system/agent-outpost-deploy.service
install -o root -g root -m 0644 \
  "${source_directory}/ops/agent-outpost-deploy.path" \
  /etc/systemd/system/agent-outpost-deploy.path
install -o root -g root -m 0644 \
  "${source_directory}/ops/agent-outpost-active.service" \
  /etc/systemd/system/agent-outpost-active.service
install -d -o root -g root -m 0755 /etc/systemd/system/nginx.service.d
cat > /etc/systemd/system/nginx.service.d/agent-outpost.conf <<'EOF'
[Unit]
Requires=agent-outpost-active.service
After=agent-outpost-active.service
EOF

if grep -q '^OUTPOST_DEPLOY_REQUEST_DIR=' /etc/agent-outpost/agent-outpost.env; then
  sed -i \
    's|^OUTPOST_DEPLOY_REQUEST_DIR=.*|OUTPOST_DEPLOY_REQUEST_DIR=/var/lib/agent-outpost/deploy-requests|' \
    /etc/agent-outpost/agent-outpost.env
else
  printf '%s\n' \
    'OUTPOST_DEPLOY_REQUEST_DIR=/var/lib/agent-outpost/deploy-requests' \
    >> /etc/agent-outpost/agent-outpost.env
fi
if grep -q '^OUTPOST_GITHUB_REPOSITORY=' /etc/agent-outpost/agent-outpost.env; then
  sed -i \
    's|^OUTPOST_GITHUB_REPOSITORY=.*|OUTPOST_GITHUB_REPOSITORY=amunger/agent-outpost|' \
    /etc/agent-outpost/agent-outpost.env
else
  printf '%s\n' 'OUTPOST_GITHUB_REPOSITORY=amunger/agent-outpost' \
    >> /etc/agent-outpost/agent-outpost.env
fi

cat > /etc/agent-outpost/slot-a.env <<'EOF'
OUTPOST_PORT=3001
OUTPOST_PUBLIC_DIR=/opt/agent-outpost/slots/a/current/public
EOF
cat > /etc/agent-outpost/slot-b.env <<'EOF'
OUTPOST_PORT=3002
OUTPOST_PUBLIC_DIR=/opt/agent-outpost/slots/b/current/public
EOF
chmod 0600 /etc/agent-outpost/slot-a.env /etc/agent-outpost/slot-b.env

ln -sfn "${current_release}" /opt/agent-outpost/slots/a/current
printf 'a %s\n' "${current_commit}" > /var/lib/agent-outpost/deployment/active

rm -f /etc/nginx/sites-enabled/default
install -o root -g root -m 0644 \
  "${source_directory}/ops/agent-outpost-nginx.conf" \
  /etc/nginx/sites-enabled/agent-outpost

systemctl daemon-reload
systemctl stop agent-outpost.service
systemctl disable agent-outpost.service
systemctl start agent-outpost@a.service

for _ in {1..90}; do
  if curl --fail --silent http://127.0.0.1:3001/ready >/dev/null; then
    break
  fi
  sleep 1
done
curl --fail --silent http://127.0.0.1:3001/ready >/dev/null

nginx -t
systemctl enable nginx
systemctl restart nginx
systemctl enable --now agent-outpost-deploy.path
systemctl enable agent-outpost-active.service

echo "Agent Outpost slot A and deployment watcher are active."
