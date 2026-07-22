import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHePiRuntimeContext, type HePiRuntimeContext } from "./context.js";
import { HePiRegistry } from "./registry.js";

export interface HePiLifecycleOptions {
	readonly createRegistry?: () => HePiRegistry;
	readonly onStart?: (runtime: HePiRuntimeContext) => void | Promise<void>;
	readonly onShutdown?: (
		runtime: HePiRuntimeContext,
		failures: readonly { id: string; error: unknown }[],
	) => void | Promise<void>;
}

export class HePiLifecycleController {
	private runtime: HePiRuntimeContext | undefined;
	private transitionQueue: Promise<void> = Promise.resolve();

	constructor(private readonly options: HePiLifecycleOptions = {}) {}

	get current(): HePiRuntimeContext | undefined {
		return this.runtime;
	}

	async start(pi: ExtensionAPI, ctx: ExtensionContext): Promise<HePiRuntimeContext> {
		return this.enqueue(async () => {
			if (this.runtime) await this.shutdownUnlocked();
			const runtime = createHePiRuntimeContext(
				pi,
				ctx,
				this.options.createRegistry?.() ?? new HePiRegistry(),
			);
			this.runtime = runtime;
			try {
				await this.options.onStart?.(runtime);
				return runtime;
			} catch (error) {
				this.runtime = undefined;
				const failures = await runtime.registry.cleanup();
				await this.options.onShutdown?.(runtime, failures);
				throw error;
			}
		});
	}

	async shutdown(): Promise<void> {
		return this.enqueue(() => this.shutdownUnlocked());
	}

	private async shutdownUnlocked(): Promise<void> {
		const runtime = this.runtime;
		if (!runtime) return;
		this.runtime = undefined;
		const failures = await runtime.registry.cleanup();
		await this.options.onShutdown?.(runtime, failures);
	}

	private enqueue<T>(transition: () => Promise<T>): Promise<T> {
		const result = this.transitionQueue.then(transition);
		this.transitionQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

export function registerHePiLifecycle(pi: ExtensionAPI, controller: HePiLifecycleController): void {
	pi.on("session_start", async (_event, ctx) => {
		await controller.start(pi, ctx);
	});
	pi.on("session_shutdown", async () => {
		await controller.shutdown();
	});
}
