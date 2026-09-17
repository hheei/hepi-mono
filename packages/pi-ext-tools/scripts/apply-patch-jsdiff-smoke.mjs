import { spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const packageRoot = join(dirname(scriptPath), "..");

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function runScenario(copyRoot, workspaceRoot) {
	await import(`${pathToFileURL(join(copyRoot, "dist", "extension.js")).href}?smoke=${Date.now()}`);
	const { createApplyPatchTool } = await import(
		`${pathToFileURL(join(copyRoot, "dist", "apply-patch-tool.js")).href}?smoke=${Date.now()}`
	);
	const { registerBashTool } = await import(
		`${pathToFileURL(join(copyRoot, "dist", "bash.js")).href}?smoke=${Date.now()}`
	);

	await writeFile(join(workspaceRoot, "update.txt"), "old\n");
	await writeFile(join(workspaceRoot, "delete.txt"), "remove me\n");
	const patchTool = createApplyPatchTool();
	const patchResult = await patchTool.execute(
		"native-free-patch",
		{
			patch: [
				"*** Begin Patch",
				"*** Add File: add.txt",
				"+added",
				"*** Update File: update.txt",
				"-old",
				"+updated",
				"*** Delete File: delete.txt",
				"*** End Patch",
			].join("\n"),
		},
		undefined,
		undefined,
		{ cwd: workspaceRoot },
	);
	assert(patchResult.details.status === "success", "apply_patch did not report success");
	assert((await readFile(join(workspaceRoot, "add.txt"), "utf8")) === "added\n", "add failed");
	assert(
		(await readFile(join(workspaceRoot, "update.txt"), "utf8")) === "updated\n",
		"update failed",
	);
	assert(!(await exists(join(workspaceRoot, "delete.txt"))), "delete failed");

	const tools = [];
	registerBashTool({
		registerTool(tool) {
			tools.push(tool);
		},
	});
	const bash = tools.find((tool) => tool.name === "bash");
	assert(bash !== undefined, "bash was not registered");
	const bashResult = await bash.execute(
		"native-free-bash",
		{ command: "printf native-free-bash" },
		undefined,
		undefined,
		{ cwd: workspaceRoot },
	);
	assert(bashResult.content.some((part) => part.type === "text" && part.text.includes("native-free-bash")), "bash output missing");
	assert(bashResult.details.exitCode === 0, "bash did not exit successfully");
	const marker = join(workspaceRoot, "invalid-parameters.marker");
	let rejected = false;
	try {
		await bash.execute(
			"reject-invalid-parameters",
			{ command: `printf unexpected > ${JSON.stringify(marker)}`, unsupported: true },
			undefined,
			undefined,
			{ cwd: workspaceRoot, mode: "print" },
		);
	} catch (error) {
		rejected = error instanceof Error && error.message === "Invalid bash parameters";
	}
	assert(rejected, "unknown Bash field was not rejected");
	assert(!(await exists(marker)), "invalid Bash parameters started a command");
}

async function spawnScenario(copyRoot, workspaceRoot) {
	await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [scriptPath, "--scenario", copyRoot, workspaceRoot], {
			stdio: "inherit",
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`smoke subprocess failed (${signal ?? `exit ${code}`})`));
		});
	});
}

async function main() {
	if (process.argv[2] === "--scenario") {
		const copyRoot = process.argv[3];
		const workspaceRoot = process.argv[4];
		assert(copyRoot !== undefined && workspaceRoot !== undefined, "missing scenario paths");
		await runScenario(copyRoot, workspaceRoot);
		return;
	}

	const root = await mkdtemp(join(tmpdir(), "hepi-jsdiff-smoke-"));
	try {
		for (const withInvalidNative of [false, true]) {
			const name = withInvalidNative ? "invalid-native" : "no-native";
			const copyRoot = join(root, name, "package");
			const workspaceRoot = join(root, name, "workspace");
			await mkdir(copyRoot, { recursive: true });
			await mkdir(workspaceRoot, { recursive: true });
			await cp(join(packageRoot, "dist"), join(copyRoot, "dist"), { recursive: true });
			await cp(join(packageRoot, "package.json"), join(copyRoot, "package.json"));
			await symlink(
				join(packageRoot, "node_modules"),
				join(copyRoot, "node_modules"),
				process.platform === "win32" ? "junction" : "dir",
			);
			if (withInvalidNative) {
				const nativeRoot = join(copyRoot, "native");
				await mkdir(nativeRoot);
				await writeFile(join(nativeRoot, "pi-ext-tools-bridge.node"), "not a native addon");
			}
			await spawnScenario(copyRoot, workspaceRoot);
			console.log(`${name}: ok`);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

await main();
