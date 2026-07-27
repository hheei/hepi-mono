import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHepiRuntimeContext, type HepiRuntimeContext } from "./context.js";
import { HepiRegistry } from "./registry.js";

export interface HepiLifecycleOptions {
	readonly createRegistry?: () => HepiRegistry;
	readonly onStart?: (runtime: HepiRuntimeContext) => void | Promise<void>;
	readonly onShutdown?: (
		runtime: HepiRuntimeContext,
		failures: readonly { id: string; error: unknown }[],
	) => void | Promise<void>;
}

export class HepiLifecycleController {
	private readonly options: HepiLifecycleOptions;
	private runtime: HepiRuntimeContext | undefined;
	private transitionQueue: Promise<void> = Promise.resolve();

	constructor(options: HepiLifecycleOptions = {}) {
		this.options = options;
	}

	get current(): HepiRuntimeContext | undefined {
		return this.runtime;
	}

	async start(pi: ExtensionAPI, ctx: ExtensionContext): Promise<HepiRuntimeContext> {
		return this.enqueue(async () => {
			if (this.runtime) await this.shutdownUnlocked();
			const runtime = createHepiRuntimeContext(
				pi,
				ctx,
				this.options.createRegistry?.() ?? new HepiRegistry(),
			);
			this.runtime = runtime;
			try {
				await this.options.onStart?.(runtime);
				return runtime;
			} catch (error) {
				this.runtime = undefined;
				const failures = [...(await runtime.registry.cleanup())];
				try {
					await this.options.onShutdown?.(runtime, failures);
				} catch (shutdownError) {
					failures.push({ id: "onShutdown", error: shutdownError });
				}
				if (failures.length > 0)
					throw new AggregateError(
						[error, ...failures.map((failure) => failure.error)],
						`HEPI start failed and cleanup failed: ${failures.map((failure) => failure.id).join(", ")}`,
						{ cause: error },
					);
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
		const failures = [...(await runtime.registry.cleanup())];
		try {
			await this.options.onShutdown?.(runtime, failures);
		} catch (error) {
			failures.push({ id: "onShutdown", error });
		}
		if (failures.length > 0)
			throw new AggregateError(
				failures.map((failure) => failure.error),
				`HEPI cleanup failed: ${failures.map((failure) => failure.id).join(", ")}`,
			);
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

export function registerHepiLifecycle(pi: ExtensionAPI, controller: HepiLifecycleController): void {
	pi.on("session_start", async (_event, ctx) => {
		await controller.start(pi, ctx);
	});
	pi.on("session_shutdown", async () => {
		await controller.shutdown();
	});
}
