import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Cases that drive a real subprocess: Pi's CLI, the replay binary, or a probe child process. They
 * assert what only a real process can show (locks between two invocations, restart behavior, exit
 * codes), so each case costs a process launch. `pnpm test` leaves them out and runs the fast,
 * in-process suite; `pnpm run test:integration` runs this file.
 */
export default defineConfig({
	test: {
		environment: "node",
		include: ["packages/*/test-integration/**/*.test.ts"],
		exclude: ["**/node_modules/**", "**/references/**", "**/dist/**"],
		passWithNoTests: true,
		testTimeout: 60_000,
		env: { PI_OFFLINE: "1" },
	},
	resolve: {
		alias: [
			{
				find: /^@hheei\/pi-ext-core$/,
				replacement: fileURLToPath(new URL("./packages/pi-ext-core/src/index.ts", import.meta.url)),
			},
		],
	},
});
