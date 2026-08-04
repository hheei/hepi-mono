import { spawn } from "node:child_process";
import { mkdir, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const toolsPackageRoot = resolve(root, "packages/pi-ext-tools");
const napiCli = resolve(toolsPackageRoot, "node_modules/@napi-rs/cli/dist/cli.js");
const output = resolve(toolsPackageRoot, "native");
await mkdir(output, { recursive: true });

const generatedName = "index.node";
const bridgeName = "pi-ext-tools-bridge.node";
await rm(resolve(output, generatedName), { force: true });
await rm(resolve(output, bridgeName), { force: true });

const toolchain = process.env.RUSTUP_TOOLCHAIN ?? "stable";
const args = [
	napiCli,
	"build",
	"--profile",
	"local",
	"--no-js",
	"--manifest-path",
	resolve(root, "crates/pi-ext-bridge/Cargo.toml"),
	"--output-dir",
	output,
];

const child = spawn(process.execPath, args, {
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

await rename(resolve(output, generatedName), resolve(output, bridgeName));
console.log(`Built ${bridgeName} for ${process.platform}-${process.arch}`);
