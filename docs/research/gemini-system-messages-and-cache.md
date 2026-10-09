# Gemini 与 OpenAI：系统指令、动态工具与缓存

调研日期：2026-10-05。证据来自 OpenAI、Google 官方文档，以及本机安装的 Pi AI 1.0.2；接口接受与缓存效果需区分，官方文档不能证明第三方代理的实际实现。

## 结论

“GPT 支持、Gemini 不支持”过于宽泛。已经确认的差异是：OpenAI Responses 可以在历史中使用 developer/system 消息；Gemini 原生 generateContent 的对话历史只有 user/model，系统指令是独立请求字段。Gemini 可以每次请求改变系统指令，但原生接口没有同等的“在历史某个位置追加高优先级指令”契约。官方没有解释这种选择背后的训练或内部模型架构原因。[1][2]

当前 Gemini Interactions API 已提供另一条官方多轮会话路径；它仍将系统指令作为当前 interaction 的配置，文档没有承诺改变该字段后保留之前的缓存。[6]

## 官方接口差异

### OpenAI

官方文本生成指南明确说明 developer 消息是应用开发者的指令，优先于 user 消息；多轮对话可以包含多条这些类型的消息。顶层 instructions 只适用于当前响应生成，不会因为 previous_response_id 自动继承，不能把它与历史 developer 消息混为一谈。[1]

缓存指南推荐：

> “Append new messages rather than rewriting earlier turns.”

同一指南建议把动态 developer instructions 或共享材料放到后面，或放进后续对话消息。支持中途更新使应用可以保留原有前缀，但不能保证每次命中缓存；消息边界、缓存最小长度、保留时间与工具配置仍然影响结果。[3]

### Gemini generateContent

官方 REST 的 Content.role 定义：

> “Must be either 'user' or 'model'.”

systemInstruction 是与 contents 并列的请求字段，定义为开发者设置的系统指令。Google Cloud 官方说明系统指令在 prompts 之前处理，设置后适用于整个请求，跨请求包含的多个 user/model turns 生效。[2][8]

因此，更改 systemInstruction 是更新当前请求的配置，不等于在历史中追加 developer 消息。把指导写进 user 文本或 function response 可以作为对话内容追加，但其指令优先级不等同于 systemInstruction。这种做法适合能力使用指南，稳定的基础规则仍应放在固定系统指令中。

### Gemini OpenAI 兼容接口

Google 官方示例接受 messages 中的 system role，并支持通过 extra_body 使用 cached_content。但该页面没有明确保证：把 system/developer 插在历史中间会保留原位置、高优先级语义和缓存前缀。因此不能仅凭 OpenAI 格式兼容就把它认定为原生中途系统指令支持。[7]

## 官方提供的缓存方案

| 方案 | 官方明确的行为 | 适用范围与限制 |
| --- | --- | --- |
| Gemini 隐式缓存 | Gemini 2.5 及以后默认启用；建议公共大段内容放在开头，短时间内发送具有相似前缀的请求 | 不保证命中或成本节省；应稳定 systemInstruction、工具定义和历史。当前文档列出 Gemini 3.8 Flash 最小缓存长度为 4,096 tokens。[4] |
| Gemini 显式缓存 | 创建固定内容一次，后续用 cachedContent 引用；缓存内容作为 prompt 前缀 | 有存储费用、TTL 和最小长度。缓存的内容、systemInstruction、tools、toolConfig 不可修改；patch 只能更新到期时间。改变固定配置需创建新缓存，不能原地替换系统指令。[4][5] |
| Gemini Interactions API | previous_interaction_id 保留服务端会话历史；官方说更容易利用隐式缓存、提高命中率 | system_instruction、tools、generation_config 是 interaction-scoped，想继续使用需每次重新指定。改变它们后保留缓存没有官方保证；指南当前列出显式缓存尚未提供。[6] |
| OpenAI 动态工具追加 | tool search / defer_loading 把发现的工具追加到上下文末尾；additional_tools 可在指定历史位置添加工具 | 原生 tool_search 文档要求 GPT-5.4 及以后；保留工具加载历史和位置，修改先前加载的工具集合会破坏该位置之后的缓存。第三方 endpoint 需要验证。[9] |

