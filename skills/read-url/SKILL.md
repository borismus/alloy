---
name: read-url
description: Read and summarize content from URLs the user shares.
---

# URL Reader Skill

When the user shares a URL or asks you to read a webpage, use `http_get` to fetch it.

Extract the main content and provide a summary. If the page is very long, focus on
the most relevant sections based on the user's question.
