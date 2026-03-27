---
name: critique
description: >-
  Stress-test a specific idea or proposal. Use when the user says "critique
  this", "is this a good idea", "any concern", "evaluate this approach",
  "pushback", or presents a specific design and wants it challenged.
---

# Critique

The user has a specific idea or proposal. Stress-test it — validate what's good, poke holes, suggest refinements. Don't replace the idea with a different one.

## Steps

1. **Understand the idea** — parse what the user is proposing, even if described tersely or via voice transcription.

2. **Explore the codebase** — read the relevant files to ground the critique in reality. Identify existing patterns, constraints, and code that the idea touches.

3. **Validate** — state clearly what works well about the idea and why. Reference specific code/patterns that support it.

4. **Challenge** — identify specific concerns, numbered. For each:
   - What the problem is
   - Why it matters (not theoretical — reference real code, real data flow, real user behavior)
   - How severe it is (blocks the idea vs. solvable during implementation)

5. **Refine** — suggest improvements to the idea that address the concerns. Don't pitch a completely different approach — improve what the user proposed. If a concern is severe enough that the idea should change fundamentally, say so directly.

6. **Verdict** — give a clear overall take. "The idea is sound, here's the cleanest implementation" or "This has a structural problem — here's why" or "Good with these modifications."

## Rules

- Be direct. Don't soften criticism with "this is great but..." — just say what's wrong.
- Every concern must reference specific code, files, or patterns. No abstract worrying.
- Validate genuinely good parts — don't manufacture praise, but don't skip it either.
- Refinements improve the user's idea, they don't replace it. If you think the whole idea is wrong, say that explicitly rather than sneaking in a different proposal.
- When the user presents multiple ideas, critique each separately with its own verdict.
