# 06｜Settings TUI：model、controller、component 与渲染

## 目标

实现第一版真正可用的 Settings module。先完成纯 model/controller，再接 Pi TUI component；不要把 provider domain logic 硬编码进 UI。

## Model 状态

必须区分：

- provider snapshot：当前 provider、groups、fields、panels 的稳定快照。
- selection identity：保存 `providerId`/`itemId`，filter、排序、tab 切换后按 id 恢复，不只保存 index。
- UI mode：`Navigation | Edit`。
- `committedValue`：列表永远显示的已提交值。
- `draftValue`：只在 Edit editor 显示；成功提交后才更新 provider state。
- search query、collapsed group ids、scroll viewport、error message。

## Navigation/Edit 行为

Navigation：

- ↑/↓ 移动 selection。
- ←/→ 切换 module/provider tab。
- Enter：boolean 直接 toggle；其他类型进入 Edit。
- Esc：关闭面板。

Edit：

- text 修改 draft。
- ←/→ 移动 cursor；Home/End 移到首尾。
- Enter：调用唯一 `parse`，再 validate/save。
- Esc：丢弃 draft，回 Navigation，不改变 committed value。

失败时必须保留 committed value、selection、面板和 draft，并显示可读错误。必须处理 parser exception、`NaN`、无效 enum/options。

## Controller 行为

1. provider load：读取 storage，合并 defaults，调用 `onLoad`，生成 snapshot。
2. provider filter：只显示已注册且有内容的 provider；空 groups 和空 panels 的 provider 不显示。
3. boolean/option/text/number/path change：生成 typed change，并调用 provider `onChange`。
4. save：provider-level async queue；明确并发顺序、optimistic update、失败 rollback、错误保留。
5. close：调用 `onClose`，清理 pending queue、component listener 和临时 draft。
6. callback ordering 要固定且有测试，不能由 promise race 决定。

## Layout/render

宽模式：

- 顶部 module tabs/provider tabs；active tab 以开放底部、accent 和结构共同表达。
- 左侧无框列表；固定 indicator、key viewport、value 起点。
- 长 selected key 只在 key viewport 内水平滚动。
- 右侧 Description panel 用圆角边框、固定高度、word wrap，超出用 `...`。

窄模式：

- 隐藏 Description、Key metadata、description。
- 列表使用完整宽度。
- 下方固定两行 `Value:` 和 `> draft`；编辑只水平滚动，不增加高度。

Search/group/scroll：

- Settings 默认显示 search bar，可由 module option 关闭。
- 搜索实时更新；group title 不作为结果；收合 group 时，命中 child 仍可显示。
- 空结果显示 `No results found`。
- 只在超出 viewport 时显示 `↑`/`↓`，边界不显示错误方向。
- 过滤/selection/tab 后保留 item identity。

Footer：

- Navigation：`↑/↓ navigate · ←/→ tab · ↵ edit/toggle · ⎋ close`
- Edit：`↵ confirm · ⎋ cancel`
- 宽度不足从低优先级 hint 开始移除；hint 不使用 dim 误导为 disabled。

## 实现顺序

1. 写 model tests，再实现纯 transition/filter/parse 函数。
2. 写 controller tests，再实现 load/save/rollback。
3. 写 `value-editor`，覆盖 cursor 和 viewport。
4. 写 layout/render tests，至少一组窄宽度和一组宽宽度。
5. 最后写 component，负责输入路由、`requestRender`、`invalidate` 和关闭。

## 验收

- boolean Enter 一次完成 toggle；非 boolean 需要第二次 Enter 才提交。
- 编辑期间列表显示 committed value，draft 只出现在 editor。
- parse/save 失败不丢 selection、committed value 或 draft。
- search、group collapse、scroll、tab 切换均按 id 保留 selection。
- 所有 render line 通过 visible width 检查。
- component 只通过 Pi TUI render contract 输出，不直接 stdout。
