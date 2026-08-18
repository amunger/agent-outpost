# Security model

## Design principle

Conversation can steer development, but it is not general authorization to
operate the VM. Agent Outpost exposes narrow typed capabilities and keeps root
operations behind a separate controller.

## Authentication

- Tailscale authenticates the phone/browser and supplies the user identity.
- Production permits one configured Tailscale login.
- API mutations require a matching same-origin `Origin` header.
- GitHub CLI OAuth belongs to the unprivileged `agent-outpost` account.
- Copilot can use the supported GitHub CLI OAuth fallback.
- No GitHub, Copilot, Azure, Tailscale, or SSH private credential belongs in
  this repository.

The headless VM may store GitHub CLI OAuth in a private `0600` file because it
has no desktop keyring. Do not print or copy that file.

## Process identities

### `agent-outpost`

Owns:

- Workspace
- SQLite events
- Copilot state
- Screenshots and browser binaries
- Deployment request spool

Runs:

- Node application
- Copilot runtime
- Tests and builds
- Git operations allowed by typed tools

Does not have:

- General sudo
- Arbitrary systemd control
- nginx configuration ownership
- Root-owned release modification

### root

Owns:

- systemd units
- nginx configuration
- immutable release directories
- active deployment state
- deployment controller

The root controller accepts only a bounded SHA request file and independently
validates the Git remote and remote branch tip.

## Sandbox and permission policy

Copilot shell commands run under the local sandbox where supported. Sandbox
bypass is rejected. The SDK permission handler allows only constrained,
argument-aware operations.

Transitions that need stronger guarantees are typed tools rather than shell
commands:

- Commit/push
- Deployment
- Issue creation
- Workspace edits when `apply_patch` is unavailable
- Screenshot capture

## Workspace editing

Typed edit tools:

- Reject paths outside the workspace.
- Reject `.git` at any path depth and case.
- Reject symbolic links.
- Anchor Linux parent access through an opened directory descriptor.
- Require regular UTF-8 files under the size limit.
- Require one exact replacement occurrence.
- Use exclusive creation or atomic replacement.

These controls reduce path and prompt-injection risk. The VM account still has
the underlying workspace permissions, so changes to this boundary require
careful review.

## Git publishing

The publisher:

- Requires `agent/current`.
- Requires the exact configured push remote.
- Rejects dangerous local Git configuration.
- Disables hooks, fsmonitor, external diff, and interactive editors.
- Handles bounded remote reconciliation without force-push.
- Adds the required Copilot coauthor trailer.
- Returns the final full SHA for deployment.

Raw shell commit and push commands are intentionally not the supported operator
workflow.

## Deployment

The controller:

- Verifies request type, ownership, size, and SHA.
- Requires the SHA to equal the current `origin/agent/current`.
- Builds as the unprivileged account.
- Creates a complete immutable release before activation.
- Waits for the current turn to drain.
- Checks candidate readiness.
- Maintains one atomic active slot/commit record.
- Reconciles nginx and slot state after restart.
- Rolls back automatically.

## Screenshot artifacts

- Browser capture targets only deployed VM loopback or an isolated read-only
  workspace preview.
- Artifact names are generated and validated.
- Artifact file opens use no-follow semantics.
- API access requires the configured Tailscale identity.
- Artifacts expire after seven days and capture cleanup keeps a bounded set.
- The UI uses DOM text nodes and fixed image elements rather than injecting
  model-supplied HTML.

## Network exposure

- No Azure public IP after bootstrap.
- No inbound NSG rule after bootstrap.
- Application and slot ports bind to loopback.
- Tailscale Serve is the only user-facing ingress.
- Administration is Tailscale SSH or Azure Run Command.

## Residual risks

- A compromised VM can access all data available to the `agent-outpost` user.
- Copilot sandbox behavior is experimental.
- Tailscale and GitHub organization policies can change.
- The single VM is one availability and trust domain.
- Conversation and screenshots can contain sensitive project information.
- The current installation has no automated backup beyond Git for source.

Do not weaken the existing controls to make an agent action more convenient.
Add a narrow typed tool or explicit reviewed maintenance path instead.

## Registered projects

A root-owned registry may define additional trusted development projects. Chat
identity resolves to exactly one registered workspace, remote, branch,
validation profile, issue repository, and deployment request spool. The mobile
API does not turn every repository visible to GitHub CLI into a trusted
project, and turns that share one checkout are serialized.

Each deployment target keeps its own privileged adapter. Collected Recipes uses
a credential-free rootless build identity and a separate secret-bearing
rootless runtime identity; Agent Outpost receives neither a Podman socket nor
recipe runtime credentials. This is logical isolation among reviewed
development repositories plus process/filesystem isolation for the deployed
service, not a claim that hostile repository code is safe to approve and run.
