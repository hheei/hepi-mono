import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { computeRewriteDecision } from "../src/rtk/command-rewriter.js";
import { DEFAULT_RTK_INTEGRATION_CONFIG } from "../src/rtk/types.js";

const rewriteOptions = {
	executableResolution: { command: "rtk", resolver: "which" as const },
};

describe("RTK command rewriting", () => {
	test("bypasses compound find predicates and actions", async () => {
		let execCalls = 0;
		const pi = {
			exec: async () => {
				execCalls += 1;
				return { code: 3, stdout: "rtk find /tmp" };
			},
		} as unknown as ExtensionAPI;
		const command =
			"find /tmp -maxdepth 1 \\( -name 'pi-sshfs*' -o -name 'pi-basics-tsconfig.json' \\) -print";

		const decision = await computeRewriteDecision(
			command,
			DEFAULT_RTK_INTEGRATION_CONFIG,
			pi,
			rewriteOptions,
		);

		expect(decision).toEqual({
			changed: false,
			originalCommand: command,
			rewrittenCommand: command,
			reason: "unsupported_shape",
		});
		expect(execCalls).toBe(0);
	});

	test("bypasses find actions with an environment prefix", async () => {
		let execCalls = 0;
		const pi = {
			exec: async () => {
				execCalls += 1;
				return { code: 3, stdout: "rtk find ." };
			},
		} as unknown as ExtensionAPI;
		const command = "LC_ALL=C /usr/bin/find . -name '*.tmp' -delete";

		const decision = await computeRewriteDecision(
			command,
			DEFAULT_RTK_INTEGRATION_CONFIG,
			pi,
			rewriteOptions,
		);

		expect(decision.changed).toBe(false);
		expect(decision.rewrittenCommand).toBe(command);
		expect(execCalls).toBe(0);
	});

	test("bypasses explicit find print actions", async () => {
		let execCalls = 0;
		const pi = {
			exec: async () => {
				execCalls += 1;
				return { code: 3, stdout: "rtk find . -name '*.ts' -print" };
			},
		} as unknown as ExtensionAPI;
		const command = "find . -name '*.ts' -print";

		const decision = await computeRewriteDecision(
			command,
			DEFAULT_RTK_INTEGRATION_CONFIG,
			pi,
			rewriteOptions,
		);

		expect(decision.reason).toBe("unsupported_shape");
		expect(decision.rewrittenCommand).toBe(command);
		expect(execCalls).toBe(0);
	});

	test("bypasses native find path predicates", async () => {
		let execCalls = 0;
		const pi = {
			exec: async () => {
				execCalls += 1;
				return { code: 3, stdout: "rtk find . -path '*/node_modules/*'" };
			},
		} as unknown as ExtensionAPI;
		const command = "find . -path '*/node_modules/*'";

		const decision = await computeRewriteDecision(
			command,
			DEFAULT_RTK_INTEGRATION_CONFIG,
			pi,
			rewriteOptions,
		);

		expect(decision.reason).toBe("unsupported_shape");
		expect(decision.rewrittenCommand).toBe(command);
		expect(execCalls).toBe(0);
	});

	test("still delegates simple find predicates to RTK", async () => {
		let execCalls = 0;
		const pi = {
			exec: async () => {
				execCalls += 1;
				return { code: 3, stdout: "rtk find . -name '*.ts'" };
			},
		} as unknown as ExtensionAPI;
		const command = "find . -name '*.ts'";

		const decision = await computeRewriteDecision(
			command,
			DEFAULT_RTK_INTEGRATION_CONFIG,
			pi,
			rewriteOptions,
		);

		expect(decision.changed).toBe(true);
		expect(decision.rewrittenCommand).toBe("rtk find . -name '*.ts'");
		expect(execCalls).toBe(1);
	});
});
