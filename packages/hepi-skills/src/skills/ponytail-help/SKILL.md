---
name: ponytail-help
description: >
  Quick-reference card for the Ponytail Pi extension, modes, and companion
  skills. One-shot display, not a persistent mode. Trigger:
  /skill:ponytail-help, "ponytail help", "what ponytail commands", or "how do
  I use ponytail".
---

# Ponytail Help

Display this reference card when invoked. One-shot: do not change mode or write settings.

## Modes

| Level | Command | Behavior |
|-------|---------|----------|
| **Lite** | `/ponytail lite` | Build what was asked and name a materially simpler alternative. |
| **Full** | `/ponytail` or `/ponytail full` | Enforce YAGNI, reuse, stdlib, native features, then minimum code. |
| **Ultra** | `/ponytail ultra` | Try deletion first and reject speculative work. |
| **Off** | `/ponytail off` | Disable persistent Ponytail instructions for this branch. |

Use `/ponytail status` to show the active mode. Saying `stop ponytail` or `normal mode` also disables it.

## Companion Skills

| Skill | Invocation | Behavior |
|-------|------------|----------|
| **ponytail-review** | `/skill:ponytail-review` | Review a diff only for over-engineering. |
| **ponytail-audit** | `/skill:ponytail-audit` | Audit the repository for removable complexity. |
| **ponytail-debt** | `/skill:ponytail-debt` | Collect `ponytail:` shortcut comments into a ledger. |
| **ponytail-gain** | `/skill:ponytail-gain` | Show the upstream benchmark scoreboard. |
| **ponytail-help** | `/skill:ponytail-help` | Show this card. |

These are Pi skills, not registered top-level commands.

## Defaults

With `@hheei/pi-basics` loaded, open `/ext-settings` and select **Ponytail defaults**. Main-agent and subagent modes are configured separately. The same values can be written under `pi-ponytail.defaults` in the project's `.pi/settings.json`.

Full upstream documentation: https://github.com/DietrichGebert/ponytail
