# ADR Format

ADRs live in `docs/adr/` and use sequential numbering: `0001-slug.md`, `0002-slug.md`, and so on.

Create `docs/adr/` lazily, only when the first ADR is needed.

## Template

```md
# {Short title of the decision}

{One to three sentences: what is the context, what was decided, and why.}
```

An ADR can be one paragraph. The value is recording that a decision was made and why, not filling out sections.

## Optional Sections

Only include sections that add genuine value. Most ADRs do not need them.

- Status frontmatter: `proposed`, `accepted`, `deprecated`, or `superseded by ADR-NNNN`.
- Considered Options: only when rejected alternatives are worth remembering.
- Consequences: only when downstream effects are non-obvious.

## Numbering

Scan `docs/adr/` for the highest existing number and increment by one.

## When To Offer An ADR

All three must be true:

1. Hard to reverse: changing direction later has meaningful cost.
2. Surprising without context: a future reader would wonder why the choice was made.
3. The result of a real trade-off: genuine alternatives were considered.

When a decision is easy to reverse, unsurprising, or has no real alternative, do not create an ADR.
