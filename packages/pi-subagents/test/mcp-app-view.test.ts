import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { expect, test } from "vitest";

test("task card keeps its draft and stops polling after the receipt is terminal", async () => {
	const page = boot("task");
	const init = sentCall(page, "ui/initialize");
	page.reply(init.id, { hostContext: { theme: "dark" } });
	await tick();
	expect(page.window.document.documentElement.dataset.theme).toBe("dark");
	page.emit({
		jsonrpc: "2.0",
		method: "ui/notifications/tool-result",
		params: {
			structuredContent: {
				delegationId: "dep_1",
				childId: "child-1",
				status: "accepted",
				task: "Implement authentication middleware",
			},
		},
	});
	expect(page.window.document.querySelector("#title")?.textContent).toContain("Subagent");
	expect(page.window.document.querySelector("#task")?.textContent).toBe(
		"Implement authentication middleware",
	);
	const toggle = page.window.document.querySelector("#root button");
	expect(toggle?.getAttribute("aria-expanded")).toBe("false");
	toggle?.dispatchEvent(new page.window.Event("click", { bubbles: true }));
	expect(toggle?.getAttribute("aria-expanded")).toBe("true");
	expect(
		(page.window.document.querySelector(".detail-panel") as { hidden?: boolean } | null)?.hidden,
	).toBe(false);

	const draft = page.window.document.querySelector("#continue") as HTMLInputElement;
	draft.value = "keep this";
	draft.focus();
	page.flush(700);
	await tick();
	const get = sentCall(page, "tools/call");
	expect(get.params).toMatchObject({ name: "subagents_get", arguments: { id: "child-1" } });
	page.reply(get.id, {
		structuredContent: { id: "child-1", state: "running", activeTool: "vitest" },
	});
	await tick();
	const receipt = sentCall(page, "tools/call", 1);
	expect(receipt.params).toMatchObject({
		name: "subagents_receipt",
		arguments: { delegationId: "dep_1" },
	});
	page.reply(receipt.id, {
		structuredContent: { delegationId: "dep_1", status: "completed", resultText: "done" },
	});
	await tick();
	expect(page.window.document.querySelector("#continue")).toBe(draft);
	expect(draft.value).toBe("keep this");
	expect(page.window.document.querySelector("#output")?.textContent).toBe("done");
	expect(page.timers.some((item) => item !== null && item.ms === 2000)).toBe(false);
	expect(page.sent.filter(isCall).filter((call) => call.method === "tools/call")).toHaveLength(2);

	page.emit({ jsonrpc: "2.0", method: "ui/resource-teardown" });
	expect(page.timers.every((item) => item === null)).toBe(true);
});

test("steer rebinds the delegation and stop asks once", async () => {
	const page = boot("task");
	page.reply(sentCall(page, "ui/initialize").id, {});
	page.emit({
		jsonrpc: "2.0",
		method: "ui/notifications/tool-result",
		params: {
			structuredContent: {
				delegationId: "dep_1",
				childId: "child-1",
				status: "accepted",
				task: "first",
			},
		},
	});
	const draft = page.window.document.querySelector("#continue") as HTMLInputElement;
	draft.value = "next";
	const send = page.window.document.querySelector("#send") as HTMLButtonElement;
	send.dispatchEvent(new page.window.Event("click", { bubbles: true }));
	send.dispatchEvent(new page.window.Event("click", { bubbles: true }));
	const steer = page.sent.filter(isCall).filter((call) => call.method === "tools/call");
	expect(steer).toHaveLength(1);
	expect(steer[0]?.params).toMatchObject({
		name: "subagents_delegate",
		arguments: { id: "child-1", task: "next", wait: false },
	});
	page.reply(steer[0]?.id, {
		structuredContent: { delegationId: "dep_2", childId: "child-1", status: "accepted" },
	});
	await tick();
	page.flush(0);
	await tick();
	const again = sentCall(page, "tools/call", 1);
	expect(again.params).toMatchObject({ name: "subagents_get" });
	page.reply(again.id, { structuredContent: { id: "child-1", state: "running" } });
	await tick();
	const nextReceipt = sentCall(page, "tools/call", 2);
	expect(nextReceipt.params).toMatchObject({ arguments: { delegationId: "dep_2" } });

	const stop = [...page.window.document.querySelectorAll("button")].find(
		(button) => button.textContent === "Stop",
	);
	stop?.dispatchEvent(new page.window.Event("click", { bubbles: true }));
	expect(stop?.textContent).toBe("Confirm stop");
	expect(
		page.sent.filter(isCall).filter((call) => call.params?.name === "subagents_stop"),
	).toHaveLength(0);
	stop?.dispatchEvent(new page.window.Event("click", { bubbles: true }));
	expect(page.sent.filter(isCall).some((call) => call.params?.name === "subagents_stop")).toBe(
		true,
	);
});

