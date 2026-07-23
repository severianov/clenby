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

If a feature stopped attaching, what does the selector-health panel report?
(claude.ai ships UI changes without notice — this usually pinpoints the broken
anchor immediately.)

**Screenshots / console output**

If applicable. Console lines tagged `[cc]` (DevTools on the claude.ai tab) and
the extension card's "Errors" list are the fastest route to a fix.

**One check before filing**

If settings or pairing "vanished", did the extension get removed and re-added
(rather than reloaded/updated)? Re-adding resets extension storage by browser
design — that's not a Clenby bug, but tell us anyway if it surprised you.
