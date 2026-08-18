# Collected Recipes private service

This runbook provisions `amunger/collected-recipes` as the first additional
registered Agent Outpost project. It is a reviewed privileged installation
procedure, not a command the deployed agent runs.

The service is not live merely because these files exist. Verify the active VM
inventory and complete every provisioning and acceptance step below.

## Resulting topology

```text
recipe-users Tailscale group
  -> https://<collected-recipes-service>.<tailnet>.ts.net
  -> Tailscale Service svc:collected-recipes
  -> 127.0.0.1:3100
  -> rootless Podman container as collected-recipes-runtime
  -> /var/lib/collected-recipes/data/recipes.db
```

Agent Outpost remains on its existing Tailscale hostname, nginx entry point,
blue-green slots, workspace, runtime identity, and deployment controller.
Routine recipe deployments do not reload nginx or change Tailscale policy.

## Hard prerequisites

- Keep at least 2 CPUs, 3.5 GB total RAM, 2 GB currently available RAM, and
  20 GB free disk. Measurements on the current `Standard_B2s` showed about
  2.76 GB available at idle, with the active Agent Outpost cgroup using about
  504 MB, so a resize is not required by the bootstrap gate.
- Deploy the project-aware Agent Outpost release before enabling its registry.
- Create `agent/current` in `amunger/collected-recipes`. For the initial seed,
  an external maintainer can push the reviewed `master` tip to that branch.
- Create a dedicated Copilot token for the recipe runtime and a production Food
  Data Central key. Do not reuse Agent Outpost Copilot or GitHub CLI state.
- Enable a system-assigned managed identity on the VM. Create a private Blob
  container and grant that identity only the Blob data role required to upload
  backups.
- Confirm the Tailscale client is at least 1.86 and the VM uses a tag-based
  identity. Changing node identity can affect the existing endpoint, so verify
  the Agent Outpost grant before and after the change.

## Install the fixed controller

From the VM, after reviewing the active Agent Outpost workspace:

```bash
sudo bash /srv/agent-outpost/workspace/ops/bootstrap-collected-recipes.sh
```

The script refuses insufficient headroom or a missing recipe integration
branch. It installs rootless Podman, separate build and runtime identities,
fixed systemd units, a project registry, and dedicated filesystem boundaries.
It does not create secrets, Azure RBAC, Tailscale grants, or a first deployment.

Fill the root-owned files without printing them:

```text
/etc/collected-recipes/collected-recipes.env
  COPILOT_GITHUB_TOKEN
  FDC_API_KEY
  RECIPE_PUBLIC_BASE_URL
  RECIPE_REQUIRE_TAILSCALE_IDENTITY=true

/etc/collected-recipes/backup.env
  AZURE_BLOB_CONTAINER_URL=https://<account>.blob.core.windows.net/<container>
```

Both files must remain root-owned mode `0600`. The Blob URL contains no SAS,
account key, or query string. Rerun the bootstrap after setting the Blob URL to
enable the backup timer.

## Configure the Tailscale Service

In the Tailscale admin console:

1. define `svc:collected-recipes` with endpoint `tcp:443`;
2. create or confirm a dedicated `group:recipe-users`;
3. grant only that group access to the service on port 443; and
4. approve this tagged VM as the service host.

The grant has this shape:

```json
{
  "src": ["group:recipe-users"],
  "dst": ["svc:collected-recipes"],
  "ip": ["443"]
}
```

On the VM, configure the service endpoint once:

```bash
sudo tailscale serve \
  --service=svc:collected-recipes \
  --https=443 \
  127.0.0.1:3100
sudo tailscale serve status --json
```

Set `RECIPE_PUBLIC_BASE_URL` to the exact HTTPS MagicDNS origin printed by
Tailscale. Do not add a public IP, Azure inbound rule, wildcard listener, or
Agent Outpost nginx location.

## Normal phone workflow

After installation:

1. create or open a **Collected Recipes** chat;
2. ask for the application change;
3. let the agent run the repository's tests, lint, and build;
4. review the project-labeled deployment candidate;
5. approve the candidate; and
6. verify the change through the recipe Tailscale hostname.

Internally, publishing is restricted to the registered recipe workspace,
remote, and `agent/current`. Approval writes only an exact SHA to
`/var/lib/collected-recipes/deploy-requests`.

