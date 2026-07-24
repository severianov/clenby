---
name: Bug report
about: Something broke or stopped attaching
title: ""
labels: bug
assignees: ""
---

**What happened**

A clear description of the bug.

**Steps to reproduce**

1. Go to …
2. Click …
3. See …

**Expected behavior**

What you expected instead.

**Environment**

- Browser + version: (e.g. Chrome 126, Firefox 128)
- Clenby version:
- OS:
- Using the Claude Code bridge? (yes/no — if yes, paste the output of
  `npx clenby-bridge@latest audit` so we know exactly which build you run)

**Selector health**

If a feature stopped attaching, open the selector-health panel (gear menu →
Self-healing, or the command palette → "Selector health") and press **Copy
report**, then paste it here. That one block carries the anchor states, the
claude.ai build id and your browser — everything needed to reproduce it.

**Open a GitHub issue ↗** in the same panel does this for you: it opens this
form already filled in.

The report contains anchor names, health counters and structural element paths
only — no message text, conversation titles or URLs.

**Screenshots / console output**

If applicable. Console lines tagged `[cc]` (DevTools on the claude.ai tab) and
the extension card's "Errors" list are the fastest route to a fix.

**One check before filing**

If settings or pairing "vanished", did the extension get removed and re-added
(rather than reloaded/updated)? Re-adding resets extension storage by browser
design — that's not a Clenby bug, but tell us anyway if it surprised you.
