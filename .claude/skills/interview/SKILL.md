---
name: interview
description: >-
  Evaluate ideas and gather requirements through structured questions before
  implementation. Use when the user says "interview me", "evaluate this idea",
  "ask me questions", "ask clarifying questions", or describes a feature and
  wants feedback before building.
---

# Interview

Evaluate a proposed idea or feature, then gather requirements through structured questions. Do NOT implement anything.

## Steps

1. **Explore** — read relevant code, understand the current system, identify what the idea touches.

2. **Evaluate** — assess feasibility, identify pitfalls, flag architectural concerns, estimate scope. Present findings concisely.

3. **Interview** — ask structured multi-choice questions using the AskQuestion tool (or conversationally if unavailable). Focus on:
   - Ambiguous design decisions
   - Trade-offs the user should weigh
   - Behavioral edge cases
   - Scope boundaries (what's in/out for MVP)

4. **Summarize** — after answers, restate the resolved design. Flag anything still ambiguous. Ask "any more questions?" or "ready to implement?"

## Rules

- Never start implementing during an interview. The output is a resolved design, not code.
- Ask questions in batches (3-7 at a time), not one by one.
- Include a "Something else — I'll explain" escape hatch on non-obvious questions.
- If the user's idea has clear problems, say so directly before asking questions.
- After the interview, offer to write a plan document if the scope is large.
