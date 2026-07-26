import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function getBundledApplyPatchBinaryPath(): string | undefined {
	const directory = dirname(fileURLToPath(import.meta.url));
	const exe = process.platform === "win32" ? "apply_patch.exe" : "apply_patch";
	const relativeBinary = ["bin", `${process.platform}-${process.arch}`, exe];
	const candidates = [
		join(directory, ...relativeBinary),
		join(directory, "tools", "apply-patch", ...relativeBinary),
	];
	return candidates.find((candidate) => existsSync(candidate));
}
