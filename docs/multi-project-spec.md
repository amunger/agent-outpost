# Multi-project Agent Outpost

## Summary

Extend Agent Outpost from one persistent Copilot session to a project-aware
control surface. A developer can register several repositories on one server,
switch between their sessions from the mobile UI, and deploy a selected
project without exposing another project's workspace or conversation data.

The existing single-project configuration remains the default migration path.

## Goals

- Support multiple registered projects on one server.
- Give each project an isolated workspace, session, event history, and runtime.
- Allow one mobile client to switch projects without mixing conversations.
- Preserve Tailscale authentication and workspace permission boundaries.
- Deploy and roll back a selected project independently.
- Make resource usage and project health visible.
- Keep the first implementation suitable for one developer and one server.

## Non-goals

- Multi-user collaboration or shared project permissions.
- Arbitrary remote shell access.
- Running untrusted repositories without explicit local configuration.
- Cross-project agent context or automatic file sharing.
- Distributed scheduling across multiple servers.

## Terminology

- **Project**: A registered repository and its Agent Outpost configuration.
- **Chat**: One conversation and Copilot session within a project.
- **Session**: The persistent Copilot SDK runtime associated with one chat.
- **Workspace**: The isolated checkout or worktree assigned to one writable chat.
- **Instance**: The server-side process or worker hosting a session.
- **Active project**: The project currently selected in the client.

A project can own several chats. Project identity controls repository and
deployment policy; chat identity controls conversation history and runtime
state. These identities must not be conflated.

## Project model

Persist project definitions in a server-owned registry, separate from
conversation event data:

```text
Project
  id: stable slug
  name: display name
  workspace: absolute path
  dataDirectory: absolute path
  allowedGitRemote: expected remote
  integrationBranch: branch eligible for deployment
  deploymentTargets: allowlisted target identifiers
  model: Copilot model selection
  enabled: boolean
  createdAt
  updatedAt
```

The registry must reject duplicate IDs, non-absolute paths, paths outside the
configured projects root unless explicitly allowed, and duplicate workspace
paths. Project IDs must be normalized before use in URLs or filesystem paths.

Per-project runtime state should include:

```text
projects/<id>/repository.git
projects/<id>/worktrees/<chat-id>/
projects/<id>/chats/<chat-id>/outpost.db
projects/<id>/chats/<chat-id>/runtime/
projects/<id>/deploy-requests/
```

Each writable chat receives its own worktree and branch. Multiple chats must
never edit the same checkout. The first implementation may permit only one
writable chat per project while additional chats are read-only; later phases
can add explicit integration and conflict handling.

Secrets and Tailscale policy remain server-level configuration and must not be
stored in the project registry.

## Runtime architecture

Introduce a `ProjectManager` responsible for lifecycle and lookup:

- Load and validate the registry at startup.
- Create or locate the canonical repository clone.
- Create and remove per-chat worktrees.
- Resolve project deployment policy.
- Delegate chat lifecycle to a `ChatManager`.

Introduce a `ChatManager` responsible for:

- Persisting chat metadata separately from project policy.
- Start a session lazily when a chat is first opened.
- Stop idle sessions after a configurable timeout.
- Limit the number of concurrent sessions.
- Route messages, cancellation, event storage, and SSE subscriptions by chat
  ID.
- Report lifecycle failures as chat-scoped errors.

The initial implementation may use one Node process with isolated session
objects. Each chat session must receive its own workspace, config, Copilot client, event
store, event hub, and permission policy. A later implementation may move
sessions into worker processes for stronger failure and memory isolation.

## HTTP API

Add project-scoped endpoints:

```text
GET    /api/projects
POST   /api/projects
PATCH  /api/projects/:projectId
DELETE /api/projects/:projectId
GET    /api/projects/:projectId/chats
POST   /api/projects/:projectId/chats
GET    /api/chats/:chatId/session
GET    /api/chats/:chatId/session/events?after=<id>
POST   /api/chats/:chatId/session/messages
POST   /api/chats/:chatId/session/cancel
GET    /api/projects/:projectId/status/resources
POST   /api/projects/:projectId/deploy
```

The existing `/api/session` routes may remain as compatibility aliases to the
configured default project during migration.

Every project-scoped request must:

- Authenticate the Tailscale identity before project lookup.
- Resolve and validate the project ID.
- Enforce that all filesystem and Git operations use that project's policy.
- Return a consistent not-found response without revealing filesystem paths.