OpenAI 还推荐保持顶层 tools 定义、顺序和 schema 稳定，用 allowed_tools 限定当前允许的工具，而不是不断增删定义。系统指令追加能力与工具追加能力是两个独立契约。[3][9]

Interactions 概览的渲染页面说明截至 2026 年 6 月已 GA，并推荐新项目使用；但同一指南的 `.md.txt` 版本仍写 Beta、preview 和 early beta stage，官方文档存在状态不一致。稳定 v1 参考存在，但其模型枚举目前止于 gemini-3.7-flash，不能据此确认 gemini-3.8-flash 支持 v1 Interactions。具体模型、接口版本和代理能力仍需验证；generateContent 仍受到支持。[6][10]

## 与当前 Pi 和该 session 的关系

本机 Pi AI 1.0.2 的 google-shared.js 在转换会话时直接调用 collapseSystemMessages；google-generative-ai.js 从合并后的初始 system message 生成 systemInstruction，并将当前工具目录放到请求配置。这符合 generateContent 的接口结构。

OpenAI Responses 适配器分别提供 supportsMidConvoSystemMessages 与 supportsAdditionalTools / supportsToolSearch。前者控制系统消息是否保留在历史中；后两者控制是否把新增工具转换为 additional_tools 或工具搜索结果。本机自定义 openai-responses 适配器对这些开关默认均为 false。不能因前者已经启用就推断后两者也启用或 endpoint 支持。

该 session 的 gm / gemini-3.8-flash 使用 google-generative-ai，baseUrl 主机为 api.hheei.cc。gemini-3.8-flash 出现在当前 Google 官方文档，但代理是否实现 Interactions、显式缓存或兼容接口的全部语义，本次未实测。

当前修复适合现有路径：保持 hindsight-preamble 稳定，把父会话子代理协作指南放进 subagent_enable 的工具结果，避免按需启用能力时改写系统规则。它没有使 Gemini 获得中途 system 消息能力，也不能消除 compaction 或工具目录变化的缓存影响。

后续优先级：先实测固定前缀与当前修复的缓存结果；若需要可控的固定大前缀成本，再评估显式缓存；若要改造多轮 provider 路径，再评估官方 Interactions。后两项需要接口支持、状态 ownership、resume/fork 和存储生命周期设计，不是修改一个 compatibility 标志即可完成。

## 来源

1. [OpenAI：Text generation / Message roles and instruction following](https://developers.openai.com/api/docs/guides/text)
2. [Google：generateContent API，Content 与 systemInstruction](https://ai.google.dev/api/generate-content)；[完整 Markdown 参考](https://ai.google.dev/api/generate-content.md.txt)
3. [OpenAI：Prompt caching，Preserve conversation history / Manage tools with append-only updates](https://developers.openai.com/api/docs/guides/prompt-caching)
4. [Google：generateContent Context caching](https://ai.google.dev/gemini-api/docs/generate-content/caching)
5. [Google：CachedContent API，immutable 字段与 patch 限制](https://ai.google.dev/api/caching)
6. [Google：Interactions API，state management / cache hit rate / limitations](https://ai.google.dev/gemini-api/docs/interactions)
7. [Google：OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)
8. [Google Cloud：Use system instructions](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/prompts/system-instructions)
9. [OpenAI：Tool search，caching / additional_tools](https://developers.openai.com/api/docs/guides/tools-tool-search)
10. [Google：Interactions stable v1 reference](https://ai.google.dev/api/interactions-api-v1)；[迁移指南](https://ai.google.dev/gemini-api/docs/migrate-to-interactions)

## 验证范围

本次核对官方文档、检查本机 provider 转换源码与配置，未执行付费模型探测，未改变 provider 配置或运行时代码。仅新增研究文档与导航链接，无需 TypeScript 编译或测试。文档建议中的缓存效果和代理兼容能力尚待实际验证。
