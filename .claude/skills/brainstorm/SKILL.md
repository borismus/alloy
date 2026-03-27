---
name: brainstorm
description: >-
  Generate creative ideas and approaches for a goal or direction. Use when the
  user says "brainstorm", "inspire me", "what are some ways to", "I want to
  make X better", or describes a goal without a specific solution in mind.
---

# Brainstorm

The user has a goal or direction but wants inspiration. Generate multiple concrete approaches, be opinionated about which are strongest, and let the user cherry-pick.

## Steps

1. **Understand the goal and the codebase** — read what the user described, then **thoroughly explore the relevant code** before generating any ideas. Understand the data model, existing abstractions, current patterns, and constraints. Ideas that ignore the codebase are worthless.

2. **Generate ideas** — come up with 4-8 genuinely different approaches, grounded in what the code actually does today. Not minor variations — distinct takes on the problem. For each:
   - **Name** — short memorable label
   - **What** — 2-3 sentence description of the approach
   - **Why it's interesting** — what makes this worth considering
   - **Trade-off** — what you give up or what's hard about it

3. **Rank and recommend** — be opinionated. Mark your top 1-2 picks and say why. Flag any that are bad ideas and say why. Don't present everything as equally valid.

4. **Invite reaction** — ask which ideas resonate, which to kill, and whether to combine any. The user's picks feed into an interview or straight to implementation.

## Rules

- **Always explore the codebase first.** Read the relevant files, understand the architecture, then ideate. Never brainstorm in a vacuum.
- Be creative, not safe. Include at least one ambitious/unexpected idea alongside pragmatic ones.
- Reference specific files, functions, patterns, and constraints from the codebase in every idea. Vague ideas that could apply to any project are not useful.
- Don't ask clarifying questions upfront. Make reasonable assumptions and generate. The user will correct what's off.
- Keep each idea concise. The full brainstorm should be scannable in under 3 minutes.
- After the user reacts, offer to refine the selected ideas or transition to interview/implementation.
