import { errorMessage } from "./errors.js";
import { getGlobalState } from "./global-state.js";
import { type RuntimeHost, runtimeIdentity } from "./runtime-identity.js";

export interface BackgroundWorkSource {
	activeCount(): number;
	/** Notify when work finishes; counts are read live, including queued work. */
	onChange(listener: () => void): () => void;
}

export interface BackgroundDeliveryChannel {
	isIdle(): boolean;
	hasPending(): boolean;
	/**
	 * Busy: steer every message. Idle: only the last message may request a turn.
	 * urgentOnly leaves ordinary items queued. Preserve pending items on a thrown submission;
	 * the coordinator diagnoses it and waits for the next request/change, without a retry loop.
	 */
	flush(triggerTurn: boolean, urgentOnly: boolean): void;
}

export interface BackgroundDeliveryRegistration {
	/** Urgent requests bypass the idle completion gate, not the single-wake rule. */
	request(urgent?: boolean): void;
	dispose(): void;
}

/** Session-runtime coordination only; sources and channels retain their own state. */
export interface BackgroundDelivery {
	registerSource(source: BackgroundWorkSource): () => void;
	registerChannel(channel: BackgroundDeliveryChannel): BackgroundDeliveryRegistration;
}

export function createBackgroundDelivery(): BackgroundDelivery {
	const sources = new Set<BackgroundWorkSource>();
	const channels = new Set<BackgroundDeliveryChannel>();
	const urgent = new Set<BackgroundDeliveryChannel>();
	let scheduled = false;
	const schedule = (): void => {
		if (scheduled) return;
		scheduled = true;
		queueMicrotask(() => {
			scheduled = false;
			let pending = [...channels].filter((channel) => channel.hasPending());
			const first = pending[0];
			if (first === undefined) return;
			const idle = first.isIdle();
			const urgentOnly = idle && [...sources].some((source) => source.activeCount() > 0);
			if (urgentOnly) pending = pending.filter((channel) => urgent.has(channel));
			for (const [index, channel] of pending.entries()) {
				// A preceding synchronous send can abort/dispose another consumer.
				if (!channels.has(channel) || !channel.hasPending()) continue;
				try {
					const last = !pending
						.slice(index + 1)
						.some((next) => channels.has(next) && next.hasPending());
					channel.flush(!idle || last, urgentOnly);
					urgent.delete(channel);
				} catch (error) {
					if (process.env.DEBUG || process.env.PI_DEBUG) {
						console.error(`background delivery failed: ${errorMessage(error)}`);
					}
				}
			}
		});
	};
	return {
		registerSource(source) {
			sources.add(source);
			const unsubscribe = source.onChange(schedule);
			return () => {
				unsubscribe();
				sources.delete(source);
				schedule();
			};
		},
		registerChannel(channel) {
			channels.add(channel);
			return {
				request(isUrgent = false) {
					if (!channels.has(channel)) return;
					if (isUrgent) urgent.add(channel);
					schedule();
				},
				dispose() {
					channels.delete(channel);
					urgent.delete(channel);
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
