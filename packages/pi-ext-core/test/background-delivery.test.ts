import { expect, test, vi } from "vitest";
import { createBackgroundDelivery, getBackgroundDelivery } from "../src/background-delivery.js";
import type { RuntimeHost } from "../src/runtime-identity.js";

test("holds both channels until every source is done, then requests exactly one turn", async () => {
	const delivery = createBackgroundDelivery();
	let tasks = 2;
	let children = 1;
	let changed = () => {};
	const removeTasks = delivery.registerSource({
		activeCount: () => tasks,
		onChange: (listener) => {
			changed = listener;
			return () => {};
		},
	});
	const removeChildren = delivery.registerSource({
		activeCount: () => children,
		onChange: () => () => {},
	});
	const sent: boolean[] = [];
	let firstPending = true;
	let secondPending = true;
	const first = delivery.registerChannel({
		isIdle: () => true,
		hasPending: () => firstPending,
		flush: (wake) => {
			sent.push(wake);
			firstPending = false;
		},
	});
	const second = delivery.registerChannel({
		isIdle: () => true,
		hasPending: () => secondPending,
		flush: (wake) => {
			sent.push(wake);
			secondPending = false;
		},
	});
	first.request();
	second.request();
	await Promise.resolve();
	tasks = 0;
	changed();
	await Promise.resolve();
	expect(sent).toEqual([]);
	children = 0;
	changed();
	await Promise.resolve();
	expect(sent).toEqual([false, true]);
	changed();
	await Promise.resolve();
	expect(sent).toEqual([false, true]);
	first.dispose();
	second.dispose();
	removeTasks();
	removeChildren();
});

test("a busy parent receives every channel in its next step despite active work", async () => {
	const delivery = createBackgroundDelivery();
	delivery.registerSource({ activeCount: () => 10, onChange: () => () => {} });
	const sent: boolean[] = [];
	const channels = [0, 1].map(() =>
		delivery.registerChannel({
			isIdle: () => false,
			hasPending: () => true,
			flush: (wake) => sent.push(wake),
		}),
	);
	for (const channel of channels) channel.request();
	await Promise.resolve();
	expect(sent).toEqual([true, true]);
});

test("urgent help bypasses active work without producing two idle wakes", async () => {
	const delivery = createBackgroundDelivery();
	delivery.registerSource({ activeCount: () => 1, onChange: () => () => {} });
	const sent: boolean[] = [];
	const normal = delivery.registerChannel({
		isIdle: () => true,
		hasPending: () => true,
		flush: (wake) => sent.push(wake),
	});
	const urgent = delivery.registerChannel({
		isIdle: () => true,
		hasPending: () => true,
		flush: (wake) => sent.push(wake),
	});
	normal.request();
	urgent.request(true);
	await Promise.resolve();
	expect(sent).toEqual([true]);
});

test.each([
	"dispose",
	"abort",
])("never flushes a channel invalidated by a reentrant %s", async (reason) => {
	const delivery = createBackgroundDelivery();
	const flush = vi.fn();
	let active = true;
	let disposeNext = () => {};
	const first = delivery.registerChannel({
		isIdle: () => true,
		hasPending: () => true,
		flush: () => disposeNext(),
	});
	const next = delivery.registerChannel({ isIdle: () => true, hasPending: () => active, flush });
	disposeNext = () => {
		if (reason === "dispose") next.dispose();
		else active = false;
	};
	first.request();
	next.request();
	await Promise.resolve();
	expect(flush).not.toHaveBeenCalled();
});

test("counts new work at flush time and suppresses disposed channels", async () => {
	const delivery = createBackgroundDelivery();
	let count = 0;
	delivery.registerSource({ activeCount: () => count, onChange: () => () => {} });
	const flush = vi.fn();
	const channel = delivery.registerChannel({ isIdle: () => true, hasPending: () => true, flush });
	channel.request();
	count = 1;
	await Promise.resolve();
	expect(flush).not.toHaveBeenCalled();
	count = 0;
	channel.request();
	channel.dispose();
	await Promise.resolve();
	expect(flush).not.toHaveBeenCalled();
});

test("shares a gate across separately evaluated modules and callable Pi facades", async () => {
	const host: RuntimeHost = { events: { emit: () => {}, on: () => () => {} } };
	const first = getBackgroundDelivery(host);
	vi.resetModules();
	const other = await import("../src/background-delivery.js");
	expect(other.getBackgroundDelivery({ events: { emit: () => {}, on: () => () => {} } })).toBe(
		first,
	);
	const isolated = { events: {} } as RuntimeHost;
	expect(other.getBackgroundDelivery(isolated)).not.toBe(first);
});
