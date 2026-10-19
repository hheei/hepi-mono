# 02: 独立 Python eval 扩展

**What to build:** 独立安装 pi-python-eval 后可计算并通过 Pi host 调用已安装且激活的允许工具。

**Blocked by:** None (can start immediately)

**Status:** done

- [x] 恰有一个 extension 入口，无具体 extension 依赖。
- [x] 删除直接 ToolDefinition 执行 fallback，保留允许列表、active 检查、trace、structuredContent、错误与取消。
- [x] 保留设置 group、details format、kernel 生命周期，打包 child.py。
- [x] 迁移所有 eval 测试并验证缺少工具和 host 拒绝。
