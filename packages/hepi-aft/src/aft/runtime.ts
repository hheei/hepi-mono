import {
	type AftProjectTransport,
	type AftTransportPool,
	type BridgeOptions,
	createAftTransportPool,
	ensureStorageMigrated,
	findBinary,
	isNativeExecutable,
	resolveCortexKitStorageRoot,
	setActiveLogger,
	type ToolCallResult,
} from "@cortexkit/aft-bridge";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bridgeLogger } from "./logger.js";
import { callToolCall } from "./shared.js";

const AFT_VERSION = "0.49.0";
const HEPI_AFT_BINARY_ENV = "HEPI_AFT_BINARY";

setActiveLogger(bridgeLogger);

export interface HepiAftRuntimeStartOptions {
	readonly poolOptions?: Pick<
		BridgeOptions,
		"hangThreshold" | "onBashCompletion" | "onBashLongRunning" | "onBashPatternMatch" | "timeoutMs"
	>;
	readonly onBgEventsNudge?: (projectRoot: string, session: string) => void;
}

export function aftConfigureOverrides(): Record<string, unknown> {
	return {
		harness: "pi",
		storage_dir: resolveCortexKitStorageRoot(),
	};
}

export function resolveHepiAftBinaryOverride(
	env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
	const binaryPath = env[HEPI_AFT_BINARY_ENV]?.trim();
	if (binaryPath === undefined || binaryPath.length === 0) return undefined;
	if (!isNativeExecutable(binaryPath)) {
		throw new Error(`${HEPI_AFT_BINARY_ENV} must point to a native AFT executable: ${binaryPath}`);
	}
	return binaryPath;
}

export class HepiAftRuntime {
	private pool: AftTransportPool | undefined;

	async start(options: HepiAftRuntimeStartOptions = {}): Promise<void> {
		const binaryPath = resolveHepiAftBinaryOverride() ?? (await findBinary(AFT_VERSION));
		await ensureStorageMigrated({ harness: "pi", binaryPath });
		this.pool = await createAftTransportPool({
			harness: "pi",
			binaryPath,
			poolOptions: { logger: bridgeLogger, ...options.poolOptions },
			configOverrides: aftConfigureOverrides(),
			...(options.onBgEventsNudge === undefined
				? {}
				: { onBgEventsNudge: options.onBgEventsNudge }),
		});
	}

	async toolCall(
		ctx: ExtensionContext,
		name: string,
		arguments_: Record<string, unknown>,
	): Promise<ToolCallResult> {
		const pool = this.pool;
		if (pool === undefined) throw new Error("AFT runtime is unavailable in this session");
		return await callToolCall(pool.getBridge(ctx.cwd), name, arguments_, ctx);
	}

	getBridge(cwd: string): AftProjectTransport {
		const pool = this.pool;
		if (pool === undefined) throw new Error("AFT runtime is unavailable in this session");
		return pool.getBridge(cwd);
	}

	async dispose(): Promise<void> {
		const pool = this.pool;
		this.pool = undefined;
		if (pool !== undefined) await pool.shutdown();
	}
}
