import {
	type AftTransportPool,
	createAftTransportPool,
	ensureStorageMigrated,
	findBinary,
	resolveCortexKitStorageRoot,
	type ToolCallResult,
} from "@cortexkit/aft-bridge";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const AFT_VERSION = "0.49.0";

export function aftConfigureOverrides(): Record<string, unknown> {
	return {
		harness: "pi",
		storage_dir: resolveCortexKitStorageRoot(),
	};
}

export class HepiAftRuntime {
	private pool: AftTransportPool | undefined;

	async start(): Promise<void> {
		const binaryPath = await findBinary(AFT_VERSION);
		await ensureStorageMigrated({ harness: "pi", binaryPath });
		this.pool = await createAftTransportPool({
			harness: "pi",
			binaryPath,
			poolOptions: {},
			configOverrides: aftConfigureOverrides(),
		});
	}

	async toolCall(
		ctx: ExtensionContext,
		name: string,
		arguments_: Record<string, unknown>,
	): Promise<ToolCallResult> {
		const pool = this.pool;
		if (pool === undefined) throw new Error("AFT runtime is unavailable in this session");
		return await pool
			.getBridge(ctx.cwd)
			.toolCall(ctx.sessionManager.getSessionId(), name, arguments_);
	}

	async dispose(): Promise<void> {
		const pool = this.pool;
		this.pool = undefined;
		if (pool !== undefined) await pool.shutdown();
	}
}
