# @hheei/pi-goal

Session Goal tool and `/goal` command. Requires `@hheei/pi-basics` in the same Pi process.

`/goal <objective>` starts or replaces a Goal. `/goal` suspends the active Goal, restores the latest branch-local suspended or blocked Goal, or waits for the next user input. The model settles it through the `goal` tool with `complete` or `blocked`.

State is stored in branch session history. User-triggered mode changes notify with `※ Goal Mode enabled` or `※ Goal Mode stopped`. While Goal is waiting, active, suspended, or blocked, the statusbar shows the single label `Goal` without an internal state suffix.

Loadout support is mediated by `pi-basics`; this package does not depend on `pi-loadout`.
