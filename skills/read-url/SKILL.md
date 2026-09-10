---
name: read-url
description: Read and summarize content from URLs the user shares.
---

# URL Reader Skill

When the user shares a URL or asks you to read a webpage, use `web_fetch` to fetch it.

`web_fetch` returns the main content as Markdown. If the result says more content
is available, call it again with the supplied `start_index` when the remaining
section may be relevant. Summarize the content according to the user's question.
