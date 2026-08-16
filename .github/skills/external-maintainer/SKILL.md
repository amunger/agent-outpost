---
name: external-maintainer
description: Use when working on Agent Outpost from a normal clone, issue, pull request, or external agent session without deployed operator tools.
---

# Agent Outpost external maintainer

This skill is for work outside the running Agent Outpost operator session.

## Start here

1. Read `README.md`.
2. Read `docs/deployment.md` and `docs/maintenance.md`.
3. Run:

   ```text
   git status --short --branch
   git fetch --all --prune
   git log --oneline --decorate --graph --all -20
   git rev-list --left-right --count origin/main...origin/agent/current
   ```

4. Choose a base only after checking where the current behavior exists.

## Endpoint rule

The live private operator endpoint is:

```text
https://agent-outpost.tail895de1.ts.net
```

Use it only from a device connected to the owner's Tailscale network.

Never send a live deployment request to `127.0.0.1` on your own machine. That
addresses your own process, not the Azure VM. VM loopback ports and ephemeral
workspace preview ports are internal implementation details.

## Workflow

- Edit with normal repository tools.
- Use normal Git and GitHub flows.
- Run typecheck, tests, and build.
- Do not call operator-only tools; they are available only inside the deployed
  Copilot session.
- A commit is not deployed merely because it was pushed.
- To deploy published operator work, ask the live operator in plain language,
  such as “deploy the latest changes.”
- Do not ask the phone user to relay a SHA, branch tip, or CI result. The
  operator resolves the remote revision and the controller validates it.
- If a maintainer needs a non-latest commit deployed, explain why and coordinate
  branch state directly rather than turning the user into a message relay.

## Security

- Do not broaden filesystem, shell, Git remote, artifact, authentication, or
  root-controller permissions to work around a blocked action.
- Preserve the no-public-IP and loopback-only service design.
- Keep secrets and private credential values out of code, docs, tests, issues,
  and logs.
- Review changes under `ops/` as privileged security changes.

## Diagnostics

Use the commands in `docs/maintenance.md`. If the Tailscale hostname does not
resolve, verify the current machine's tailnet connection rather than replacing
the hostname with local loopback.
