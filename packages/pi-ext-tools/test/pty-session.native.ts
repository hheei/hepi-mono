import { expect, test } from "bun:test";
import { PtySession } from "../src/native-bridge.js";

test("PtySession reads input, resizes, and reaps its child", async (): Promise<void> => {
	const session = new PtySession({
		command: "/bin/sh",
		args: ["-c", 'printf ready; read line; printf ":$line"'],
		cwd: process.cwd(),
		rows: 24,
		cols: 80,
	});
	const first = await session.read();
	expect(first.output).toContain("ready");
	expect(first.eof).toBe(false);
	session.resize(30, 100);
	session.write(Buffer.from("done\n", "utf8"));

	let output = "";
	for (;;) {
		const next = await session.read();
		output += next.output;
		if (next.eof) break;
	}
	const status = await session.wait();
	expect(output).toContain(":done");
	expect(status).toMatchObject({ code: 0 });
	session.close();
	session.close();
});

test("PtySession close terminates an active child", async (): Promise<void> => {
	const session = new PtySession({
		command: "/bin/sh",
		args: ["-c", "sleep 10"],
		cwd: process.cwd(),
		rows: 24,
		cols: 80,
	});
	session.close();
	const status = await session.wait();
	expect(status.code).not.toBe(0);
});
