import { errorMessage } from "./errors.js";
import { getGlobalState } from "./global-state.js";
import { type RuntimeHost, runtimeIdentity } from "./runtime-identity.js";

/**
 * One producer's path into the parent session. The channel owns its pending content and its
 * branch/abort checks; the coordinator only decides when to ask it to flush.
 *
 * A busy parent receives every message in its next step. An idle parent is woken at most once
 * per microtask batch, by the last channel that is still valid, so unrelated background work
 * cannot each start a new turn. A thrown submission must leave the channel's pending content
 * intact: the coordinator reports it and waits for the next request or change.
 */
export interface BackgroundDeliveryChannel {
	isIdle(): boolean;
	hasPending(): boolean;
	flush(triggerTurn: boolean): void;
}

export interface BackgroundDeliveryRegistration {
	/** Schedules a flush for the current batch. A disposed registration does nothing. */
	request(): void;
	dispose(): void;
}

/** Session-runtime coordination only; channels retain their own state. */
export interface BackgroundDelivery {
	registerChannel(channel: BackgroundDeliveryChannel): BackgroundDeliveryRegistration;
}

export function createBackgroundDelivery(): BackgroundDelivery {
	const channels = new Set<BackgroundDeliveryChannel>();
	let scheduled = false;
	const schedule = (): void => {
		if (scheduled) return;
		scheduled = true;
		queueMicrotask(() => {
			scheduled = false;
			const pending = [...channels].filter((channel) => channel.hasPending());
			const first = pending[0];
			if (first === undefined) return;
			const idle = first.isIdle();
			for (const [index, channel] of pending.entries()) {
				// A preceding synchronous send can abort/dispose another consumer.
				if (!channels.has(channel) || !channel.hasPending()) continue;
				try {
					const last = !pending
						.slice(index + 1)
						.some((next) => channels.has(next) && next.hasPending());
					channel.flush(!idle || last);
				} catch (error) {
					if (process.env.DEBUG || process.env.PI_DEBUG) {
						console.error(`background delivery failed: ${errorMessage(error)}`);
					}
				}
			}
		});
	};
	return {
		registerChannel(channel) {
			channels.add(channel);
			return {
				request() {
					if (!channels.has(channel)) return;
					schedule();
				},
				dispose() {
					channels.delete(channel);
				},
			};
		},
	};
}

/** Shared across separately evaluated ext-core bundles; registrations are lifecycle-owned. */
export function getBackgroundDelivery(pi: RuntimeHost): BackgroundDelivery {
	const runtimes = getGlobalState(
		"background-delivery",
		(): WeakMap<object, BackgroundDelivery> => new WeakMap(),
	);
	const identity = runtimeIdentity(pi);
	const existing = runtimes.get(identity);
	if (existing !== undefined) return existing;
	const created = createBackgroundDelivery();
	runtimes.set(identity, created);
	return created;
}
