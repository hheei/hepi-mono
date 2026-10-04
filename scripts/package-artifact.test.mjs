import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { packValidatedPackage, validatePackedDependencies } from "./package-artifact.mjs";

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
						[field]: { [name]: "1.0.0" },
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
