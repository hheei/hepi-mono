import { expect, test } from "bun:test";
import piMctxExtension from "../src/extension.js";

test("pi-mctx entry is inert", (): void => {
	const pi = new Proxy(
		{},
		{
			get(): never {
				throw new Error("The package skeleton must not access Pi APIs");
			},
		},
	);

	expect((): void => piMctxExtension(pi as never)).not.toThrow();
});