test("dashboard keeps the filter and uses the catalog", async () => {
	const page = boot("dashboard");
	page.reply(sentCall(page, "ui/initialize").id, {});
	page.emit({
		jsonrpc: "2.0",
		method: "ui/notifications/tool-result",
		params: {
			structuredContent: {
				children: [
					{ id: "child-1", agent: "worker", state: "running", task: "auth" },
					{ id: "child-2", agent: "scout", state: "done", task: "read" },
				],
			},
		},
	});
	const catalog = sentCall(page, "tools/call");
	expect(catalog.params).toMatchObject({ name: "subagents_catalog" });
	page.reply(catalog.id, {
		structuredContent: {
			agents: [
				{ name: "worker", enabled: true },
				{ name: "scout", enabled: true },
			],
		},
	});
	await tick();
	const filter = page.window.document.querySelector("#filter") as HTMLInputElement;
	filter.value = "scout";
	filter.dispatchEvent(new page.window.Event("input", { bubbles: true }));
	expect(page.window.document.querySelectorAll("#list button")).toHaveLength(1);
	page.flush(700);
	const listed = sentCall(page, "tools/call");
	page.reply(listed.id, {
		structuredContent: {
			children: [
				{ id: "child-1", agent: "worker", state: "running", task: "auth" },
				{ id: "child-2", agent: "scout", state: "done", task: "read" },
			],
		},
	});
	await tick();
	expect(filter.value).toBe("scout");
	expect(page.window.document.querySelector("#agent")?.textContent).toContain("worker");
});

interface Call {
	id: number;
	method: string;
	params?: { name?: string; arguments?: Record<string, unknown> };
}

function boot(kind: "task" | "dashboard") {
	const html = readFileSync(new URL("../src/mcp/app.html", import.meta.url), "utf8")
		.replaceAll("{{VIEW}}", kind)
		.replaceAll("{{TITLE}}", kind);
	const { window } = parseHTML(html);
	const sent: unknown[] = [];
	const timers: Array<{ fn: TimerHandler; ms: number } | null> = [null];
	window.setTimeout = ((fn: TimerHandler, ms?: number) => {
		timers.push({ fn, ms: ms ?? 0 });
		return timers.length - 1;
	}) as typeof setTimeout;
	window.clearTimeout = ((id: number) => {
		timers[id] = null;
	}) as typeof clearTimeout;
	window.ResizeObserver = class {
		observe(): void {}
	} as unknown as typeof ResizeObserver;
	Object.defineProperty(window.document, "hidden", { value: false, configurable: true });
	window.parent = { postMessage: (data: unknown) => void sent.push(data) } as unknown as Window;
	const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
	const run = new Function(
		"window",
		"document",
		"navigator",
		"MessageEvent",
		"ResizeObserver",
		script,
	);
	run(window, window.document, window.navigator, window.MessageEvent, window.ResizeObserver);
	return {
		window,
		sent,
		timers,
		reply(id: number | undefined, result: unknown) {
			emit(window, { jsonrpc: "2.0", id, result });
		},
		emit(data: unknown) {
			emit(window, data);
		},
		flush(ms: number) {
			const index = timers.findIndex((item) => item !== null && item.ms === ms);
			const timer = index === -1 ? undefined : timers[index];
			if (timer === undefined || timer === null) throw new Error(`No timer at ${ms}`);
			timers[index] = null;
			if (typeof timer.fn === "function") timer.fn();
		},
	};
}

