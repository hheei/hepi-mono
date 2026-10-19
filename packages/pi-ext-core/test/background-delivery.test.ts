import { expect, test, vi } from "vitest";
import { createBackgroundDelivery, getBackgroundDelivery } from "../src/background-delivery.js";
import type { RuntimeHost } from "../src/runtime-identity.js";

test("idle parent: every pending channel flushes in one batch, exactly one wake", async () => {
	const delivery = createBackgroundDelivery();
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
	expect(sent).toEqual([false, true]);
});

test("repeated requests before the tick produce one batch, and a disposed request is inert", async () => {
	const delivery = createBackgroundDelivery();
	const flush = vi.fn();
	const channel = delivery.registerChannel({ isIdle: () => true, hasPending: () => true, flush });
	channel.request();
	channel.request();
	channel.request();
	await Promise.resolve();
	expect(flush).toHaveBeenCalledTimes(1);
	channel.dispose();
	channel.request();
	await Promise.resolve();
	expect(flush).toHaveBeenCalledTimes(1);
});

test("busy parent steers every channel in its next step", async () => {
	const delivery = createBackgroundDelivery();
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

test("content that appears mid-batch is not flushed and never adds a second wake", async () => {
	const delivery = createBackgroundDelivery();
	const sent: boolean[] = [];
	let extra = false;
	const first = delivery.registerChannel({
		isIdle: () => true,
		hasPending: () => true,
		flush: (wake) => {
			sent.push(wake);
			// A send during the batch makes another producer's content appear.
			extra = true;
		},
	});
	const late = delivery.registerChannel({
		isIdle: () => true,
		hasPending: () => extra,
		flush: (wake) => sent.push(wake),
	});
	first.request();
	await Promise.resolve();
	// The batch only covers content pending when it started; the late channel waits for its own
	// request, which is what the single-wake rule bounds.
	expect(sent).toEqual([true]);
	extra = false;
	first.dispose();
	late.dispose();
});

test("a wake is not reassigned backwards: reentrant invalidation can leave a batch unwoken", async () => {
	const delivery = createBackgroundDelivery();
	const sent: boolean[] = [];
	let secondPending = true;
	const first = delivery.registerChannel({
		isIdle: () => true,
		hasPending: () => true,
		flush: (wake) => {
			sent.push(wake);
			// The send aborts the other producer, whose content disappears before its own turn.
			secondPending = false;
		},
	});
	const second = delivery.registerChannel({
		isIdle: () => true,
		hasPending: () => secondPending,
		flush: (wake) => sent.push(wake),
	});
	first.request();
	second.request();
	await Promise.resolve();
	// first reserved the wake as "not last", second then went quiet: at most once means no wake
	// is handed backwards, so this batch delivers content without starting a turn.
	expect(sent).toEqual([false]);
	// The surviving content is still deliverable and gets the single wake in the next batch.
	second.request();
	await Promise.resolve();
	expect(sent).toEqual([false, true]);
});

test.each([
	"dispose",
	"abort",
])("never flushes a channel invalidated by a reentrant %s", async (reason) => {
	const delivery = createBackgroundDelivery();
	const flush = vi.fn();
	let active = true;
	let invalidate = () => {};
	const first = delivery.registerChannel({
		isIdle: () => true,
		hasPending: () => true,
		flush: () => invalidate(),
	});
	const next = delivery.registerChannel({ isIdle: () => true, hasPending: () => active, flush });
	invalidate = () => {
		if (reason === "dispose") next.dispose();
		else active = false;
	};
	first.request();
	next.request();
	await Promise.resolve();
	expect(flush).not.toHaveBeenCalled();
});

test("suppresses a channel disposed after its request", async () => {
	const delivery = createBackgroundDelivery();
	const flush = vi.fn();
	const channel = delivery.registerChannel({ isIdle: () => true, hasPending: () => true, flush });
	channel.request();
	channel.dispose();
	await Promise.resolve();
	expect(flush).not.toHaveBeenCalled();
});

test("a thrown flush is isolated: other channels still deliver, the channel keeps its pending content", async () => {
	const delivery = createBackgroundDelivery();
	const sent: boolean[] = [];
	let rejected = true;
	const bad = delivery.registerChannel({
		isIdle: () => true,
		hasPending: () => rejected,
		flush: () => {
			if (rejected) throw new Error("sendMessage rejected");
		},
	});
	const good = delivery.registerChannel({
		isIdle: () => true,
		hasPending: () => true,
		flush: (wake) => sent.push(wake),
	});
	bad.request();
	good.request();
	await Promise.resolve();
	expect(sent).toEqual([true]);
	rejected = false;
	bad.dispose();
	good.dispose();
});

test("without pending content nothing flushes; a later request runs a new batch", async () => {
	const delivery = createBackgroundDelivery();
	const flush = vi.fn();
	const quiet = delivery.registerChannel({
		isIdle: () => true,
		hasPending: () => false,
		flush,
	});
	quiet.request();
	await Promise.resolve();
	expect(flush).not.toHaveBeenCalled();
	let pending = true;
	const holder = delivery.registerChannel({
		isIdle: () => true,
		hasPending: () => pending,
		flush,
	});
	holder.request();
	await Promise.resolve();
	expect(flush).toHaveBeenCalledTimes(1);
	pending = false;
	quiet.dispose();
	holder.dispose();
});

test("shares one coordinator across separately evaluated modules and callable Pi facades", async () => {
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
