import { afterEach, describe, expect, test } from "bun:test";
import { Shell } from "../src/native-bridge.js";

const shells: Shell[] = [];

afterEach(async (): Promise<void> => {
	await Promise.all(shells.splice(0).map((shell) => shell.abort()));
});

function createShell(): Shell {
	const shell = new Shell({ sessionEnv: { HEPI_NATIVE_SHELL: "ready" } });
	shells.push(shell);
	return shell;
}

describe("native Brush shell", () => {
	test("runs vendored uutils builtins with streamed output", async (): Promise<void> => {
		const shell = createShell();
		const environment = await shell.run({ command: 'test "$HEPI_NATIVE_SHELL" = ready' });
		expect(environment).toMatchObject({ exitCode: 0, cancelled: false, timedOut: false });

		const chunks: string[] = [];
		const result = await shell.run({ command: "printf '%s\\n' c b a b | sort | uniq" }, (chunk) =>
			chunks.push(chunk),
		);
		expect(result).toMatchObject({ exitCode: 0, cancelled: false, timedOut: false });
		expect(chunks.join("")).toBe("a\nb\nc\n");
		expect(await shell.liveBackgroundJobCount()).toBe(0);
	});

	test("maps JavaScript abort signals to shell cancellation", async (): Promise<void> => {
		const shell = createShell();
		const controller = new AbortController();
		const running = shell.run({ command: "while :; do :; done", signal: controller.signal });
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
		controller.abort();
		await expect(running).resolves.toMatchObject({ cancelled: true, timedOut: false });
	});

	test("reports shell timeouts", async (): Promise<void> => {
		const shell = createShell();
		await expect(
			shell.run({ command: "while :; do :; done", timeoutMs: 25 }),
		).resolves.toMatchObject({
			cancelled: false,
			timedOut: true,
		});
	});
});
