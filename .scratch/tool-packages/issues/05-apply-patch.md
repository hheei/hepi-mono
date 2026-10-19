# 05: 独立 apply-patch 扩展

**What to build:** 独立安装 pi-apply-patch 后可解析和发布补丁，与基础文件工具保持互斥。

**Blocked by:** 01: 共享写入锁与文件工具去耦

**Status:** ready-for-agent

- [ ] 新包拥有解析、匹配、Worker、发布、设置和错误 hooks。
- [ ] 保留参数、details、默认激活和设置 group。
- [ ] Worker 在源码与构建产物中可启动，保留文件安全与取消测试。
- [ ] 不依赖 pi-ext-tools 或 pi-ext-ui。
