import { spawnSync } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { RUNTIME_ARTIFACTS } from "./package-artifact.mjs";

/**
 * Executes the packed artifact instead of only listing it: the tarball is unpacked into a
 * throwaway directory, its dependencies resolve through the owner's workspace node_modules
 * (linked, reported), and each owner's real runtime entry point is started from dist.
 * Covers the two assets a manifest cannot describe — a worker_threads file the host spawns by
 * URL and a Python file the host spawns by path.
 */
export async function runPackedArtifactSmoke(workspace, tarball, destination) {
	if (RUNTIME_ARTIFACTS[workspace.name] === undefined) return [];
	const packageRoot = join(destination, "package");
	spawnSync("tar", ["-xzf", tarball, "-C", destination], { stdio: "ignore" });
	if (!existsSync(packageRoot)) {
		throw new Error(`${workspace.name} tarball did not unpack into package/`);
	}
	linkWorkspaceDependencies(workspace, packageRoot);

	const entry = (path) => pathToFileURL(join(packageRoot, path)).href;
	const reports = [];
	if (workspace.name === "@hheei/pi-apply-patch") {
		reports.push(await smokeJsDiffWorker(entry));
	} else if (workspace.name === "@hheei/pi-python-eval") {
		reports.push(await smokePythonKernel(entry, packageRoot));
	}
	return reports;
}

/**
 * pnpm's layout keeps every direct, peer and transitive dependency one symlink away, so the
 * unpacked package resolves the same modules a workspace install would without a network install.
 */
function linkWorkspaceDependencies(workspace, packageRoot) {
	const source = join(workspace.path, "node_modules");
	if (!existsSync(source)) {
		throw new Error(
			`${workspace.name} has no workspace node_modules to resolve packed imports from`,
		);
	}
	symlinkSync(source, join(packageRoot, "node_modules"), "dir");
}

async function smokeJsDiffWorker(entry) {
	const { parseV4aPatch } = await import(entry("dist/apply-patch/parser.js"));
	const { runJsDiffUpdate } = await import(entry("dist/apply-patch/jsdiff.js"));
	const operation = parseV4aPatch(
		"*** Begin Patch\n*** Update File: value.txt\n*** Move to: moved.txt\n@@\n-one\n+ONE\n@@\n-four\n+FOUR\n*** End Patch",
	).operations[0];
	if (operation?.kind !== "update") throw new Error("apply-patch smoke patch did not parse");
	const prepared = await runJsDiffUpdate({
		before: new TextEncoder().encode("one\ntwo\nthree\nfour\n"),
		operation,
		fuzzFactor: 0,
	});
	const after = new TextDecoder().decode(prepared.after);
	if (after !== "ONE\ntwo\nthree\nFOUR\n") {
		throw new Error(`jsdiff worker returned unexpected bytes: ${JSON.stringify(after)}`);
	}
	if (prepared.outcomes.length !== 2 || prepared.rejected.length !== 0) {
		throw new Error("jsdiff worker did not report both hunks as applied");
	}
	if (
		prepared.snapshots.length === 0 ||
		prepared.snapshots.some((item) => item.path !== "moved.txt")
	) {
		throw new Error("jsdiff worker snapshots lost the patched path");
	}
	return "jsdiff worker IPC";
}

async function smokePythonKernel(entry, packageRoot) {
	const { EvalKernelHost } = await import(entry("dist/kernel/host.js"));
	const host = new EvalKernelHost(packageRoot);
	const texts = [];
	try {
		const result = await host.runWithHooks("answer = 6 * 7\nprint('kernel-ok')\nanswer", {
			cwd: packageRoot,
			onText: (text) => texts.push(text),
			onDisplay: () => {},
			onBackground: (text) => texts.push(text),
			callTool: async () => {
				throw new Error("python smoke cell must not call a tool");
			},
		});
		if (result.value !== 42) {
			throw new Error(`python kernel returned ${JSON.stringify(result.value)} instead of 42`);
		}
		if (!texts.some((text) => text.includes("kernel-ok"))) {
			throw new Error("python kernel did not report cell stdout");
		}
		if (result.restarted === true || result.state?.names === undefined) {
			throw new Error("python kernel reported a fresh process for the first cell");
		}
	} finally {
		host.dispose();
	}
	return "python kernel cell";
}
