# Bootstrap runbook

This runbook establishes the first Agent Outpost VM. Account authentication is
interactive by design; do not copy credentials into configuration files.

## 1. Validate Azure access

Authenticate the Azure CLI to the tenant containing the intended subscription:

```powershell
az login --use-device-code
az account show --subscription '<subscription-id>'
```

The current login must list the intended subscription before provisioning.

## 2. Review the Azure what-if

Determine the public IPv4 CIDR from which initial SSH will be used. Pass one
address as `/32`; do not open SSH to the entire internet.

```powershell
.\infra\deploy.ps1 `
  -SubscriptionId '<subscription-id>' `
  -BudgetContactEmail '<alert-email>' `
  -AdminUsername '<linux-admin>' `
  -AdminSourceCidr '203.0.113.10/32'
```

This runs `az deployment sub what-if`. Review the subscription, tenant,
resource group, VM size, disk, network rule, and budget before applying:

```powershell
.\infra\deploy.ps1 `
  -SubscriptionId '<subscription-id>' `
  -BudgetContactEmail '<alert-email>' `
  -AdminUsername '<linux-admin>' `
  -AdminSourceCidr '203.0.113.10/32' `
  -Apply
```

## 3. Install VM prerequisites

Copy the public repository to the VM, then run:

```bash
sudo ./ops/bootstrap-vm.sh
```

## 4. Enroll private access

Create a Tailscale account, install Tailscale on the phone, and enroll the VM:

```bash
sudo tailscale up --ssh
sudo tailscale serve --bg --https=443 http://127.0.0.1:3000
tailscale status
```

Set `OUTPOST_ALLOWED_TAILSCALE_USER` in
`/etc/agent-outpost/agent-outpost.env` to the exact Tailscale login allowed to
use the API. Confirm `OUTPOST_ALLOWED_GIT_REMOTE` contains the exact HTTPS
push URL returned by:

```bash
sudo -iu agent-outpost git -C /srv/agent-outpost/workspace remote get-url --push origin
```

Verify Tailscale SSH from a second terminal before removing the public IP.

## 5. Authenticate the service account

```bash
sudo -iu agent-outpost
gh auth login
copilot login --device-code
```

Use browser device flows. Do not paste tokens into shell commands.

Start an interactive Copilot session and open `/sandbox`. Confirm:

- The local sandbox is enabled.
- Sandbox bypass is disabled.
- The working directory is included.
- Developer-tool access is disabled.
- Git authentication is enabled.
- GitHub CLI authentication inside the sandbox is disabled.

The production bootstrap installs Bubblewrap, the Linux backend required by
Copilot's local sandbox. Agent Outpost also opts its SDK session into
experimental runtime features so the saved sandbox policy is applied.

Local sandboxing is currently a GitHub public-preview feature. The application
also enforces a deny-by-default SDK permission handler, rejects every sandbox
bypass request, and runs inside a hardened systemd service. Do not proceed if
organization policy prevents the sandbox from being enabled.

Clone the repository into the agent workspace:

```bash
gh repo clone amunger/agent-outpost /srv/agent-outpost/workspace
cd /srv/agent-outpost/workspace
git switch -c agent/current
git push --set-upstream origin agent/current
```

## 6. Establish the recovery session

Until the custom mobile interface is proven, keep an official Copilot remote
session available:

```bash
tmux new-session -s copilot-recovery
cd /srv/agent-outpost/workspace
copilot --remote
```

Detach with `Ctrl+B`, then `D`. Verify the session is visible from GitHub
Mobile before proceeding.

## 7. Install the custom service

From the administrator account:

```bash
sudo /srv/agent-outpost/workspace/ops/install-release.sh /srv/agent-outpost/workspace
systemctl status agent-outpost.service --no-pager
```

Open the Tailscale HTTPS URL on the phone. Confirm conversation, cancellation,
session resume, and resource status.

## 8. Remove bootstrap public access

Only after Tailscale SSH and the mobile site both work:

```powershell
.\infra\remove-bootstrap-access.ps1 -SubscriptionId '<subscription-id>'
```

Keep the current SSH connection open until a new Tailscale SSH connection has
been confirmed.
