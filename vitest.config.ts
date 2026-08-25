import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["packages/*/test/**/*.test.ts"],
		exclude: ["**/node_modules/**", "**/references/**", "**/dist/**"],
		passWithNoTests: true,
		testTimeout: 30_000,
		env: { PI_OFFLINE: "1" },
	},
	resolve: {
		alias: [
			{
				find: "#core",
				replacement: fileURLToPath(new URL("./packages/pi-mctx/src/core", import.meta.url)),
			},
			{
				find: /^@hheei\/pi-ext-core$/,
				replacement: fileURLToPath(new URL("./packages/pi-ext-core/src/index.ts", import.meta.url)),
			},
			{
				find: /^@hheei\/pi-ext-core\/testing$/,
				replacement: fileURLToPath(
					new URL("./packages/pi-ext-core/src/testing.ts", import.meta.url),
				),
			},
		],
	},
});
