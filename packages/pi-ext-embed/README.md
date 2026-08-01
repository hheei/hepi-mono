# @hheei/pi-ext-embed

纯运行时 embedding provider 包。它不注册 Pi extension、工具、命令、lifecycle 或 scheduler。

```ts
import { acquireEmbeddingProvider } from "@hheei/pi-ext-embed";

const lease = await acquireEmbeddingProvider({ provider: "local" });
if (lease !== undefined) {
	const vector = await lease.provider.embed("文本", "query", AbortSignal.timeout(10_000));
	await lease.release();
}
```

`local` 是默认值，按进程复用模型 pipeline。`cacheDir` 是宿主拥有的模型缓存目录；文件锁只串行跨进程下载和初始化，
不会跨进程共享内存模型。`synapse` 必须显式配置 connection file、project root 与 session。provider 不可用或调用被取消时返回
`undefined`；配置和输入错误会抛出。
