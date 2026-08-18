# Agent Outpost

Agent Outpost is a self-hosted, mobile-first control surface for a persistent
GitHub Copilot coding session. It runs on a private Linux VM, keeps its source
and tools on that VM, and lets one developer work through a phone conversation.

The deployed operator can:

- Read and edit its workspace.
- Run type checks, tests, and builds.
- Commit and push validated changes to `agent/current`.
- Deploy an exact commit through blue-green slots with automatic rollback.
- Create GitHub issues through a repository-scoped tool.
- Capture deployed or unpublished workspace UI screenshots and publish them
  inline in the conversation.
- Preserve conversation history and artifacts across process restarts and VM
  reboots.

## Current deployment

The private operator URL is:

**https://agent-outpost.tail895de1.ts.net**

It is reachable only from the owner's Tailscale network. This hostname is not a
secret, but possession of it does not grant access.

> [!IMPORTANT]
> `127.0.0.1` always means the machine on which the command is running. On the
> Azure VM, `127.0.0.1:3000` is the live nginx entry point. On a maintainer's
> laptop or a temporary Windows test server, it is **not** Agent Outpost. An
> external agent must use the Tailscale URL above to contact the live operator.

See [Live deployment](docs/deployment.md) for the current Azure resource names,
ports, paths, branch semantics, and ways to verify which revision is active.

## Architecture

```text
Phone or tailnet-connected browser
        |
        | HTTPS: agent-outpost.tail895de1.ts.net
        v
Tailscale Serve
        |
        | proxy to 127.0.0.1:3000 on the Azure VM
        v
nginx
        |
        +--> slot A on 127.0.0.1:3001
        |
        `--> slot B on 127.0.0.1:3002
                  |
                  v
        Node.js + GitHub Copilot SDK
                  |
          persistent Copilot runtime
                  |
        /srv/agent-outpost/workspace
```

The application binds only to loopback. Tailscale supplies the authenticated
user identity. nginx keeps the external URL stable while the root-owned
deployment controller switches between slots.

For the complete component, event, storage, and deployment model, see
[Architecture](docs/architecture.md).

## Plain-language operator workflow

The phone user should describe outcomes, not implementation:

- “Fix the composer layout.”
- “Show me what the change looks like.”
- “Create an issue for that bug.”
- “Deploy those changes.”
- “Deploy the latest changes.”

The deployed operator maps those requests to constrained typed tools. A normal
change follows this flow:

```text
edit workspace
    -> validate
    -> commit and push agent/current
    -> ask to deploy the latest changes
    -> build immutable release
    -> start inactive slot
    -> readiness check
    -> switch nginx
    -> rollback automatically on failure
```

The phone user never needs to identify a commit SHA or inspect CI. Exact
revisions are resolved internally, and the deployment controller reruns the
authoritative install, typecheck, test, build, and readiness checks.

Screenshots are structured conversation events. They appear inline with an
“Open full image” link rather than requiring the user to understand an
`/api/artifacts/...` path.

## Branches and source of truth

- `agent/current` is the deployed operator's autonomous working branch.
- `main` is the maintained baseline and can lag behind `agent/current`.
- The live deployment can also lag behind the tip of `agent/current` while work
  is in progress.
- Never assume `main`, `agent/current`, and the active deployment are equal.

Before external work, run:

```powershell
git fetch --all --prune
git log --oneline --decorate --graph --all -20
git rev-list --left-right --count origin/main...origin/agent/current
```

If the task concerns current deployed behavior, inspect `origin/agent/current`
and the active deployment first. See [External maintenance](docs/maintenance.md).

## Local development

Requirements:

- Node.js 22.12 or later
- GitHub Copilot CLI
- A GitHub account with an active Copilot subscription

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

Validation:

```powershell
npm run typecheck
npm test
npm run build
```

The local development server is not the live deployment. It uses the current
machine's loopback interface and local files.

## Documentation

- [Architecture](docs/architecture.md) — components, trust boundaries, state,
  tools, requests, events, and deployment transaction.
- [Live deployment](docs/deployment.md) — real endpoint, Azure inventory,
  ports, paths, services, configuration, and revision checks.
- [External maintenance](docs/maintenance.md) — start-here checklist,
  contribution workflow, contacting the operator, rollout, diagnostics, and
  recovery.
- [Security](docs/security.md) — authentication, privilege separation,
  filesystem policy, typed tools, artifacts, secrets, and residual risks.
- [Bootstrap](docs/bootstrap.md) — provisioning a replacement installation.
- [Screenshot acceptance test](docs/screenshot-acceptance-test.md) —
  plain-language phone UX contract.
- [Multi-project proposal](docs/multi-project-spec.md) — future direction; not
  the current production architecture.

## Agent roles

This repository is used by two distinct kinds of agents:

1. **Deployed operator** — runs inside Agent Outpost and has typed operator
   tools. It follows the `agent-outpost-workflow` skill.
2. **External maintainer** — works in a normal clone, issue, or pull-request
   session and does not have operator tools. It follows the
   `external-maintainer` skill.

Repository-wide role selection is defined in
[copilot-instructions.md](.github/copilot-instructions.md).

## Status and limitations

The single-user Azure deployment is operational. It remains an evolving MVP:

- One principal repository workspace with independent persistent Copilot
  sessions for each chat.
- GitHub-specific repository and issue workflows.
- Private access through Tailscale.
- Copilot local sandbox functionality is experimental.
- Built-in GitHub Mobile CLI remote control is disabled by the owner's
  organization; the custom Agent Outpost UI is the supported mobile surface.
- Multi-project support is a proposal, not a deployed capability.

## License

[MIT](LICENSE)
