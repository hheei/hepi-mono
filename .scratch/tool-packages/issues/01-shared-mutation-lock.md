# 01: 共享写入锁与文件工具去耦

**What to build:** 文件工具独立于 Bash runtime，并与补丁工具共享同一写入锁协议。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] 共享锁归 ext-core，导入无副作用，保留现有 key/path 协议。
- [ ] 三个写入工具使用同一原语，等待取消和释放测试通过。
- [ ] 删除文件工具未使用的 Bash state 参数。