SSE connections must be isolated by project. Events from one project must never
be broadcast to another project's subscribers.

## Client experience

Add a project picker near the top of the current shell. It should show each
project's name and state, and identify the active project clearly.

When switching projects:

1. Close the current SSE connection.
2. Clear the timeline and project-scoped error state.
3. Load the selected project's snapshot.
4. Connect to its event stream.
5. Update the URL or client state so refresh preserves the selection.

The composer remains disabled until the selected project is ready. Deployment
controls must name the target project and require confirmation. The UI should
show project-specific runtime state, last deployment revision, and resource
health without hiding errors.

## Deployment

Replace the single global deployment target with a project-qualified request:

```text
projectId
targetId
requestedRevision
```

`requestedRevision` may be `latest` or an internally resolved exact revision;
it is never user input in the normal mobile workflow. The privileged controller
resolves it against the configured integration branch.

Deployment validation must verify:

- The request targets a registered project.
- The commit is the exact clean `agent/current` revision for that project, or
  the explicitly configured equivalent branch.
- The working tree and remote match the project's policy.
- The candidate starts and passes health checks before slot activation.

Deployment behavior is provided by allowlisted adapters, never arbitrary
commands from project configuration:

- **GitHub workflow adapter**: dispatch or observe a configured workflow and
  track its run and environment result.
- **Local controller adapter**: write a constrained project-qualified request
  to a root-owned controller with independent build, health, and rollback
  state.
- **Agent Outpost self-deployment adapter**: preserve the existing blue-green
  controller as the default project's local adapter.

Blue-green deployment should be scoped to a project. A failed candidate must
roll back that project only, without restarting unrelated project sessions.
Deployment records should include project ID, commit SHA, slot, timestamps,
health result, and rollback reason.

## Security and isolation

- Keep one permission policy per project workspace.
- Reject symlink escapes and paths outside the project's approved root.
- Verify Git remotes independently for every project.
- Do not allow a project to select another project's data directory.
- Treat project names and event content as untrusted display data.
- Apply per-project request authorization before opening runtime resources.
- Add limits for concurrent sessions, memory, CPU, disk, and event history.

Project registration is an administrative operation. The first version may
allow it only through a local setup command or a Tailscale identity configured
as an administrator; it must not be an unauthenticated web form.

## Migration

1. Derive a default project from the current `OUTPOST_WORKSPACE`,
   `OUTPOST_DATA_DIR`, `OUTPOST_ALLOWED_GIT_REMOTE`, and `OUTPOST_SESSION_ID`.
2. Preserve existing event history by assigning it to the default project.
3. Keep existing environment variables working as compatibility defaults.
4. Introduce a registry migration that is atomic and repeatable.
5. Keep the current single-project routes until the multi-project client is
   stable.

No existing conversation history should be copied or re-keyed unnecessarily.

## Delivery phases

### Phase 1: Domain and storage

- Add project types, registry persistence, validation, and migrations.
- Persist chats with stable project identity.
- Refactor event stores and permission policies to accept project and chat
  config.
- Add unit tests for duplicate IDs, path isolation, and migration.

### Phase 2: Runtime and API

- Add `ProjectManager` and lazy lifecycle management.
- Add `ChatManager` and one isolated runtime/event store per chat.
- Implement chat-scoped session and SSE routes.
- Retain compatibility aliases for the default project.
- Add API tests proving event and permission isolation.

### Phase 3: Client

- Add project picker and project-aware routing.
- Preserve scroll, composer, and error behavior per selected project.
- Add project state and resource indicators.

### Phase 4: Deployment

- Qualify deployment requests by project.
- Add allowlisted GitHub workflow and local-controller adapters.
- Add project-scoped candidate validation, slot switching, and rollback.
- Verify one project's deployment cannot interrupt another.

### Phase 5: Operational hardening

- Add idle-session eviction and resource limits.
- Add structured audit events for project selection and deployment.
- Document registration, backup, restore, and removal procedures.

## Acceptance criteria

- Two projects can run on the same server with separate workspaces and event
  histories.
- Switching projects never displays or streams events from the other project.
- A Copilot tool operation cannot read or write outside its project's workspace.
- Each project can be cancelled and restarted independently.
- Deploying or rolling back one project leaves the other project available.
- Restarting the server restores the registry and both project histories.
- Existing single-project configuration starts without manual migration work.
