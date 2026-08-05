# Pi Hindsight

Pi 的 Hindsight 长期记忆扩展。它在模型调用前召回相关项目记忆，在 agent run 完成后保存结构化会话增量，并提供显式 retain、recall、reflect 操作。

这是 `@hheei/pi-hindsight` 的 HEPI 工作区版本。上游跟随范围见 [docs/hindsight/follow.md](docs/hindsight/follow.md)。

## 本地使用

在 HEPI 仓库根目录启动 Pi：

```bash
pi -e packages/pi-hindsight/extensions/index.ts
```

或者将本地包安装到 Pi：

```bash
pi install /absolute/path/to/hepi-mono/packages/pi-hindsight
```

Pi 启动后运行 `/hindsight`。引导配置会要求 Hindsight server URL、项目 bank 与可选 user bank。默认本地服务地址是 `http://localhost:8888`。

Hindsight server 可使用 [Hindsight Cloud](https://ui.hindsight.vectorize.io/signup)、[自托管服务](https://hindsight.vectorize.io/developer/installation)，或 `@vectorize-io/hindsight-all` 的嵌入式服务。

## 开发

```bash
bun install
cd packages/pi-hindsight && bun run typecheck && bun run test
```

本包依赖 Pi `>=0.83.0`。工作区使用 Bun、Biome 与根目录 TypeScript 规则。

## 文档

- [Getting started](docs/getting-started.md)
- [Memory behavior](docs/memory-behavior.md)
- [Tools and commands](docs/tools-and-commands.md)
- [Configuration](docs/configuration.md)
- [Importing sessions](docs/importing-sessions.md)
- [Compatibility](docs/compatibility.md)
- [Upstream follow](docs/hindsight/follow.md)
