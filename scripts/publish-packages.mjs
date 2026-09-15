#!/usr/bin/env node

import { execSync, spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run") || process.env.DRY_RUN === "true";
const isCi = Boolean(process.env.CI || process.env.GITHUB_ACTIONS);

console.log(`[publish-packages] Starting publication check (dryRun: ${isDryRun}, CI: ${isCi})`);

// 1. 获取工作区所有 package
const output = execSync("pnpm m ls --json --depth -1", { encoding: "utf8" });
const allPackages = JSON.parse(output);

// 2. 过滤掉 private 包，确保只发布 public 包
const publicPackages = allPackages.filter((pkg) => !pkg.private);

// 3. 拓扑排序：确保 @hheei/pi-ext-core 优先发布
publicPackages.sort((a, b) => {
	if (a.name === "@hheei/pi-ext-core") return -1;
	if (b.name === "@hheei/pi-ext-core") return 1;
	return a.name.localeCompare(b.name);
});

console.log(
	`[publish-packages] Found ${publicPackages.length} public packages to process:\n` +
		publicPackages.map((p) => `  - ${p.name}@${p.version} (${p.path})`).join("\n"),
);

let publishedCount = 0;
let skippedCount = 0;

for (const pkg of publicPackages) {
	console.log(`\n========================================`);
	console.log(`Processing: ${pkg.name}@${pkg.version}`);
	console.log(`========================================`);

	// 4. 幂等性检查：通过 npm view 检查是否已经在 registry 存在
	let isAlreadyPublished = false;
	try {
		const checkResult = execSync(`npm view "${pkg.name}@${pkg.version}" version`, {
			stdio: ["pipe", "pipe", "ignore"],
			encoding: "utf8",
		}).trim();
		if (checkResult === pkg.version) {
			isAlreadyPublished = true;
		}
	} catch {
		// npm view 失败（返回 404 / E404），说明版本尚未发布
		isAlreadyPublished = false;
	}

	if (isAlreadyPublished) {
		console.log(`✓ ${pkg.name}@${pkg.version} is already published on npm. Skipping.`);
		skippedCount++;
		continue;
	}

	console.log(`🚀 Publishing ${pkg.name}@${pkg.version}...`);

	const publishArgs = ["--filter", pkg.name, "publish", "--access", "public", "--no-git-checks"];

	if (isDryRun) {
		publishArgs.push("--dry-run");
	} else if (isCi) {
		// CI 下支持 OIDC Trusted Publishing 生成发布凭证 (provenance)
		publishArgs.push("--provenance");
	}

	const result = spawnSync("pnpm", publishArgs, {
		stdio: "inherit",
		env: process.env,
	});

	if (result.status !== 0) {
		console.error(`❌ Failed to publish ${pkg.name}@${pkg.version}`);
		process.exit(result.status ?? 1);
	}

	publishedCount++;
}

console.log(`\n========================================`);
console.log(`Publish summary:`);
console.log(`  Published / Dry-run: ${publishedCount}`);
console.log(`  Skipped (already on npm): ${skippedCount}`);
console.log(`========================================\n`);
