---
name: domain-modeling
description: Build and sharpen a project's domain model. Use when the user wants to pin down domain terminology or a ubiquitous language, record an architectural decision, or when another skill needs to maintain the domain model.
---

# Domain Modeling

Actively build and sharpen the project's domain model as you design. This is the active discipline: challenge terms, invent edge-case scenarios, and write the glossary and decisions down when they crystallise. Merely reading `CONTEXT.md` for vocabulary is not this skill. This skill changes the model rather than only consuming it.

## File Structure

Most repositories have a single context:

```text
/
|-- CONTEXT.md
|-- docs/
|   `-- adr/
|       |-- 0001-event-sourced-orders.md
|       `-- 0002-postgres-for-write-model.md
`-- src/
```

If a `CONTEXT-MAP.md` exists at the root, the repository has multiple contexts. The map points to where each one lives:

```text
/
|-- CONTEXT-MAP.md
|-- docs/
|   `-- adr/                          <- system-wide decisions
`-- src/
    |-- ordering/
    |   |-- CONTEXT.md
    |   `-- docs/adr/                 <- context-specific decisions
    `-- billing/
        |-- CONTEXT.md
        `-- docs/adr/
```

Create files lazily, only when there is something to write. If no `CONTEXT.md` exists, create one when the first term is resolved. If no `docs/adr/` exists, create it when the first ADR is needed.

## During The Session

### Challenge Against The Glossary

When the user uses a term that conflicts with the existing language in `CONTEXT.md`, call it out immediately. For example: "Your glossary defines cancellation as X, but you seem to mean Y. Which is it?"

### Sharpen Fuzzy Language

When the user uses vague or overloaded terms, propose a precise canonical term. For example: "You are saying account. Do you mean the Customer or the User? Those are different things."

### Discuss Concrete Scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force precision about boundaries between concepts.

### Cross-Reference With Code

When the user states how something works, check whether the code agrees. If there is a contradiction, surface it and ask for a decision.

### Update CONTEXT.md Inline

When a term is resolved, update `CONTEXT.md` immediately. Do not batch updates. Use the format in [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md).

`CONTEXT.md` must contain no implementation details. It is a glossary, not a specification, scratch pad, or repository for implementation decisions.

### Offer ADRs Sparingly

Only offer to create an ADR when all three are true:

1. Hard to reverse: the cost of changing direction later is meaningful.
2. Surprising without context: a future reader will wonder why the choice was made.
3. The result of a real trade-off: there were genuine alternatives and one was chosen for specific reasons.

If any condition is missing, skip the ADR. Use [ADR-FORMAT.md](./ADR-FORMAT.md) when one is warranted.
