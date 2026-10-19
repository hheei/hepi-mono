# 04: 独立后台 Bash 扩展

**What to build:** 前台 bash 留在 pi-ext-tools；独立安装 pi-bg-bash 后后台命令、持久执行记录和报告交付形成完整路径。

**Blocked by:** None (can start immediately)

**Status:** done

- [x] 前台使用 Pi host 本地执行能力，保留超时、取消与进程树清理，不依赖后台包。
- [x] 后台 BashJobRegistry、runtime、账本、通知与清理由新包拥有。
- [x] 保留原 bash 配置及账本/日志位置、分支收据、unknown 和禁止自动重跑语义。
- [x] 工具名、默认激活、optional bullet、RTK 集成保持。
- [x] 迁移单测与真实进程集成测试。
