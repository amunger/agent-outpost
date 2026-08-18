# External maintenance

This is the start-here guide for an agent or developer working outside the
deployed Agent Outpost session.

## Role check

You are an external maintainer if `deploy_agent_outpost` and the other typed
operator tools are not available in your current session.

External maintainers:

- Use ordinary repository tools and file edits.
- Do not assume the local machine is connected to the live VM.
- Do not treat a local preview as a deployment.
- Do not weaken policy to imitate unavailable operator tools.
- Use the live Tailscale URL when intentionally contacting the operator.

Follow the [external-maintainer skill](../.github/skills/external-maintainer/SKILL.md).

## First five minutes

```powershell
Set-Location D:\src\agent-outpost
git status --short --branch
git fetch --all --prune
git log --oneline --decorate --graph --all -20
git rev-list --left-right --count origin/main...origin/agent/current
npm install
npm run typecheck
npm test
npm run build
```

Then read:

1. [README](../README.md)
2. [Live deployment](deployment.md)
3. [Architecture](architecture.md)
4. [Security](security.md)
5. Relevant source and tests

Do not start implementation from a stale `main` without checking
`origin/agent/current`. If the task concerns current UI or operator behavior,
base the work on the branch containing that behavior or reconcile the branches
first.

## Contribution workflow

For an ordinary external change:

1. Create a topic branch from the correct current base.
2. Make precise changes with ordinary edit tools.
3. Add or update tests.
4. Run typecheck, tests, and build.
5. Commit and push through normal Git.
6. Open a pull request or provide the commit to the owner/operator.

Operator-only tools do not exist in a normal clone. Do not call:

- `publish_agent_outpost_changes`
- `deploy_agent_outpost`
- `create_agent_outpost_issue`
- `capture_agent_outpost_screenshot`
- `replace_workspace_text`
- `create_workspace_file`

## Asking the operator to deploy

A Git commit is not a deployment. The deployment controller accepts only the
exact current `origin/agent/current` SHA.

Preferred sequence:

1. Publish the intended work to `origin/agent/current`.
2. Contact the real operator at
   `https://agent-outpost.tail895de1.ts.net`.
3. Ask in plain language: “Deploy the latest changes.”
4. Let the operator resolve the branch tip and the controller run its own
   validation.
5. Verify the active-state file and `/ready` after cutover.

Do not ask the phone user to copy a SHA or state that CI passed. Those are
maintainer/operator details. If CI is failing, diagnose it directly rather than
delegating that diagnosis to the user.

Never send the deployment request to:

- A local Windows development server.
- A Playwright workspace preview.
- `127.0.0.1` on an external machine.

Those are different processes and cannot deploy the Azure service.

## Operational checks

On the VM:

```bash
cat /var/lib/agent-outpost/deployment/active
systemctl is-active \
  agent-outpost-active.service \
  nginx \
  agent-outpost-deploy.path \
  tailscaled.service
systemctl list-units 'agent-outpost@*.service' --no-pager
curl --fail --silent http://127.0.0.1:3000/ready
```

Deployment logs:

```bash
journalctl -u agent-outpost-deploy.service --no-pager -n 200
journalctl -u 'agent-outpost@*.service' --no-pager -n 200
```

Tailscale:

```bash
tailscale status
tailscale serve status
```

Git workspace:

```bash
sudo -iu agent-outpost git -C /srv/agent-outpost/workspace status --short --branch
sudo -iu agent-outpost git -C /srv/agent-outpost/workspace log -1 --oneline
```

## Recovery

### Candidate deployment fails

The controller restores the previous active state and slot. Inspect:

```bash
journalctl -u agent-outpost-deploy.service --no-pager -n 250
cat /var/lib/agent-outpost/deployment/active
curl --fail --silent http://127.0.0.1:3000/ready
```

Do not manually repoint nginx before understanding the active-state record.
Boot and controller reconciliation treat that record as authoritative.

### Operator service is unavailable

Use Tailscale SSH if it is already proven. If private SSH is unavailable, use
Azure Run Command against `vm-agent-outpost` in
`rg-agent-outpost-westus2`.

From a workstation with an authenticated Azure CLI:

```powershell
$subscriptionId = az account list `
  --query "[?name=='Visual Studio Enterprise'].id | [0]" `
  --output tsv

az vm run-command invoke `
  --subscription $subscriptionId `
  --resource-group rg-agent-outpost-westus2 `
  --name vm-agent-outpost `
  --command-id RunShellScript `
  --scripts 'cat /var/lib/agent-outpost/deployment/active; curl --fail --silent http://127.0.0.1:3000/ready'
```

Confirm the selected subscription and tenant before running any mutating Azure
command. The subscription display name is a convenience, not an authorization
boundary.

Check the active service and nginx first. Avoid deleting session data,
releases, or the workspace.

### Tailscale endpoint is unavailable

Check:

```bash
systemctl status tailscaled.service --no-pager
tailscale status
tailscale serve status
curl --fail --silent http://127.0.0.1:3000/ready
```

If loopback is healthy but the hostname is not, the problem is Tailscale or the
client's tailnet connection, not the application.

### GitHub built-in remote control

The owner's Copilot Enterprise organization currently disables remote-controlled
CLI sessions. Do not rely on GitHub Mobile's built-in CLI control as a recovery
path. Use the custom UI, Tailscale SSH, or Azure Run Command.

## Updating privileged components

Files under `ops/` can affect root-owned systemd or nginx behavior. Treat
changes to these files as security-sensitive.

The deployed operator can update application releases, but installation of new
or changed root-owned controllers, units, or nginx bootstrap behavior requires
an external privileged maintenance action after review.

Never give the application general `sudo`, unrestricted `systemctl`, root
Docker access, or an arbitrary command field in deployment requests.

The Collected Recipes target uses a separate fixed request watcher and rootless
Podman identities. Its one-time privileged procedure and recovery steps are in
[Collected Recipes private service](collected-recipes-deployment.md). Routine
recipe code deployments can use the phone approval workflow after that
procedure; controller, systemd, Tailscale, Azure, and backup policy changes
still require external review.
