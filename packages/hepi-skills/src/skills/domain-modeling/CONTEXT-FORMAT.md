# CONTEXT.md Format

## Structure

```md
# {Context Name}

{One or two sentence description of what this context is and why it exists.}

## Language

**Order**:
{A one or two sentence description of the term}
_Avoid_: Purchase, transaction

**Invoice**:
A request for payment sent to a customer after delivery.
_Avoid_: Bill, payment request

**Customer**:
A person or organization that places orders.
_Avoid_: Client, buyer, account
```

## Rules

- Be opinionated. When multiple words exist for the same concept, pick the best one and list the others under `_Avoid_`.
- Keep definitions tight. One or two sentences at most. Define what it is, not what it does.
- Include only terms specific to the project's context. General programming concepts do not belong even if the project uses them extensively.
- Group terms under subheadings when natural clusters emerge. A single cohesive area can use a flat list.

## Single vs Multi-Context Repositories

For a single context, use one root `CONTEXT.md`.

For multiple contexts, a root `CONTEXT-MAP.md` lists the contexts, their locations, and relationships:

```md
# Context Map

## Contexts

- [Ordering](./src/ordering/CONTEXT.md) - receives and tracks customer orders
- [Billing](./src/billing/CONTEXT.md) - generates invoices and processes payments
- [Fulfillment](./src/fulfillment/CONTEXT.md) - manages warehouse picking and shipping

## Relationships

- **Ordering -> Fulfillment**: Ordering emits `OrderPlaced` events; Fulfillment consumes them to start picking
- **Fulfillment -> Billing**: Fulfillment emits `ShipmentDispatched` events; Billing consumes them to generate invoices
- **Ordering <-> Billing**: Shared types for `CustomerId` and `Money`
```

Infer the structure from existing files: use `CONTEXT-MAP.md` when present, otherwise a root `CONTEXT.md`, and create the first context file lazily when a term is resolved.
