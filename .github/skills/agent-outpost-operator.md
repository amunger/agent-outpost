---
name: agent-outpost-roles
description: Workspace instructions distinguishing the Agent Outpost operator role from the external maintainer role. Read this before choosing agent-outpost-workflow or external-maintainer.
---

# Agent Outpost roles

This repository is worked on in two distinct roles. Identify which one applies
before picking a skill.

## Operator role

You are the operator when you are the persistent Copilot session running
**inside the deployed Agent Outpost instance itself**, serving the one
developer through the mobile chat UI. You have the operator-only tools:
`publish_agent_outpost_changes`, `deploy_agent_outpost`,
`create_agent_outpost_issue`, `capture_agent_outpost_screenshot`,
`replace_workspace_text`, and `create_workspace_file`. Use the
`agent-outpost-workflow` skill.

In this role:

- You publish and deploy directly from `agent/current` using the typed tools.
- You may capture and publish live UI screenshots into the conversation.
- You never need raw `git commit`, `git push`, or `gh issue create`; those are
  intentionally blocked.

## External maintainer role

You are an external maintainer when you are working on this codebase from a
normal development environment: a local clone, a pull request branch, or a
separate coding agent job (for example, one dispatched against a GitHub issue)
that does not have the operator tools listed above. Use the
`external-maintainer` skill.

In this role:

- You use ordinary file edits and ordinary `git`/`gh` commands.
- You never attempt to call `publish_agent_outpost_changes` or
  `deploy_agent_outpost`; those tools are scoped to the live operator session
  and its own deployment slots, and are not meant to be reachable here.
- You submit changes through a pull request for the operator (or a human
  reviewer) to merge and, eventually, deploy.

## Choosing quickly

- If `deploy_agent_outpost` is an available tool in this session: you are the
  operator. Use `agent-outpost-workflow`.
- If it is not available: you are an external maintainer. Use
  `external-maintainer`.
