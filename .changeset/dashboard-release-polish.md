---
'@shardlens/collector': patch
---

Dashboard:

- A page that is loading or failed says so, with a retry, instead of looking like "no data"; errors are written in
  words. An Overview left open notices the bot's first events by itself.
- Each page sets the tab title, moves keyboard focus to its heading and keeps table rows reachable by keyboard.
  Signing out clears what was loaded.
- Chart axes, tooltips and tables use the browser's locale. An unknown command shows "Command not found".
- Server search no longer moves the caret or drops a leading space, the last page of a list keeps its controls, and a
  page past the end shows the last page.
- Long names (the bot's, a server's) wrap instead of widening the page on a phone. Settings messages appear next to
  what they concern, and every admin action confirms.
