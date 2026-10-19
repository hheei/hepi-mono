// Keep worker imports lean: the ext-core barrel adds ~220ms of startup per update.
import { parentPort, workerData } from "node:worker_threads";
import { errorMessage } from "@hheei/pi-ext-core/errors";
import type { JsDiffUpdateInput } from "./jsdiff-matching.js";

try {
	// Node runs source workers directly in tests, without Vite's .js -> .ts resolution.
	const matchingUrl = new URL(
		import.meta.url.endsWith(".ts") ? "./jsdiff-matching.ts" : "./jsdiff-matching.js",
		import.meta.url,
	);
	const { prepareJsDiffUpdate }: typeof import("./jsdiff-matching.js") = await import(
		matchingUrl.href
	);
	parentPort?.postMessage({
		kind: "result",
		value: prepareJsDiffUpdate(workerData as JsDiffUpdateInput),
	});
} catch (error) {
	parentPort?.postMessage({ kind: "error", message: errorMessage(error) });
} finally {
	parentPort?.close();
}
