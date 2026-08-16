---
name: external-maintainer
description: Use when contributing to the Agent Outpost repository as an external maintainer or coding agent without operator tools, for example from a GitHub issue or pull request workflow.
---

# Agent Outpost External Maintainer

This skill is for the **external maintainer role**: working on this codebase
from a normal development environment (a clone, a pull request branch, or a
separate coding agent job) without access to the operator-only tools
(`publish_agent_outpost_changes`, `deploy_agent_outpost`,
`create_agent_outpost_issue`, `capture_agent_outpost_screenshot`,
`replace_workspace_text`, `create_workspace_file`). Those tools only exist
inside the running Agent Outpost instance and are not available here.

See the `agent-outpost-workflow` skill instead if you are running inside the
deployed Agent Outpost session with those typed tools available.

## Standard contribution workflow

1. Make changes with ordinary file edits (for example `apply_patch` or an
   editor), not the operator's workspace tools.
2. Run validation locally as separate commands:
   - `npm run typecheck`
   - `npm test`
   - `npm run build`
3. Use ordinary `git` commands (`git add`, `git commit`, `git push`) and open
   a pull request through the normal GitHub flow. Do not attempt to call
   `publish_agent_outpost_changes` or `deploy_agent_outpost`; they are
   unavailable and, even if present, are scoped to the operator's own
   `agent/current` branch and deployment slots.
4. Do not attempt to deploy this application yourself. Deployment is performed
   only by the operator session running inside Agent Outpost, after review.
5. If you find a bug, open it through the normal GitHub issue flow available
   in your environment (for example the `gh` CLI or the GitHub UI), not
   `create_agent_outpost_issue`.

## Security boundaries to respect

- Do not add code paths that grant broader filesystem, credential, or network
  access than the existing permission policy in `src/permission-policy.ts`.
- Do not weaken artifact directory or workspace path validation in
  `src/workspace-path.ts`, `src/http-server.ts`, or the tool definitions.
- Preserve the Tailscale identity check and same-origin mutation check in
  `src/http-server.ts` for any new API route.
- Keep secrets out of the repository, including in `.env.example`, docs, and
  test fixtures.

## Testing conventions

- Co-locate new tests under `test/` using `node:test`, matching the existing
  file-per-module layout.
- Prefer real temporary directories (`mkdtempSync`) and real SQLite files over
  mocks when testing `EventStore` or file-based tools.
- Add a plain-language acceptance description (see
  `docs/screenshot-acceptance-test.md` for the pattern) when a change affects
  what the phone user directly experiences.
