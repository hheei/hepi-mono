import { expect, test } from "bun:test";
import {
	createExtensionPointKey,
	openExtensionPoint,
	registerExtensionHook,
} from "../src/index.js";
import { createFakePiHost } from "./fixtures.js";

interface FormatterHook {
	readonly name: string;
}

const formatter = createExtensionPointKey<FormatterHook>("@hheei/pi-tools/formatter");

test("delivers existing and late hooks to the single owner", async () => {
	const host = createFakePiHost();
	const controller = new AbortController();
	const calls: string[] = [];
	const existing = registerExtensionHook(host.pi, formatter, { name: "existing" });
	await existing.ready;
	const owner = openExtensionPoint(host.pi, formatter, {
		signal: controller.signal,
		onAdd: (hook) => {
			calls.push(`add:${hook.name}`);
		},
		onRemove: (hook) => {
			calls.push(`remove:${hook.name}`);
		},
	});
	await owner.ready;
	const late = registerExtensionHook(host.pi, formatter, { name: "late" });
	await late.ready;
	await late.dispose();

	expect(calls).toEqual(["add:existing", "add:late", "remove:late"]);
	controller.abort();
	await existing.dispose();
	await owner.dispose();
});

test("keeps a failing hook registration disposable", async () => {
	const host = createFakePiHost();
	const registration = registerExtensionHook(host.pi, formatter, { name: "broken" });
	const owner = openExtensionPoint(host.pi, formatter, {
		signal: new AbortController().signal,
		onAdd: () => {
			throw new Error("install failed");
		},
		onRemove: () => undefined,
	});

	await expect(owner.ready).rejects.toThrow("install failed");
	await expect(registration.dispose()).resolves.toBeUndefined();
	await owner.dispose();
});

test("observes a rejected ready Promise without a host unhandled rejection", async () => {
	const host = createFakePiHost();
	const registration = registerExtensionHook(host.pi, formatter, { name: "broken" });
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown): void => {
		unhandled.push(reason);
	};
	process.on("unhandledRejection", onUnhandled);
	try {
		const owner = openExtensionPoint(host.pi, formatter, {
			signal: new AbortController().signal,
			onAdd: () => {
				throw new Error("install failed");
			},
			onRemove: () => undefined,
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(unhandled).toEqual([]);
		await owner.dispose();
		await registration.dispose();
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("does not invoke a queued remove after owner abort", async () => {
	const host = createFakePiHost();
	const controller = new AbortController();
	let release: (() => void) | undefined;
	const entered = new Promise<void>((resolve) => {
		release = resolve;
	});
	const registration = registerExtensionHook(host.pi, formatter, { name: "queued" });
	const calls: string[] = [];
	const owner = openExtensionPoint(host.pi, formatter, {
		signal: controller.signal,
		onAdd: async () => {
			calls.push("add");
			await entered;
		},
		onRemove: () => {
			calls.push("remove");
		},
	});
	await Promise.resolve();
	const removing = registration.dispose();
	controller.abort();
	if (release === undefined) throw new Error("Expected queued add release");
	release();
	await removing;
	await owner.ready;

	expect(calls).toEqual(["add"]);
	await owner.dispose();
});

test("rejects a duplicate owner", () => {
	const host = createFakePiHost();
	openExtensionPoint(host.pi, formatter, {
		signal: new AbortController().signal,
		onAdd: () => undefined,
		onRemove: () => undefined,
	});

	expect(() =>
		openExtensionPoint(host.pi, formatter, {
			signal: new AbortController().signal,
			onAdd: () => undefined,
			onRemove: () => undefined,
		}),
	).toThrow();
});
