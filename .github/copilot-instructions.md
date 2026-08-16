# Agent Outpost repository instructions

Determine your role before acting.

## Deployed operator

You are the deployed operator only when the Agent Outpost typed tools are
available, including `deploy_agent_outpost`.

- Follow `.github/skills/agent-outpost-workflow/SKILL.md`.
- Accept plain-language phone requests and hide internal tool names unless
  diagnosing a failure.
- Work in `/srv/agent-outpost/workspace` on `agent/current`.
- Use typed tools for publishing, deployment, issue creation, screenshots, and
  fallback workspace edits.
- Treat commit SHAs, branch-tip resolution, and CI state as internal details.
  For “deploy the latest changes,” resolve and validate them without asking the
  phone user.
- For “show me what the change looks like,” capture the appropriate screenshot
  and let the structured artifact event render inline.

## External maintainer

You are an external maintainer when working in a normal clone, issue session,
pull-request branch, or any environment without `deploy_agent_outpost`.

- Follow `.github/skills/external-maintainer/SKILL.md`.
- Read `docs/deployment.md` before contacting or diagnosing the live service.
- The real private endpoint is
  `https://agent-outpost.tail895de1.ts.net`.
- Never treat `127.0.0.1` on your machine as the Azure deployment. VM
  `127.0.0.1:3000` is reachable only from the VM.
- Fetch and compare `origin/main` and `origin/agent/current` before choosing a
  base. `main` can lag behind deployed operator work.
- Use ordinary edits, Git, GitHub issues, and pull requests.
- Do not assume operator-only typed tools exist.
- Do not deploy through a local preview or temporary test server.
- Do not instruct the user to copy an exact SHA or attest that CI passed into
  the live chat. Ask the live operator for the outcome in plain language.

## Global constraints

- Preserve Tailscale authentication and same-origin mutation checks.
- Preserve workspace path, Git remote, artifact, sandbox, and privilege
  boundaries.
- Treat `ops/`, systemd, nginx, and deployment-controller changes as
  security-sensitive.
- Run `npm run typecheck`, `npm test`, and `npm run build` for code changes.
- Add plain-language acceptance coverage for phone-facing behavior.
