# Getting started

Pi Hindsight gives Pi durable memory through Hindsight. 在 HEPI 工作区启动本地 extension，运行 `/hindsight`，选择记忆 profile，然后完成引导配置。

## 1. Install

从 HEPI 仓库根目录启动本地 extension：

```bash
pi -e packages/pi-hindsight/extensions/index.ts
```

也可将本地包安装到 Pi：

```bash
pi install /absolute/path/to/hepi-mono/packages/pi-hindsight
```

## 2. Choose a Hindsight server

Use either:

- [Hindsight Cloud signup](https://ui.hindsight.vectorize.io/signup)
- [Self-hosted Hindsight installation](https://hindsight.vectorize.io/developer/installation)
- **Embedded local server (no Docker):** Install [`@vectorize-io/hindsight-all`](https://github.com/vectorize-io/hindsight/tree/main/hindsight-all-npm) and use `HindsightServer` to start a local daemon programmatically. Requires `uv`/`uvx` and Python on the host. Pairs with the existing `@vectorize-io/hindsight-client` used by this extension.

The default local URL is:

```text
http://localhost:8888
```

For a fully private setup without external LLM API keys, use Hindsight's built-in llama.cpp/local-LLM path.

## 3. Run `/hindsight`

Open Pi in your repository and run:

```text
/hindsight
```

If no project config exists, `/hindsight` offers guided setup, open hub, **Ignore this repo** (durable `enabled: false` + `setupComplete: true` + `status.style: off`; tools refuse calls), or skip for now. You can rerun guided setup later from the TUI with `g`.

**Setup gate:** automatic bank ensure, recall, and retain stay off until setup is satisfied. For default **domain-tagged** mode with project memory on, that means an explicit coding bank id (`banks.project.bankId` / `PI_HINDSIGHT_PROJECT_BANK_ID`, usually via guided setup). Soft signals alone (empty project config, queue/cursor files, or `setupComplete` without a bank id) do **not** unlock domain-tagged auto memory. **Isolated-bank** may keep path-derived banks after config/runtime signals or guided setup. Status warns when setup is required.

Guided setup handles:

1. Hindsight server URL
2. memory profile (**Coding** is recommended for normal repos)
3. coding and/or life bank ids (shared coding bank id is saved to user/global config and prefilled next time)
4. optional dry-run-first historical import

Starter mental models can be applied from setup/templates. Ongoing mental-model and mission maintenance is agent-first (ADR-005); the Hindsight web UI remains available for control-plane browsing.

## 4. Pick a profile (Coding is the default recommendation)

- **Coding** (recommended): one shared coding bank; repos separated by tags. Use for almost every personal coding repo.
- **Coding + Life**: coding bank plus an optional personal/life bank for prefs and goals.
- **Isolated project**: hard-wall bank for this repo only (client/sensitive work).
- **Life only**: personal bank only; no coding bank.
- **Recall only**: inject memory, do not auto-save this session.

See [Memory behavior](memory-behavior.md) and [Project identity](project-identity.md).

## 5. Check status

After setup, `/hindsight` should show:

- reachable Hindsight server
- expected memory profile (usually **Coding**)
- expected coding bank and optional life bank
- automatic recall/retain state
- retain queue path
- import checkpoint/manifest state when imports have run

If automatic recall injects irrelevant noise, see [Recall quality](memory-behavior.md#recall-quality) for always-on filters and optional score floors (off by default).

## 6. Import old sessions only when useful

Live retain starts after setup. Historical import is optional backfill. Use guided setup's import prompt first when it appears; it previews before writing memory.

For later imports, use the importing sessions guide. Commands and tools remain available for advanced or scripted imports.
