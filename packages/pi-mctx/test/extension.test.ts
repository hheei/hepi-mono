import { expect, test } from "bun:test";
import piMctxExtension from "../src/extension.js";

test("pi-mctx entry registers only session lifecycle handlers", (): void => {
	const handlers: string[] = [];
	const pi = {
		events: {},
		on(name: string): void {
			handlers.push(name);
		},
	};

	piMctxExtension(pi as never);
	expect(handlers).toEqual(["session_start", "session_shutdown", "turn_end"]);
});
