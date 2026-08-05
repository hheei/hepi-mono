import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: [
        "extensions/queue/queue.ts",
        "extensions/queue/queue-lock.ts",
        "extensions/queue/jsonl-queue-store.ts",
        "extensions/imports/import-*.ts",
        "extensions/config/config*.ts",
        "extensions/lifecycle/memory-lifecycle*.ts",
        "extensions/client/client.ts",
        "extensions/client/client-retry.ts",
        "extensions/client/timeout.ts",
      ],
      thresholds: {
        statements: 75,
        branches: 75,
        functions: 75,
        lines: 75,
        // Per-file floors are set below current measured coverage so they guard
        // against regression without flaking. Keep them mapped to real paths;
        // tests/coverage-config.test.ts guards against path rot.
        "extensions/queue/queue.ts": {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        "extensions/queue/queue-lock.ts": {
          statements: 75,
          branches: 60,
          functions: 80,
          lines: 78,
        },
        "extensions/queue/jsonl-queue-store.ts": {
          statements: 90,
          branches: 70,
          functions: 100,
          lines: 90,
        },
        "extensions/imports/import-execute.ts": {
          statements: 85,
          branches: 74,
          functions: 92,
          lines: 90,
        },
        "extensions/imports/import-parse.ts": {
          statements: 78,
          branches: 70,
          functions: 90,
          lines: 82,
        },
        "extensions/imports/import-plan.ts": {
          statements: 88,
          branches: 80,
          functions: 88,
          lines: 92,
        },
        "extensions/imports/import-presentation.ts": {
          statements: 95,
          branches: 78,
          functions: 100,
          lines: 95,
        },
        "extensions/imports/import-sessions.ts": {
          statements: 90,
          branches: 74,
          functions: 95,
          lines: 92,
        },
        "extensions/config/config.ts": {
          statements: 80,
          branches: 75,
          functions: 80,
          lines: 80,
        },
        "extensions/client/client.ts": {
          statements: 60,
          branches: 40,
          functions: 60,
          lines: 62,
        },
        "extensions/client/client-retry.ts": {
          statements: 70,
          branches: 65,
          functions: 70,
          lines: 70,
        },
        "extensions/client/timeout.ts": {
          statements: 80,
          branches: 72,
          functions: 80,
          lines: 80,
        },
      },
    },
  },
});
