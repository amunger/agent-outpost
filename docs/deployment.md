# Live deployment

This document records the real single-user deployment. It is operational
inventory, not a reusable secret file.

## Endpoint rules

The live operator endpoint is:

**https://agent-outpost.tail895de1.ts.net**

Use that URL from a phone, browser, or command running on a device connected to
the owner's Tailscale network.

Do not confuse these endpoints:

| Endpoint | Meaning |
|---|---|
| `https://agent-outpost.tail895de1.ts.net` | The real private operator service |
| `127.0.0.1:3000` on the Azure VM | nginx for the real service |
| `127.0.0.1:3001` or `:3002` on the VM | Internal application slots |
| `127.0.0.1:<ephemeral>` on the VM | Temporary workspace screenshot preview |
| `127.0.0.1:<port>` on a maintainer laptop | A local process on that laptop; never the VM |

The source repository intentionally uses an example value for
`OUTPOST_PUBLIC_BASE_URL`. Production must set it to the real Tailscale origin:

```text
OUTPOST_PUBLIC_BASE_URL=https://agent-outpost.tail895de1.ts.net
```

This value is required for absolute screenshot fallback links. Relative
artifact URLs still work inside the current page, but are not sufficient when
copied elsewhere.

Verify the live setting without printing unrelated configuration:

```bash
grep '^OUTPOST_PUBLIC_BASE_URL=' /etc/agent-outpost/agent-outpost.env
```

If it is absent, add the exact value above and restart the active slot. Do not
commit the deployment-specific hostname by replacing the reusable placeholder
in `.env.example`.

## Azure inventory

| Item | Value |
|---|---|
| Region | West US 2 |
| Resource group | `rg-agent-outpost-westus2` |
| VM | `vm-agent-outpost` |
| VM size | `Standard_B2s` |
| OS | Ubuntu 24.04 LTS |
| OS disk | 64 GB Standard SSD LRS |
| Public IP | None after bootstrap |
| Inbound NSG rules | None after bootstrap |
| Administration | Tailscale SSH or Azure Run Command |
| Budget | USD 50/month alert budget |

The Azure subscription ID is deliberately not committed. Select the intended
subscription explicitly before using `az`.

## Tailscale inventory

| Item | Value |
|---|---|
| MagicDNS name | `agent-outpost.tail895de1.ts.net` |
| Tailnet IPv4 | `100.107.222.31` |
| Serve target | `http://127.0.0.1:3000` |
| Scope | Tailnet only |

## Ports

| Port | Process |
|---|---|
| 443 on Tailscale hostname | Tailscale Serve |
| `127.0.0.1:3000` | nginx stable upstream |
| `127.0.0.1:3001` | slot A |
| `127.0.0.1:3002` | slot B |

No application or Copilot JSON-RPC port should listen on a public interface.

## Filesystem inventory

| Path | Purpose | Owner |
|---|---|---|
| `/srv/agent-outpost/workspace` | `agent/current` working tree | `agent-outpost` |
| `/var/lib/agent-outpost/outpost.db` | persistent application events | `agent-outpost` |
| `/var/lib/agent-outpost/copilot` | Copilot configuration and session state | `agent-outpost` |
| `/var/lib/agent-outpost/artifacts` | private screenshots | `agent-outpost` |
| `/var/lib/agent-outpost/playwright` | browser binaries | `agent-outpost` |
| `/var/lib/agent-outpost/deploy-requests` | typed deployment request spool | `agent-outpost` |
| `/var/lib/agent-outpost/deployment/active` | authoritative slot and commit | root |
| `/opt/agent-outpost/releases` | immutable releases | root |
| `/opt/agent-outpost/slots/a` | slot A release link | root |
| `/opt/agent-outpost/slots/b` | slot B release link | root |
| `/etc/agent-outpost` | production environment and slot settings | root |

## Services

- `agent-outpost-active.service`
- `agent-outpost@a.service`
- `agent-outpost@b.service`
- `agent-outpost-deploy.path`
- `agent-outpost-deploy.service`
- `nginx.service`
- `tailscaled.service`

Only the active slot is expected to run. The inactive slot can appear stopped or
failed after a deliberate rollback test; the authoritative question is whether
the slot named in `/var/lib/agent-outpost/deployment/active` is healthy.

## Configuration keys

Production uses `/etc/agent-outpost/agent-outpost.env`. Expected keys:

- `OUTPOST_HOST`
- `OUTPOST_PORT`
- `OUTPOST_WORKSPACE`
- `OUTPOST_DATA_DIR`
- `OUTPOST_PUBLIC_DIR`
- `OUTPOST_SESSION_ID`
- `OUTPOST_MODEL`
- `OUTPOST_ALLOWED_TAILSCALE_USER`
- `OUTPOST_ALLOWED_GIT_REMOTE`
- `OUTPOST_GITHUB_REPOSITORY`
- `OUTPOST_DEPLOY_REQUEST_DIR`
- `OUTPOST_ARTIFACT_DIR`
- `OUTPOST_PUBLIC_BASE_URL`
- `COPILOT_HOME`
- `PLAYWRIGHT_BROWSERS_PATH`

Do not print values from this file indiscriminately in logs or issues.

## Branch and revision authority

There are three different revisions to inspect:

1. `origin/main` — maintained baseline.
2. `origin/agent/current` — operator's latest published work.
3. Active deployment — value stored on the VM.

Check repository branches:

```powershell
git fetch --all --prune
git log --oneline --decorate --graph --all -20
git rev-list --left-right --count origin/main...origin/agent/current
```

Check the live deployment from the VM:

```bash
cat /var/lib/agent-outpost/deployment/active
curl --fail --silent http://127.0.0.1:3000/ready
```

The active file has:

```text
<slot> <full-commit-sha>
```

Do not infer the active revision from the latest Git commit or from which slot
directory was modified most recently.

## Sending a message to the real operator

The normal path is the mobile UI. A tailnet-connected maintainer can also use
the live HTTPS API:

```powershell
$baseUrl = 'https://agent-outpost.tail895de1.ts.net'
$body = @{ content = 'Deploy the validated agent/current revision.' } |
  ConvertTo-Json -Compress

Invoke-RestMethod `
  -Uri "$baseUrl/api/session/messages" `
  -Method Post `
  -ContentType 'application/json' `
  -Headers @{ Origin = $baseUrl } `
  -Body $body
```

Tailscale supplies the authenticated login header. If the hostname does not
resolve or the request is unauthorized, stop and verify that the current
machine is connected to the correct tailnet. Do not replace the URL with local
`127.0.0.1`.

Azure Run Command can reach VM loopback as a break-glass maintenance path. It
is not the ordinary operator endpoint and should not be embedded in application
behavior.
