# Acceptance test: sharing a screenshot in plain language

## Scenario

A phone user wants to see what a UI change looks like without knowing about
tools, API paths, or artifact URLs.

## Steps

1. Open the mobile chat and type: "show me what the change looks like."
2. Send the message.

## Expected result

1. The agent captures a screenshot of the live UI.
2. Within a few seconds, an image appears directly in the conversation
   timeline, with a short caption such as "Mobile UI screenshot."
3. Below the image there is an "Open full image" link. Tapping it opens the
   same screenshot at full size.
4. The agent's reply does not contain a raw file path, tool name, or JSON. It
   only confirms in plain language that the screenshot is shown above.
5. If the phone is on a different Tailscale node than the server, the "Open
   full image" link still works because it is an absolute Tailscale URL, not
   a relative path that only resolves on the server's own origin.
6. If the user asks again after a UI change was deployed, the browser loads
   the new JavaScript and CSS immediately; it does not need a manual
   hard-refresh or cache clear to see the update, because the mobile
   JavaScript and CSS are served with `Cache-Control: no-cache`.

## Out of scope

- Video capture or multi-frame comparisons.
- Automatic screenshots without an explicit user request.
