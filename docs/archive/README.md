# Archive

Documents here describe something that no longer exists, or something that was decided and finished.
They are kept for the reasoning, not for the behaviour.

Nothing in this directory overrides source, tests, package READMEs, or the current specifications in
[`docs/`](../README.md). If you need the current contract, read the architecture guide or spec named
in the header of each archived file.

## Contents

- [`pi-fff.md`](pi-fff.md): research on the FFF Node SDK and early search exploration. The FFF
  extension and its native dependency were removed; file and content search is ripgrep now.
- [`pi-subagents/PLAN.md`](pi-subagents/PLAN.md): the original design specification for the subagent
  extension. Its RPC-by-default model, attach/detach lifecycle, and writer-handoff sections were
  replaced by the bridge control plane and the sqlite mailbox.
- [`pi-subagents/PLAN-panel-bridge.md`](pi-subagents/PLAN-panel-bridge.md): the design draft that
  introduced panel presentation and the bridge control plane. Landed; the runtime contract now lives
  in [`../pi-subagents/spec.md`](../pi-subagents/spec.md).
- [`pi-subagents/PLAN-delivery-presentation.md`](pi-subagents/PLAN-delivery-presentation.md): the
  delivery, observation, and widget plan. Its premise (children run in RPC until attached) was
  superseded by the panel-bridge draft; its prohibitions still hold and are stated in the spec.
- [`pi-subagents/tickets.md`](pi-subagents/tickets.md): the V1 and MCP R4 task backlog with its
  acceptance history. The work is done; current state is described by the spec and the package.

## Adding to the archive

Move a document here when its subject is gone (a removed feature, a replaced design, a finished
backlog) and the reasoning is still worth keeping. Fix inbound links in the same commit, and do not
leave a copy behind. Documents that still constrain current work belong in `docs/architecture/`,
`docs/plans/`, or the owning package's spec instead.
