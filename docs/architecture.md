# Architecture

## Purpose

Agent Outpost lets one developer supervise a persistent coding agent from a
phone without turning the phone into an IDE or exposing a remote shell.
Execution, source, Git credentials, Copilot state, tests, and builds remain on
the Azure Linux VM.

## Request path

```text
Tailscale client
  -> https://agent-outpost.tail895de1.ts.net
  -> Tailscale Serve
  -> 127.0.0.1:3000
  -> nginx
  -> active application slot (:3001 or :3002)
  -> HTTP API / SSE / static mobile UI
  -> persistent Copilot SDK sessions
```

Tailscale Serve provides HTTPS and the authenticated login header. nginx is the
stable loopback entry point. The application process for the active slot owns
the chat API and Copilot SDK connection.

## Core components

### Mobile web application

`public/` contains a mobile-first chat interface. It:

- Loads persistent conversation history.
- Receives live events over server-sent events.
- Sends messages and cancellation requests.
- Displays resource status.
- Renders structured screenshot artifacts inline with a full-image link.
- Supports a chat list and dedicated chat view.

### HTTP service

`src/http-server.ts` exposes:

- `GET /health` — process liveness.
- `GET /ready` — Copilot session readiness and current state.
- `GET /api/chats` — available chat summary.
- `GET /api/session` — current state and persistent events.
- `GET /api/session/events` — SSE event stream.
- `POST /api/session/messages` — submit one user turn.
- `POST /api/session/cancel` — cancel active work.
- `GET /api/status/resources` — CPU, memory, disk, and load.
- `GET /api/artifacts/:name` — authenticated screenshot artifacts.

Production API routes require the configured Tailscale user. Mutations also
require a same-origin `Origin` header.

### Persistent Copilot sessions

`src/agent.ts` creates or resumes one stable SDK session per chat. Each chat has
its own conversation context, active turn, cancellation, state, and event
stream, so work can continue independently while a phone is viewing another
chat or is backgrounded. The SDK launches the Copilot runtime locally and
stores session state under `COPILOT_HOME`.

The model setting defaults to `auto`. A previous observed routed model was
`gpt-5.6-luna`, but routing can change per turn and must not be treated as
configuration unless the model is explicitly pinned.

### Typed operator tools

The deployed operator uses narrow typed tools instead of arbitrary privileged
shell operations:

- `replace_workspace_text`
- `create_workspace_file`
- `publish_agent_outpost_changes`
- `deploy_agent_outpost`
- `deploy_latest_agent_outpost`
- `create_agent_outpost_issue`
- `capture_agent_outpost_screenshot`

The operator skill maps plain-language intent to these tools. An external
maintainer should not expect them to exist.

Tool names retain their original Agent Outpost-compatible names, but their
policy is resolved from the chat's registered project. The root-owned project
registry fixes the workspace, remote, integration branch, issue repository,
validation profile, preview capability, deployment target, and request spool.
The API exposes only registered projects rather than treating every repository
visible to GitHub CLI as trusted.

`deploy_agent_outpost` carries an exact SHA between internal typed tools.
`deploy_latest_agent_outpost` is the user-intent entry point for already
published work: it fetches and fast-forwards a clean operator workspace, then
submits the resolved SHA to the same controller. Neither SHA nor CI state is a
required user input.

Chats are bound immutably to one project. Copilot working directories,
permission handlers, repository tools, and deployment candidates are created
from that project. Turns that share a project checkout are serialized to prevent
concurrent edits, while different projects can run independently.

### Conversation and artifacts

SQLite stores durable application events scoped to their chat. Copilot also
maintains each chat's SDK session history. Screenshot capture emits a
chat-scoped `assistant.artifact` event, so the image is rendered in the chat
that requested it even if the model does not paste a URL into prose.

Artifacts are private, retained for at most seven days, and capped by the
screenshot cleanup policy.

### Workspace preview

Screenshot capture supports:

- `deployed` — captures the live nginx endpoint on VM loopback.
- `workspace` — starts an ephemeral, read-only HTTP server for the unpublished
  `public/` directory.

The workspace preview is a test fixture on the VM. Its ephemeral
`127.0.0.1:<port>` URL is never a deployment target and is not reachable from an
external maintainer's machine.

## Blue-green deployment

The unprivileged application writes a bounded deployment request containing one
full commit SHA. A root-owned systemd path unit starts the controller.

The controller:

1. Reconciles nginx and services from the atomic active-state record.
2. Validates the request file type, owner, size, and SHA shape.
3. Verifies the configured Git remote.
4. Fetches `origin/agent/current`.
5. Requires the requested SHA to be the current remote tip.
6. Creates a detached worktree.
7. Runs install, typecheck, tests, and build as `agent-outpost`.
8. Creates an immutable, root-owned release.
9. Points the inactive slot at that release.
10. Waits for the active Copilot turn to become idle.
11. Starts and checks the candidate slot.
12. Updates the atomic active-state record and reloads nginx.
13. Restores the previous slot automatically if cutover fails.

That transaction describes the Agent Outpost self-deployment adapter.
Additional projects use separate fixed privileged adapters and state. Collected
Recipes uses a credential-free rootless image builder, a separate rootless
runtime identity, candidate health validation, restart-based cutover, and
exact-image rollback without changing nginx.

At boot, `agent-outpost-active.service` reads the active-state record, rebuilds
the nginx upstream, and starts the selected slot before nginx serves traffic.

## Trust and privilege boundaries

```text
Phone/browser
  | authenticated by Tailscale
  v
Node service as agent-outpost
  | typed tools and sandbox policy
  v
Workspace, GitHub OAuth, Copilot runtime

Root-owned boundary:
  systemd units
  nginx
  immutable releases
  deployment controller
```

The application has no general `sudo` path. Deployment is a typed request to a
separate root controller, not a shell command supplied by the model.

See [Security](security.md) for details.