function emit(
	window: { dispatchEvent: (event: Event) => boolean; Event: typeof Event },
	data: unknown,
): void {
	const event = new window.Event("message");
	Object.defineProperty(event, "data", { value: data });
	Object.defineProperty(event, "source", { value: (window as unknown as Window).parent });
	window.dispatchEvent(event);
}

async function tick(): Promise<void> {
	for (let step = 0; step < 8; step += 1) await Promise.resolve();
}

function isCall(value: unknown): value is Call {
	return typeof value === "object" && value !== null && "method" in value && "id" in value;
}

function sentCall(page: { sent: unknown[] }, method: string, nth = 0): Call {
	const call = page.sent.filter(isCall).filter((item) => item.method === method)[nth];
	if (call === undefined) throw new Error(`Missing ${method} #${nth}`);
	return call;
}

test("dashboard refresh continues after switching children during an in-flight request", async () => {
	const page = boot("dashboard");
	page.reply(sentCall(page, "ui/initialize").id, {});
	const children = [
		{ id: "child-1", agent: "worker", state: "running", task: "auth" },
		{ id: "child-2", agent: "scout", state: "running", task: "read" },
	];
	page.emit({
		jsonrpc: "2.0",
		method: "ui/notifications/tool-result",
		params: { structuredContent: { children } },
	});
	page.reply(sentCall(page, "tools/call").id, { structuredContent: { agents: [] } });
	await tick();
	page.flush(700);
	const listed = sentCall(page, "tools/call", 1);
	expect(listed.params).toMatchObject({ name: "subagents_list" });
	const scout = [...page.window.document.querySelectorAll("#list button")].find((button) =>
		button.textContent?.includes("scout"),
	);
	scout?.dispatchEvent(new page.window.Event("click", { bubbles: true }));
	page.reply(listed.id, { structuredContent: { children } });
	await tick();
	page.flush(0);
	const again = sentCall(page, "tools/call", 2);
	expect(again.params).toMatchObject({ name: "subagents_list" });
	page.reply(again.id, { structuredContent: { children } });
	await tick();
	expect(sentCall(page, "tools/call", 3).params).toMatchObject({
		name: "subagents_get",
		arguments: { id: "child-2" },
	});
});

test("a transcript response for a previous child never overwrites the selected child", async () => {
	const page = boot("dashboard");
	page.reply(sentCall(page, "ui/initialize").id, {});
	page.emit({
		jsonrpc: "2.0",
		method: "ui/notifications/tool-result",
		params: {
			structuredContent: {
				children: [
					{ id: "child-1", agent: "worker", state: "done", task: "first" },
					{ id: "child-2", agent: "scout", state: "done", task: "second" },
				],
			},
		},
	});
	const buttons = page.window.document.querySelectorAll("#list button");
	buttons[0]?.dispatchEvent(new page.window.Event("click", { bubbles: true }));
	const transcriptTab = [...page.window.document.querySelectorAll(".tabs button")].find(
		(button) => button.textContent === "Transcript",
	);
	transcriptTab?.dispatchEvent(new page.window.Event("click", { bubbles: true }));
	const first = page.sent
		.filter(isCall)
		.find((call) => call.params?.name === "subagents_transcript");
	expect(first?.params?.arguments?.id).toBe("child-1");
	buttons[1]?.dispatchEvent(new page.window.Event("click", { bubbles: true }));
	page.reply(first?.id, { structuredContent: { id: "child-1", entries: [{ old: "first" }] } });
	await tick();
	expect(page.window.document.querySelector("#transcript")?.textContent).not.toContain("first");
	const second = page.sent
		.filter(isCall)
		.filter((call) => call.params?.name === "subagents_transcript")[1];
	expect(second?.params?.arguments?.id).toBe("child-2");
});

