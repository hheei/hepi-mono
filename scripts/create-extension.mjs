#!/usr/bin/env node
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = path.join(root, "templates", "extension");
const packagesDir = path.join(root, "packages");

function normalizeSlug(input) {
	const slug = input
		.trim()
		.toLowerCase()
		.replace(/^@[^/]+\//, "")
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");

	if (!slug || slug.startsWith("pi-")) {
		return slug;
	}

	return `pi-${slug}`;
}

function toTitle(slug) {
	return slug
		.replace(/^pi-/, "")
		.split("-")
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

async function replacePlaceholders(dir, replacements) {
	const entries = await readdir(dir);
	for (const entry of entries) {
		const target = path.join(dir, entry);
		const info = await stat(target);
		if (info.isDirectory()) {
			await replacePlaceholders(target, replacements);
			continue;
		}

		let content = await readFile(target, "utf8");
		for (const [key, value] of Object.entries(replacements)) {
			content = content.replaceAll(key, value);
		}
		await writeFile(target, content);
	}
}

const rawName = process.argv[2];
if (!rawName) {
	console.error("Usage: bun run new:extension -- pi-my-extension");
	process.exit(1);
}

const slug = normalizeSlug(rawName);
if (!slug) {
	console.error(`Invalid extension name: ${rawName}`);
	process.exit(1);
}

const packageDir = path.join(packagesDir, slug);
await mkdir(packagesDir, { recursive: true });
await cp(templateDir, packageDir, { recursive: true, errorOnExist: true, force: false });
await replacePlaceholders(packageDir, {
	__PACKAGE_SLUG__: slug,
	__EXTENSION_TITLE__: toTitle(slug),
	__COMMAND_NAME__: slug,
});

console.log(`Created packages/${slug}`);
