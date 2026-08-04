import { execFile } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const root = resolve(import.meta.dirname, "..");
const sourcePath = process.env.OH_MY_PI_SOURCE;
if (sourcePath === undefined || sourcePath.trim() === "") {
	throw new Error("OH_MY_PI_SOURCE must point to a checked-out oh-my-pi repository");
}
const source = resolve(sourcePath);
const destination = join(root, "crates", "vendor");
const revisionFile = join(destination, "UPSTREAM_REVISION");
const sourceCrates = join(source, "crates");

const revision = process.env.OH_MY_PI_REVISION;
if (revision === undefined || revision.trim() === "") {
	throw new Error("OH_MY_PI_REVISION is required");
}

const { stdout } = await execFileAsync(
	"cargo",
	["metadata", "--locked", "--manifest-path", join(source, "Cargo.toml"), "--format-version", "1"],
	{ encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
);
const metadata = JSON.parse(stdout);
if (
	typeof metadata !== "object" ||
	metadata === null ||
	!("packages" in metadata) ||
	!Array.isArray(metadata.packages) ||
	!("resolve" in metadata) ||
	typeof metadata.resolve !== "object" ||
	metadata.resolve === null ||
	!("nodes" in metadata.resolve) ||
	!Array.isArray(metadata.resolve.nodes)
) {
	throw new Error("cargo metadata returned an unexpected shape");
}

const packages = metadata.packages.flatMap((pkg) => {
	if (
		typeof pkg !== "object" ||
		pkg === null ||
		!("id" in pkg) ||
		typeof pkg.id !== "string" ||
		!("name" in pkg) ||
		typeof pkg.name !== "string" ||
		!("manifest_path" in pkg) ||
		typeof pkg.manifest_path !== "string"
	) {
		throw new Error("cargo metadata contains an invalid package");
	}
	return [{ id: pkg.id, name: pkg.name, manifestPath: pkg.manifest_path }];
});
const nodes = metadata.resolve.nodes.flatMap((node) => {
	if (typeof node !== "object" || node === null || !("id" in node) || typeof node.id !== "string") {
		throw new Error("cargo metadata contains an invalid resolve node");
	}
	if (!("deps" in node) || !Array.isArray(node.deps)) {
		throw new Error(`cargo metadata node ${node.id} has no dependency list`);
	}
	const dependencies = node.deps.flatMap((dependency) => {
		if (
			typeof dependency !== "object" ||
			dependency === null ||
			!("pkg" in dependency) ||
			typeof dependency.pkg !== "string"
		) {
			throw new Error(`cargo metadata node ${node.id} contains an invalid dependency`);
		}
		return [dependency.pkg];
	});
	return [{ id: node.id, dependencies }];
});

const shell = packages.find(
	(pkg) => pkg.name === "pi-shell" && pkg.manifestPath.startsWith(`${sourceCrates}${sep}`),
);
if (shell === undefined) throw new Error("upstream cargo metadata does not contain local pi-shell");

const dependenciesByPackage = new Map(nodes.map((node) => [node.id, node.dependencies]));
const reachable = new Set();
const visit = (packageId) => {
	if (reachable.has(packageId)) return;
	reachable.add(packageId);
	for (const dependency of dependenciesByPackage.get(packageId) ?? []) visit(dependency);
};
visit(shell.id);

const retainedCrates = packages
	.filter((pkg) => reachable.has(pkg.id) && pkg.manifestPath.startsWith(`${sourceCrates}${sep}`))
	.map((pkg) => {
		const cratePath = relative(sourceCrates, dirname(pkg.manifestPath));
		if (cratePath === "" || cratePath.startsWith(`..${sep}`) || isAbsolute(cratePath)) {
			throw new Error(`refusing to copy crate outside upstream crates/: ${pkg.manifestPath}`);
		}
		return cratePath;
	})
	.sort();

await mkdir(destination, { recursive: true });
await rm(destination, { recursive: true, force: true });
for (const cratePath of retainedCrates) {
	const target = join(destination, "oh-my-pi", cratePath);
	await mkdir(dirname(target), { recursive: true });
	await cp(join(sourceCrates, cratePath), target, { recursive: true });
}
await writeFile(revisionFile, `${revision.trim()}\n`, "utf8");

console.log(`Updated ${retainedCrates.length} pi-shell dependency crates at ${revision.trim()}`);
