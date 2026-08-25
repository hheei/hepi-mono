import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["packages/*/test/**/*.test.ts"],
		exclude: ["**/node_modules/**", "**/references/**", "**/dist/**"],
		passWithNoTests: true,
	},
	resolve: {
		alias: {
			"#core": fileURLToPath(new URL("./packages/pi-mctx/src/core", import.meta.url)),
		},
	},
});
