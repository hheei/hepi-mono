import { afterEach, expect, test } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createOutputRegistry } from "@hheei/pi-ext-core";
import { registerBashJobTool } from "../src/bash-job-tool.js";
import { BashJobRegistry, MAX_JOB_OUTPUT } from "../src/bash-jobs.js";
import { createFffRuntimeState } from "../src/fff/lifecycle.js";

const registries: BashJobRegistry[] = [];

afterEach((): void => {
	for (const registry of registries.splice(0)) registry.dispose();
});

async function eventually<T>(
	read: () => T | undefined,
	predicate: (value: T) => boolean,
): Promise<T> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const value = read();
		if (value !== undefined && predicate(value)) return value;
		await Bun.sleep(10);
	}
	throw new Error("job did not reach expected state");
}

test("retains bounded combined output and reports completion", async (): Promise<void> => {
	const registry = new BashJobRegistry();
	registries.push(registry);
	const started = registry.start("yes x | head -c 1100000", process.cwd());
	expect(() => structuredClone(started)).not.toThrow();
	const completed = await eventually(
		() => registry.get(started.id),
		(job) => job.status !== "running",
	);
	expect(completed.status).toBe("completed");
	expect(completed.truncated).toBe(true);
	expect(Buffer.byteLength(completed.output)).toBeLessThanOrEqual(MAX_JOB_OUTPUT);
});

test("publishes completed output as an output without triggering a turn", async (): Promise<void> => {
	const outputs = createOutputRegistry();
	const messages: unknown[] = [];
	const registry = new BashJobRegistry({
		outputs,
		pi: {
			sendMessage(
				message: Parameters<ExtensionAPI["sendMessage"]>[0],
				options?: Parameters<ExtensionAPI["sendMessage"]>[1],
			): void {
				messages.push({ message, options });
			},
		} as unknown as ExtensionAPI,
	});
	registries.push(registry);
	const started = registry.start("printf output-output", process.cwd());
	const completed = await eventually(
		() => registry.get(started.id),
		(job) => job.status === "completed" && job.outputOutput !== undefined,
	);
	expect(completed.outputOutput).toMatch(/^output:\/\/[1-9]\d*$/);
	expect(outputs.read(completed.outputOutput ?? "")).toBe("output-output");
	expect(messages).toEqual([expect.objectContaining({ options: { triggerTurn: false } })]);
	outputs.dispose();
});

test("stops an owned process group", async (): Promise<void> => {
	const registry = new BashJobRegistry();
	registries.push(registry);
	const started = registry.start("sleep 10", process.cwd());
	const stopped = registry.stop(started.id);
	expect(stopped?.status).toBe("stopped");
	await eventually(
		() => registry.get(started.id),
		(job) => job.status === "stopped",
	);
});

test("honors an async timeout", async (): Promise<void> => {
	const registry = new BashJobRegistry();
	registries.push(registry);
	const started = registry.start("sleep 10", process.cwd(), undefined, 25);
	const stopped = await eventually(
		() => registry.get(started.id),
		(job) => job.status === "stopped",
	);
	expect(stopped.timedOut).toBe(true);
});

test("bash_job reports unavailable before session start", async (): Promise<void> => {
	const tools: ToolDefinition[] = [];
	registerBashJobTool(
		{
			registerTool(tool: ToolDefinition): void {
				tools.push(tool);
			},
		} as unknown as ExtensionAPI,
		createFffRuntimeState(),
	);
	const tool = tools[0];
	if (tool === undefined) throw new Error("bash_job was not registered");
	expect(tool.parameters).toMatchObject({
		additionalProperties: false,
		required: ["action", "id"],
	});
	const result = await tool.execute(
		"bash-job-1",
		{ action: "status", id: "missing" },
		undefined,
		undefined,
		{} as ExtensionContext,
	);
	expect(result.content).toEqual([{ type: "text", text: "No active Bash job session" }]);
});
