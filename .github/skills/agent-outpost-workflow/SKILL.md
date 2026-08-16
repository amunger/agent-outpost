---
name: agent-outpost-workflow
description: Use when acting as the Agent Outpost operator - publishing, deploying, filing issues, editing files, or capturing screenshots directly on the running mobile agent. (Operator role; see the external-maintainer skill for outside contributions.)
---

# Agent Outpost Operator Workflow

This skill is for the **operator role**: the persistent Copilot session
running inside Agent Outpost itself, working directly in the deployed
workspace on behalf of the one developer using the mobile app. Use the typed
tools in this procedure. Do not substitute raw `git commit`, `git push`, or
`gh issue create` shell commands; the shell policy intentionally rejects those
privileged transitions.

See the `external-maintainer` skill instead if you are contributing to this
repository from outside the running Agent Outpost instance (for example, a
separate Copilot coding agent working a GitHub issue or pull request against
this codebase without operator tool access).

## Publish and deploy changes

1. Inspect the workspace and understand all modified and untracked files.
2. Make the requested edits only inside the configured workspace.
3. Run validation as separate commands:
   - `npm run typecheck`
   - `npm test`
   - `npm run build`
4. Call `publish_agent_outpost_changes` with a concise one-line commit subject.
   This tool stages all workspace changes, checks the staged diff, creates the
   required coauthored commit, pushes `agent/current`, and returns `commitSha`.
5. Call `deploy_agent_outpost` with that exact returned `commitSha`.
6. Tell the user that deployment was scheduled. The active turn is drained
   before slot cutover, so send the confirmation immediately.

Example:

```text
publish_agent_outpost_changes({ "message": "Improve mobile composer" })
→ { "status": "published", "commitSha": "0123...abcd" }

deploy_agent_outpost({ "commitSha": "0123...abcd" })
→ { "status": "scheduled" }
```

If publishing reports a diverged branch or unexpected remote, stop and report
the exact error. Never force-push, change the remote, or bypass the sandbox.

## Create a GitHub issue

Call `create_agent_outpost_issue` with a focused title and Markdown body.
Include reproduction, expected behavior, actual behavior, and impact when
reporting a bug.

Example:

```text
create_agent_outpost_issue({
  "title": "Deployment status is not visible",
  "body": "## Reproduction\n..."
})
```

Return the issue URL to the user. Do not run `gh issue create` through the shell.

## Edit files when apply_patch is unavailable

- Use `replace_workspace_text` for an exact, single-occurrence replacement in
  an existing UTF-8 file.
- Use `create_workspace_file` for a new text file under an existing directory.
- Paths may be workspace-relative or absolute paths inside the configured
  workspace; paths outside it are rejected.
- Do not attempt shell redirection, `sed -i`, Python file writes, or other shell
  editing workarounds.
- Read the file again after editing and run the relevant validation.

Both tools reject `.git`, parent traversal, symbolic links, ambiguous
replacements, existing create targets, and files over their size limits.

## Capture and share the live UI

Call `capture_agent_outpost_screenshot` with `viewport: "mobile"` for normal
phone validation or `"desktop"` for a wide layout. Set `fullPage: true` only
when the entire conversation is needed.

The tool publishes the screenshot directly into the conversation timeline as
an inline image artifact event; it does not require the operator to paste a
URL into a chat message. Simply confirm to the user that the screenshot is
shown above. If `OUTPOST_PUBLIC_BASE_URL` is configured, the artifact also
includes an absolute Tailscale URL fallback for opening the full image outside
the current page.

Use this whenever a phone user asks in plain language to see what a change
looks like (for example, "show me what the change looks like" or "can I see a
screenshot").

## Verification

- After publishing, use the returned SHA rather than reading a shortened SHA.
- After deployment scheduling, do not begin another file-changing task in the
  same turn.
- A failed candidate is rolled back automatically; report controller failures
  instead of trying to alter systemd, nginx, or root-owned deployment files.
