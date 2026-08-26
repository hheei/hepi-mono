import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";

const db = new Database(":memory:");
db.exec("CREATE TABLE smoke (value INTEGER); INSERT INTO smoke VALUES (7)");
const row = db.query("SELECT value FROM smoke").get() as { value?: number };
if (row.value !== 7) throw new Error(`bun:sqlite smoke failed: ${String(row.value)}`);
db.close();

const cwd = resolve(import.meta.dirname, "../packages/pi-ext-tools");
const child = spawn("bun", ["src/eval/kernel/child.ts"], {
	cwd,
	stdio: ["pipe", "pipe", "pipe"],
});
let buffer = "";
let sent = false;
const stderr: string[] = [];
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk: string) => stderr.push(chunk));
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk: string) => {
	buffer += chunk;
	for (;;) {
		const newline = buffer.indexOf("\n");
		if (newline < 0) return;
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		if (!line.trim()) continue;
		const message = JSON.parse(line) as { type: string; ok?: boolean; value?: unknown };
		if (message.type === "ready" && !sent) {
			sent = true;
			child.stdin.write(
				`${JSON.stringify({ type: "execute", cellId: "bun-smoke", code: "1 + 2" })}\n`,
			);
			continue;
		}
		if (message.type === "done") {
			if (!message.ok || message.value !== 3) {
				throw new Error(`Bun Eval smoke failed: ${line}`);
			}
			child.kill();
		}
	}
});

const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
const [result] = await once(child, "exit");
clearTimeout(timer);
if (result !== null && result !== 0 && stderr.length > 0) {
	throw new Error(`Bun Eval smoke exited with ${String(result)}: ${stderr.join("")}`);
}
console.log("Bun compatibility smoke passed: bun:sqlite and Eval JavaScript");
