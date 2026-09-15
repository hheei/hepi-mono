# 开始使用

按需安装独立扩展；功能、依赖和本地开发包见[软件包清单](packages.md)。

## 安装已发布扩展

在已安装 Pi host 的环境中执行：

```bash
pi install npm:@hheei/pi-ext-tools
```

默认安装到用户配置；使用 `pi install -l npm:@hheei/pi-ext-tools` 安装到当前项目。
具体扩展的兼容性要求见对应 package README。

## 从本地源码安装

前置条件：Node.js >=22.19.0、pnpm >=12.4.1；构建 `pi-ext-tools` 原生桥还需要 stable Rust。
以下命令均在仓库根目录执行，以 `pi-ext-tools` 为例：

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm --filter @hheei/pi-ext-core run build
pnpm --filter @hheei/pi-ext-tools run build:native
pnpm --filter @hheei/pi-ext-tools run build
pi install ./packages/pi-ext-tools
```

`--ignore-scripts` 不会生成构建产物，因此安装本地路径前必须显式构建。
其他扩展按各自 `package.json` 的 `pi.extensions` 和构建脚本准备入口；原生桥构建只适用于 `pi-ext-tools`。

## 不安装的开发运行

完成上述构建后，可以只加载指定入口，不修改 Pi 安装配置：

```bash
pi --no-extensions --no-skills -e packages/pi-ext-tools/dist/extension.js
```

额外 Pi 参数直接追加到命令末尾，例如 `--model <provider/model>`；需要多个扩展时重复传入 `-e <入口路径>`。

仓库也提供自动增量构建并加载固定开发组合的启动器：

```bash
scripts/pi-dev
```

它不是上面单扩展命令的等价替代；加载列表、认证处理及运行边界见[本仓库 Pi 开发启动](../development/pi-dev.md)。

## 运行边界

- `--no-extensions` 禁用默认扩展发现，`-e` 指定的入口仍会加载。
- `--no-skills` 禁用技能发现，不隔离认证、模型或会话目录。
- 源码变化后，使用 `dist/` 入口的扩展需要重新构建；`scripts/pi-dev` 会为其固定开发组合检查构建缓存。
