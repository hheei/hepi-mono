# FFF：索引搜索、数据格式与 Pi 集成

本文记录 [FFF](https://github.com/dmtrKovalenko/fff.nvim) 的 Node SDK 能力，以及它和 Pi host、`pi-ext-tools`、Pix 的边界。面向需要设计搜索工具、renderer 或 fallback 的开发者。

这是一份研究记录，不替代 `docs/tools/fff-search.md` 的 `pi-ext-tools` 工具契约，也不代表 Pi host 已原生使用 FFF。

## 结论先行

- FFF 是常驻的 Rust 文件索引和内容搜索 runtime；它不是 `rg` 或 `fd` 的命令行包装。
- Pi host 原生 `grep` 使用 `rg`，原生 `find` 使用 `fd`；见 [Pi 原生工具概览](pi-native-tools.md)。
- FFF Node SDK `@ff-labs/fff-node@0.10.3` 已暴露每个命中的精确 byte range、行/文件 offset、context 和分页 cursor。
- 使用 FFF 时，extension 必须自己拥有 finder 生命周期、取消策略、cursor、模型输出格式和 Pi-native fallback。
- FFF 的原始结构化数据比模型所需文本丰富。保留需要渲染或后续定位的字段到 `details`；只将有界文本写入 `content`。

## 上游与版本

研究基线：

| 项目 | 值 |
| --- | --- |
| Node package | `@ff-labs/fff-node@0.10.3` |
| 上游仓库 | <https://github.com/dmtrKovalenko/fff> |
| SDK 类型 | <https://github.com/dmtrKovalenko/fff/blob/v0.10.3/packages/fff-node/src/fff-api.ts> |
| 原生实现 | Rust；Node 通过 FFI 调用平台二进制 |

在设计或实现前，先查正在使用的 package 版本的 TypeScript 类型。FFF API 变化较快；不能以本记录替代运行时类型检查。

## 心智模型

```text
Pi tool call
  -> extension 验证 input 与索引 root
  -> FileFinder（session-scoped）
       -> 初始 scan / 持续 watcher（按配置）
       -> 内存/索引内容搜索
       -> 返回结构化 GrepResult
  -> extension
       -> content：模型可读、有界文本
       -> details：命中 range、cursor、统计等结构化数据
  -> Pi ToolExecutionComponent / 自定义 renderer
```

`FileFinder` 对一个 `basePath` 持有独立 native index。它可以：

- `fileSearch()`：按 fuzzy/frecency 搜文件。
- `glob()`：按 glob 过滤索引文件。
- `grep()`：在索引文件内容中检索。
- `multiGrep()`：多 pattern OR 搜索。
- `scanFiles()`、`waitForScan()`：触发或等待索引。
- `watch()`：`0.10.3` 新增的可选文件变更订阅。它返回 unsubscribe 函数；extension 注册后必须在 session shutdown 前调用该函数，或依赖 `finder.destroy()` 的兜底清理。默认不需要它。
- `destroy()`：释放 native 资源并停止 watcher。

`0.10.3` 还增加 `InitOptions.followSymlinks`。它与 `watch()` 都扩大索引或常驻资源范围；默认保持关闭或不注册 watcher，只有明确需要时才启用。

FFF 的性能模型是“先建索引，后重复查询”。首次 scan 有成本；小型、一次性或范围受限查询不一定比直接 `rg` 更合适。

## `grep()` 的输入

```ts
const result = finder.grep(pattern, {
  mode: "plain" | "regex" | "fuzzy",
  smartCase: true,
  maxMatchesPerFile: 20,
  cursor: previousCursor ?? null,
  beforeContext: 1,
  afterContext: 3,
  pageSize: 20,
  timeBudgetMs: 0,
  classifyDefinitions: false,
});
```

- `plain`：字面匹配；适合普通代码搜索。
- `regex`：regex 匹配；编译失败时 FFF 可回退 literal，并在 result 写入 `regexFallbackError`。
- `fuzzy`：行级模糊匹配；它不是 `rg` 语义，不能无损降级为 ripgrep。
- `smartCase`：全小写 query 默认忽略大小写；包含大写时敏感。
- `cursor`：不透明分页 token。只能继续同一 query/选项；不可拼接、持久化为通用字符串或跨 session 复用。
- `timeBudgetMs`：FFF 可在时间预算耗尽时返回部分结果。`@ff-labs/fff-node@0.10.3` 的公开 `GrepOptions` 没有 `AbortSignal`；Pi extension 应设置时间预算，并在 Pi turn 已取消时丢弃或不再显示迟到结果。它不能宣称拥有即时 hard cancellation。

FFF 按 frecency 顺序逐文件搜索，而不是 `rg` 的文件系统遍历顺序。因此相同 pattern 的首屏结果可以不同。

## `GrepMatch`：结构化命中

FFF `grep()` 成功时返回 `Result<GrepResult>`。每个 `items[]` 元素包含：

```ts
{
  relativePath: "packages/pi-ext-tools/src/index.ts",
  lineNumber: 42,                  // 1-based
  col: 16,                         // 首个命中的 0-based byte column
  byteOffset: 1234,                // 文件内该行起始的 absolute byte offset
  lineContent: "export function registerGrep(...) ",
  matchRanges: [[16, 20]],         // lineContent 内每个命中的 [start, end) byte range
  contextBefore: ["..."],
  contextAfter: ["..."],
  // 还包括 fileName、gitStatus、size、modified、frecency 分数、isBinary
}
```

关键语义：

- `matchRanges` 是 FFF 已计算好的全部命中 range，适合 TUI 精确高亮。
- `col` 只有首个命中位置；需要标注全部命中时使用 `matchRanges`。
- `byteOffset` 指向文件中的行起点，适合预览或再次读取时快速定位。
- range 和 offset 都是 **byte**，不是 JavaScript UTF-16 string index，也不是 terminal cell width。包含 Unicode 时，不能直接用 `string.slice(start, end)`。
- `lineContent` 可能被 FFF 截断。range 仅保证相对于返回的 `lineContent` 有意义；它不是完整文件行的永久坐标。
- context 是独立字符串数组，不含命中 metadata。formatter 要自己决定是否显示、何时隐藏或合并重复 context。

典型 renderer 策略：以 byte-safe helper 将 `matchRanges` 切片并包 ANSI style；不要重新以 pattern 搜索 `lineContent`。重新搜索会在 regex、smart-case、fuzzy、重复命中和 fallback 情况下漂移。

## `GrepResult`：页和状态

```ts
{
  items: GrepMatch[],
  totalMatched: number,
  totalFilesSearched: number,
  totalFiles: number,
  filteredFileCount: number,
  nextCursor: GrepCursor | null,
  regexFallbackError?: string,
}
```

`nextCursor !== null` 表示还有候选文件尚未搜索。extension 应把 opaque cursor 放入 session-scoped cursor store，并返回一个自己的短 id；模型不应获得 FFF 内部 cursor 对象。

```text
FFF nextCursor
  -> extension cursor store: fff_c42 -> opaque FFF object
  -> tool result notice: cursor="fff_c42"
  -> 下一次 tool call 验证 query/options
  -> cursor store.get("fff_c42")
  -> finder.grep(..., { cursor })
```

cursor store 应限制容量、在 session shutdown 清理，并拒绝过期、未知、跨 query 或跨 root 的 cursor。

## FFF、rg 与模型文本

`rg --json` 的 raw match event 也有精确区段：`submatches[].start/end`。两者语义接近，但载体不同：

| 面向 | FFF | Pi 原生 `rg --json` |
| --- | --- | --- |
| 传递 | 一次性 JS `Result<GrepResult>` | stdout NDJSON stream |
| 精确范围 | `matchRanges` | `submatches[].start/end` |
| 行定位 | `lineNumber`、`col`、`byteOffset` | `line_number`、`absolute_offset` |
| 排序 | frecency/index order | ripgrep traversal order |
| 分页 | `nextCursor` | Pi limit 后停止 child process |
| regex 失败 | 可 literal fallback + error field | stderr/nonzero exit |
| fuzzy | 支持 | 不支持 |

两者都可格式化成模型常见的：

```text
path:line: text
path-line- context
```

此文本格式不是原始数据格式。文本只应作为 `content`；range、offset、cursor 和完整统计保留到 `details`。Pi 会持久化两者，但只有最终 `content` 进入下一次模型请求。

## Pi / `pi-ext-tools` 集成边界

Pi host 管理 tool call、session message、TUI shell 与最终结果 middleware。extension 管理 FFF 资源和语义：

| 责任 | owner |
| --- | --- |
| tool schema、输入验证、search root admission | concrete extension |
| finder create / scan / destroy、watcher cleanup | concrete extension |
| FFF cursor 与查询一致性 | concrete extension |
| FFF result -> `content` / `details` | concrete extension |
| Pi-native `rg` / `fd` fallback | Pi host，经 extension 显式调用 |
| call/result row 生命周期 | Pi host `ToolExecutionComponent` |
| FFF range highlight | concrete extension renderer |

本仓库的具体工具边界和默认值见 [FFF 搜索](tools/fff-search.md)。它与第三方 Pix 的 `pix-grep` 不是同一个实现。

## Pix `pix-grep`：可复用经验与缺口

`pix-grep` 是第三方 Pi extension。它在无 `path`、无 `glob` 时优先 FFF；否则委派 Pi 原生 `grep`。其经验：

- FFF 不可用时，保留 `origGrep.execute()` 作为透明 fallback。
- FFF 初始化、index timeout 和 partial index 必须向用户可见。
- FFF 与原生结果都应使用同一类 `details`，让 renderer 不依赖 backend。

其当前实现没有使用 FFF 的 `matchRanges`、`col` 或 `byteOffset`，而是立刻格式化为纯文本。它还会生成 cursor notice，却在下一次查询固定传 `cursor: null`；因此其宣称的 FFF grep 分页不可用。不要复制该 cursor 模式。

## 实现检查表

1. 这次查询是否值得启动/复用索引，还是直接 `rg` 更快、更完整？
2. root、path、glob、exclude、binary 与文件大小限制是否被验证？
3. 查询是否有明确 `timeBudgetMs`，且 Pi turn 取消后不会接纳迟到结果？`fff-node@0.10.3` 没有公开 hard-cancel 参数。
4. `content` 是否有 Pi output 上限，`details` 是否保留 renderer 所需范围？
5. cursor 是否 session-scoped、query-bound、有限容量，并真的传回 `finder.grep()`？
6. 无 FFF、partial index、scan timeout、Unicode/path constraint、renderer failure 时的可见 fallback 是什么？
7. byte range 是否用 byte-safe 方法处理，且 ANSI/cell-width 不影响 range 计算？

优先复用 Pi 原生工具和已存在的 `pi-ext-tools` runtime；只有明确需要索引、frecency、fuzzy 或精确结构化 range 时才增加 FFF 路径。
