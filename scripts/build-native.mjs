import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "packages/pi-native-tools/native");
await mkdir(output, { recursive: true });

const toolchain = process.env.RUSTUP_TOOLCHAIN ?? "nightly-2026-04-29-aarch64-apple-darwin";
const args = [
	"napi",
	"build",
	"--release",
	"--no-js",
	"--manifest-path",
	resolve(root, "crates/pi-native-bridge/Cargo.toml"),
	"--output-dir",
	output,
];

const child = spawn("bunx", args, {
	cwd: root,
	env: { ...process.env, RUSTUP_TOOLCHAIN: toolchain },
	stdio: "inherit",
});

await new Promise((resolvePromise, reject) => {
	child.once("error", reject);
	child.once("exit", (code, signal) => {
		if (code === 0) resolvePromise();
		else reject(new Error(`native build failed: ${code ?? signal}`));
	});
});
