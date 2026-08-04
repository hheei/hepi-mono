import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sourcePath = process.env.OH_MY_PI_SOURCE;
if (sourcePath === undefined || sourcePath.trim() === "") {
	throw new Error("OH_MY_PI_SOURCE must point to a checked-out oh-my-pi repository");
}
const source = resolve(sourcePath);
const destination = join(root, "crates", "vendor");
const revisionFile = join(destination, "UPSTREAM_REVISION");

const revision = process.env.OH_MY_PI_REVISION;
if (revision === undefined || revision.trim() === "") {
	throw new Error("OH_MY_PI_REVISION is required");
}

await mkdir(destination, { recursive: true });
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(join(source, "crates"), join(destination, "crates"), { recursive: true });
await cp(join(source, "Cargo.toml"), join(destination, "Cargo.toml"));
await cp(join(source, "Cargo.lock"), join(destination, "Cargo.lock"));
await writeFile(revisionFile, `${revision.trim()}\n`, "utf8");

const manifest = await readFile(join(destination, "Cargo.toml"), "utf8");
if (!manifest.includes('name = "pi-natives"')) {
	throw new Error("vendored source does not contain pi-natives");
}

console.log(`Updated oh-my-pi crates at ${revision.trim()}`);