test("a late steer reply cannot rebind the card after selecting another child", async () => {
	const page = boot("dashboard");
	page.reply(sentCall(page, "ui/initialize").id, {});
	page.emit({
		jsonrpc: "2.0",
		method: "ui/notifications/tool-result",
		params: {
			structuredContent: {
				children: [
					{ id: "child-1", agent: "worker", state: "running", task: "first" },
					{ id: "child-2", agent: "scout", state: "running", task: "second" },
				],
			},
		},
	});
	const buttons = page.window.document.querySelectorAll("#list button");
	buttons[0]?.dispatchEvent(new page.window.Event("click", { bubbles: true }));
	const draft = page.window.document.querySelector("#continue") as HTMLInputElement;
	draft.value = "steer first";
	(page.window.document.querySelector("#send") as HTMLButtonElement).dispatchEvent(
		new page.window.Event("click", { bubbles: true }),
	);
	const steer = page.sent.filter(isCall).find((call) => call.params?.name === "subagents_delegate");
	expect(steer?.params?.arguments?.id).toBe("child-1");
	buttons[1]?.dispatchEvent(new page.window.Event("click", { bubbles: true }));
	page.reply(steer?.id, {
		structuredContent: {
			childId: "child-1",
			delegationId: "dep-old",
			status: "accepted",
			task: "steer first",
		},
	});
	await tick();
	expect(page.window.document.querySelector("#task")?.textContent).toBe("second");
	expect(page.window.document.querySelector("#diagnostics")?.textContent).not.toContain("dep-old");
});

test("teardown prevents later visibility or async results from restarting polling", async () => {
	const page = boot("task");
	page.reply(sentCall(page, "ui/initialize").id, {});
	page.emit({
		jsonrpc: "2.0",
		method: "ui/notifications/tool-result",
		params: {
			structuredContent: { childId: "child-1", delegationId: "dep-1", status: "accepted" },
		},
	});
	page.emit({ jsonrpc: "2.0", method: "ui/resource-teardown" });
	page.window.document.dispatchEvent(new page.window.Event("visibilitychange"));
	await tick();
	expect(page.timers.every((item) => item === null)).toBe(true);
});

test("dashboard uses the enabled catalog agent rather than a worker fallback", async () => {
	const page = boot("dashboard");
	page.reply(sentCall(page, "ui/initialize").id, {});
	page.emit({
		jsonrpc: "2.0",
		method: "ui/notifications/tool-result",
		params: {
			structuredContent: { children: [] },
		},
	});
	const start = page.window.document.querySelector(".create button") as HTMLButtonElement;
	expect(start.disabled).toBe(true);
	const catalog = sentCall(page, "tools/call");
	page.reply(catalog.id, { structuredContent: { agents: [{ name: "scout", enabled: true }] } });
	await tick();
	expect(start.disabled).toBe(false);
	// linkedom does not implement HTMLSelectElement.value; a real browser selects the first option.
	Object.defineProperty(page.window.document.querySelector("#agent"), "value", {
		value: "scout",
		configurable: true,
	});
	const newTask = page.window.document.querySelector("#new-task") as HTMLInputElement;
	newTask.value = "read the files";
	start.dispatchEvent(new page.window.Event("click", { bubbles: true }));
	const delegated = page.sent
		.filter(isCall)
		.find((call) => call.params?.name === "subagents_delegate");
	expect(delegated?.params?.arguments).toMatchObject({
		agent: "scout",
		task: "read the files",
		wait: false,
	});
});

test("host tool input shows an initial task and automatic theme clears the forced theme", async () => {
	const page = boot("task");
	page.reply(sentCall(page, "ui/initialize").id, { hostContext: { theme: "dark" } });
	await tick();
	page.emit({
		jsonrpc: "2.0",
		method: "ui/notifications/tool-input",
		params: {
			arguments: { agent: "worker", task: "new task before result" },
		},
	});
	expect(page.window.document.querySelector("#task")?.textContent).toBe("new task before result");
	page.emit({
		jsonrpc: "2.0",
		method: "ui/notifications/host-context-changed",
		params: { theme: "system" },
	});
	expect(page.window.document.documentElement.dataset.theme).toBeUndefined();
});

