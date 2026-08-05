import { enqueueRetainJob, flushRetainQueue } from "../../extensions/queue/queue.ts";

const [mode, path, id] = process.argv.slice(2);
const job = {
  id,
  bankId: "b",
  createdAt: new Date().toISOString(),
  documentId: `doc-${id}`,
  updateMode: "append",
  item: { content: `raw-${id}`, context: "ctx", async: true, tags: ["source:pi"] },
  retries: 0,
};

if (mode === "enqueue") {
  await enqueueRetainJob(path, job);
} else if (mode === "flush") {
  await flushRetainQueue(path, {
    retain: async () => undefined,
    recall: async () => [],
    reflect: async () => ({}),
  });
} else {
  throw new Error(`Unknown mode ${mode}`);
}