The root controller independently verifies the remote tip, exports a
symlink-free source tree, and creates an OCI image as the credential-free
`collected-recipes-build` user with rootless Podman. The image build performs
one clean dependency installation followed by tests, lint, the production
build, and production dependency pruning; the controller does not repeat those
memory-intensive steps on the host. The candidate is health-checked without
production secrets or data.
Build and runtime cgroups deny Azure IMDS and tailnet egress, and the build
cgroup also denies host loopback so repository-controlled validation cannot
call either live local service with forged proxy headers.
Rootless Podman maps the runtime account to the image's non-root `node` UID so
the container can write only its dedicated SQLite mount and bounded tmpfs.

The controller waits for Agent Outpost to become idle and requires 2 GB of
currently available host memory before starting dependency installation.
Measured two-CPU Linux peaks were approximately 1.48 GB for `npm ci`, 678 MB
for the Webpack production build, 503 MB for lint, and 332 MB for tests. The
constrained production container used about 58 MiB after health, UI, and recipe
list requests. The complete image build also passed tests, lint, build, and
pruning with its build container capped at 1.7 GB and two CPUs. The rootless
image-build cgroup has a 1.6 GB soft limit and 1.9 GB hard limit to accommodate
dependency installation plus Podman overhead. These are sizing evidence and
safety ceilings, not permanent reservations.

Cutover intentionally uses a brief restart rather than permanent blue-green
slots. The controller records the immutable image ID, restarts the stable
loopback service, and restores the previous exact image if health fails.

## Operations

Status and logs:

```bash
systemctl status \
  collected-recipes.service \
  collected-recipes-deploy.path \
  collected-recipes-backup.timer \
  --no-pager
journalctl -u collected-recipes-deploy.service --no-pager -n 200
journalctl -u collected-recipes.service --no-pager -n 200
journalctl -u collected-recipes-backup.service --no-pager -n 100
curl --fail --silent http://127.0.0.1:3100/api/health
```

The stable application port must appear only on loopback:

```bash
ss -ltnp | grep ':3100'
```

Restart the current immutable image:

```bash
sudo systemctl restart collected-recipes.service
curl --fail --silent http://127.0.0.1:3100/api/health
```

Do not run Podman as `agent-outpost`, add that account to a container group, or
mount either user's container storage into Agent Outpost.

## Backup and restore

The daily timer uses SQLite's online backup operation, runs `PRAGMA
quick_check`, obtains an Azure Storage token from the VM managed identity, and
uploads the database to the private container. Blob lifecycle policy owns
off-VM retention; the VM keeps only seven days of local staging copies.

Test restore without touching production:

1. download one Blob to a root-only temporary path;
2. run `sqlite3 <download> 'PRAGMA quick_check;'`;
3. start a disposable recipe container with that file mounted as `/data`;
4. verify a known saved recipe; and
5. remove the disposable container and file.

For a production restore, stop `collected-recipes.service`, retain the current
database as a rollback copy, install the verified backup at
`/var/lib/collected-recipes/data/recipes.db` owned by
`collected-recipes-runtime`, then start and health-check the service. Never
overwrite a live SQLite database.

## Access revocation and privileged changes

Remove users from `group:recipe-users` to revoke service access. Removing or
changing the project registry, controller, systemd units, runtime limits,
managed-identity role, Blob lifecycle, or Tailscale policy remains external
privileged maintenance. Application code changes and routine deployments use
Agent Outpost; infrastructure authority does not.

## Acceptance

Complete all of these before calling the service operational:

- an authorized group member can use private HTTPS and an unauthorized tailnet
  member cannot connect;
- the VM has no public/LAN recipe listener;
- URL extraction, image extraction, transformation, save/reopen, and production
  nutrition lookup work;
- concurrent Copilot work receives a clear `429` without affecting Agent
  Outpost;
- a deployment waits while an Agent Outpost turn is active and refuses to
  start below the available-memory floor;
- data survives container recreation and VM reboot;
- an off-VM backup restores a known recipe;
- a deliberately failed recipe candidate and cutover preserve the previous
  image;
- recipe load and deployment do not make Agent Outpost unhealthy; and
- the phone can edit, publish, approve, and deploy each project without a
  candidate or diff resolving through the other project's workspace.