test("switching children clears an unsent draft and ignores an old stop reply", async () => {
	const page = boot("dashboard");
	page.reply(sentCall(page, "ui/initialize").id, {});
	page.emit({
		jsonrpc: "2.0",
		method: "ui/notifications/tool-result",
		params: {
			structuredContent: {
				children: [
					{ id: "child-1", agent: "worker", state: "running", task: "first" },
					{ id: "child-2", agent: "scout", state: "running", task: "second" },
				],
			},
		},
	});
	const buttons = page.window.document.querySelectorAll("#list button");
	buttons[0]?.dispatchEvent(new page.window.Event("click", { bubbles: true }));
	const draft = page.window.document.querySelector("#continue") as HTMLInputElement;
	draft.value = "private draft for first";
	const stop = [...page.window.document.querySelectorAll("button")].find(
		(button) => button.textContent === "Stop",
	);
	stop?.dispatchEvent(new page.window.Event("click", { bubbles: true }));
	stop?.dispatchEvent(new page.window.Event("click", { bubbles: true }));
	const stopCall = page.sent.filter(isCall).find((call) => call.params?.name === "subagents_stop");
	expect(stopCall?.params?.arguments?.id).toBe("child-1");
	buttons[1]?.dispatchEvent(new page.window.Event("click", { bubbles: true }));
	expect(draft.value).toBe("");
	page.reply(stopCall?.id, { structuredContent: { id: "child-1", state: "done", task: "first" } });
	await tick();
	expect(page.window.document.querySelector("#task")?.textContent).toBe("second");
});

test("long receipt output remains accessible after expanding the compact preview", async () => {
	const page = boot("task");
	page.reply(sentCall(page, "ui/initialize").id, {});
	const resultText = `full report: ${"x".repeat(1200)}`;
	page.emit({
		jsonrpc: "2.0",
		method: "ui/notifications/tool-result",
		params: {
			structuredContent: {
				childId: "child-1",
				delegationId: "dep-1",
				status: "completed",
				resultText,
			},
		},
	});
	expect(page.window.document.querySelector("#output")?.textContent?.length).toBeLessThan(
		resultText.length,
	);
	const show = [...page.window.document.querySelectorAll("button")].find(
		(b) => b.textContent === "Show all",
	);
	show?.dispatchEvent(new page.window.Event("click", { bubbles: true }));
	expect(page.window.document.querySelector("#output")?.textContent).toBe(resultText);
});

test("transcript pagination requests only the next page and preserves the earlier page", async () => {
	const page = boot("task");
	page.reply(sentCall(page, "ui/initialize").id, {});
	page.emit({
		jsonrpc: "2.0",
		method: "ui/notifications/tool-result",
		params: {
			structuredContent: { childId: "child-1", delegationId: "dep-1", status: "completed" },
		},
	});
	const transcript = [...page.window.document.querySelectorAll(".tabs button")].find(
		(button) => button.textContent === "Transcript",
	);
	transcript?.dispatchEvent(new page.window.Event("click", { bubbles: true }));
	const first = page.sent
		.filter(isCall)
		.find((call) => call.params?.name === "subagents_transcript");
	expect(first?.params?.arguments).toMatchObject({ id: "child-1", limit: 20 });
	page.reply(first?.id, {
		structuredContent: { id: "child-1", entries: [{ event: "first" }], nextCursor: 20 },
	});
	await tick();
	const more = [...page.window.document.querySelectorAll("button")].find(
		(b) => b.textContent === "More",
	);
	more?.dispatchEvent(new page.window.Event("click", { bubbles: true }));
	const second = page.sent
		.filter(isCall)
		.filter((call) => call.params?.name === "subagents_transcript")[1];
	expect(second?.params?.arguments).toMatchObject({ id: "child-1", cursor: 20, limit: 20 });
	page.reply(second?.id, { structuredContent: { id: "child-1", entries: [{ event: "second" }] } });
	await tick();
	expect(page.window.document.querySelector("#transcript")?.textContent).toBe(
		'{"event":"first"}\n{"event":"second"}',
	);
});

test("messages from a window other than the host are ignored", async () => {
	const page = boot("task");
	page.reply(sentCall(page, "ui/initialize").id, {});
	const event = new page.window.Event("message");
	Object.defineProperty(event, "source", { value: {} });
	Object.defineProperty(event, "data", {
		value: {
			jsonrpc: "2.0",
			method: "ui/notifications/tool-result",
			params: {
				structuredContent: { childId: "foreign", task: "should not display" },
			},
		},
	});
	page.window.dispatchEvent(event);
	expect(page.window.document.querySelector("#task")?.textContent).not.toContain(
		"should not display",
	);
});
