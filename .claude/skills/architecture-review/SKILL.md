---
name: architecture-review
description: >-
  Deep codebase exploration and architecture assessment. Use when the user says
  "examine architecture", "how is X structured", "what can be improved",
  "evaluate the codebase", or wants an abstraction/coupling analysis.
---

# Architecture Review

Explore a codebase area in depth, assess its architecture, and present findings. Do NOT modify code.

## Steps

1. **Scope** — clarify what to examine. If the user said "examine X", X is the scope. If broad ("examine the app"), ask what area to focus on.

2. **Explore** — read the relevant files thoroughly. Understand:
   - Data model and storage
   - Component/module boundaries
   - Data flow (who creates, who reads, who mutates)
   - Abstraction layers and their quality
   - Coupling between modules

3. **Assess** — for each area, rate abstraction quality (Good / Medium / Low) and explain why. Use a summary table:

```
| Aspect              | Quality | Notes                          |
|---------------------|---------|--------------------------------|
| Widget dispatch     | Good    | Registry + switch, additive    |
| State management    | Low     | Everything in one component    |
| Agent perception    | Medium  | Single lens, manually extended |
```

4. **Recommend** — concrete improvement suggestions, ordered by impact and risk. For each:
   - What to change
   - Why it matters
   - Rough effort estimate
   - Whether it can be done independently

5. **Present** — deliver findings. Don't implement unless asked. If asked "what can be done", present options and let the user choose.

## Rules

- Read extensively before forming opinions. Don't assess from file names alone.
- Be direct about problems — don't soften with "it's fine for now" if it's actually a growth risk.
- Distinguish between "this is bad" and "this will become bad at scale" — both matter but differently.
- When presenting improvements, always note what existing behavior must be preserved.
