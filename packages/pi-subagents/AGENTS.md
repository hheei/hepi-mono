# pi-subagents

Follow the repository `AGENTS.md` for tooling, TypeScript, documentation, and workflow rules.

- This package owns the public `agent`, `get_subagent_result`, and `steer_subagent` contracts, profile discovery, invocation policy, records, delivery, and Agent Fleet UI.
- Every child execution, cancellation, turn limit, terminal result, disposal, standalone steering, and transcript read must use `@hheei/pi-ext-core` handles. Do not retain or expose a raw child `AgentSession` outside the resolved child-session factory.
- Use the package's Vitest suite for affected behavior. Run its build when changing package metadata or its Pi extension entrypoint.
- `/agents` remains a domain-owned surface; use core surface registration when that migration slice is implemented. Do not add it to `/ext-settings`.
