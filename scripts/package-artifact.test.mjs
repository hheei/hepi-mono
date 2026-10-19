import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { packValidatedPackage, validatePackedDependencies } from "./package-artifact.mjs";
import { runPackedArtifactSmoke } from "./package-artifact-smoke.mjs";

test("accepts resolved workspace dependencies and host peers", () => {
	validatePackedDependencies({
		name: "@hheei/pi-ext-tools",
		dependencies: { "@hheei/pi-ext-core": "^0.2.0" },
		peerDependencies: { typebox: "*" },
		devDependencies: { typebox: "1.3.27" },
	});
});

for (const field of [
	"dependencies",
	"optionalDependencies",
	"peerDependencies",
	"devDependencies",
]) {
	test(`rejects workspace protocols in packed ${field}`, () => {
		assert.throws(
			() =>
				validatePackedDependencies({
					name: "fixture",
					[field]: { "@hheei/pi-ext-core": "workspace:^0.1.1" },
				}),
			/non-installable/,
		);
	});
}

for (const field of ["dependencies", "optionalDependencies"]) {
	test(`rejects host runtime copies in ${field}`, () => {
		for (const name of ["typebox", "@earendil-works/pi-coding-agent"]) {
			assert.throws(
				() =>
					validatePackedDependencies({
						name: "fixture",
						[field]: { [name]: "1.1.0" },
					}),
				/host-provided/,
			);
		}
	});
}

test("rejects versioned typebox peers", () => {
	assert.throws(
		() =>
			validatePackedDependencies({
				name: "fixture",
				peerDependencies: { typebox: "^1.3.27" },
			}),
		/peer range/,
	);
});

/** Minimal publishable workspace; the runtime asset list is keyed by real package name. */
function createArtifactWorkspace(directory, name, files) {
	const path = join(directory, "packages", "fixture");
	mkdirSync(path, { recursive: true });
	mkdirSync(join(path, "node_modules"));
	writeFileSync(
		join(path, "package.json"),
		JSON.stringify({ name, version: "0.1.0", type: "module", main: "dist/index.js" }),
	);
	writeFileSync(join(path, "LICENSE"), "Permission is hereby granted\n");
	for (const [file, content] of Object.entries(files)) {
		mkdirSync(dirname(join(path, file)), { recursive: true });
		writeFileSync(join(path, file), content);
	}
	return { name, version: "0.1.0", path };
}

function createFixtureRepo(directory) {
	writeFileSync(join(directory, "package.json"), JSON.stringify({ private: true }));
	writeFileSync(join(directory, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
}

test("rejects a tarball that does not ship the declared runtime asset", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-package-artifact-asset-"));
	try {
		createFixtureRepo(directory);
		const workspace = createArtifactWorkspace(directory, "@hheei/pi-python-eval", {
			"dist/index.js": "export {};\n",
			"dist/kernel/host.js": "export class EvalKernelHost {}\n",
		});
		assert.throws(
			() => packValidatedPackage(workspace, directory),
			/runtime asset: dist\/kernel\/child\.py/,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("rejects a packed worker that ships but never answers IPC", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-package-artifact-worker-"));
	try {
		createFixtureRepo(directory);
		const workspace = createArtifactWorkspace(directory, "@hheei/pi-apply-patch", {
			"dist/index.js": "export {};\n",
			"dist/apply-patch/parser.js":
				'export function parseV4aPatch() { return { operations: [{ kind: "update", path: "value.txt", hunks: [] }] }; }\n',
			// Starts the shipped worker the way the real entry point does; an inert worker never replies.
			"dist/apply-patch/jsdiff.js": [
				'import { Worker } from "node:worker_threads";',
				"export async function runJsDiffUpdate() {",
				'\tconst worker = new Worker(new URL("./jsdiff-worker.js", import.meta.url));',
				"\tconst message = await new Promise((resolve) => {",
				'\t\tworker.once("message", resolve);',
				'\t\tworker.once("exit", () => resolve(undefined));',
				"\t});",
				"\tawait worker.terminate();",
				'\tif (message === undefined) throw new Error("jsdiff worker returned no result");',
				"\treturn message;",
				"}",
				"",
			].join("\n"),
			"dist/apply-patch/jsdiff-worker.js": "// shipped, but never posts a result\n",
		});
		const tarball = packValidatedPackage(workspace, directory);
		await assert.rejects(
			runPackedArtifactSmoke(workspace, tarball, directory),
			/jsdiff worker returned no result/,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("pnpm tarballs resolve workspace ranges and install with npm outside the workspace", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-package-install-test-"));
	try {
		writeFileSync(join(directory, "package.json"), JSON.stringify({ private: true }));
		writeFileSync(join(directory, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
		const tarballs = [];
		for (const name of ["foundation", "extension"]) {
			const path = join(directory, "packages", name);
			mkdirSync(path, { recursive: true });
			writeFileSync(
				join(path, "package.json"),
				JSON.stringify({
					name: `@pi-artifact-fixture/${name}`,
					version: "0.1.1",
					main: "index.js",
					...(name === "extension"
						? { dependencies: { "@pi-artifact-fixture/foundation": "workspace:^0.1.1" } }
						: {}),
				}),
			);
			writeFileSync(join(path, "index.js"), "module.exports = {};\n");
			writeFileSync(join(path, "LICENSE"), "Permission is hereby granted\n");
			tarballs.push(
				packValidatedPackage(
					{ name: `@pi-artifact-fixture/${name}`, version: "0.1.1", path },
					directory,
				),
			);
		}
		const installDirectory = join(directory, "consumer");
		mkdirSync(installDirectory);
		writeFileSync(join(installDirectory, "package.json"), JSON.stringify({ private: true }));
		execFileSync(
			"npm",
			["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs],
			{
				cwd: installDirectory,
				encoding: "utf8",
			},
		);
		const installed = JSON.parse(
			readFileSync(
				join(installDirectory, "node_modules/@pi-artifact-fixture/extension/package.json"),
				"utf8",
			),
		);
		assert.equal(installed.dependencies["@pi-artifact-fixture/foundation"], "^0.1.1");
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
