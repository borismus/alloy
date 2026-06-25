# Backlog

Tasks for the autonomous backlog runner (`scripts/backlog-runner.sh`).
Each `- [ ]` is one self-contained task. The runner picks the first open one,
works it on an `auto/<slug>` branch, verifies, and opens a PR for review.

Keep tasks small and unambiguous — one PR's worth of work each.

- [ ] Add a unit test file src/utils/ids.test.ts for generateMessageId in src/utils/ids.ts, asserting the returned id matches the pattern msg-<4 hex chars>
