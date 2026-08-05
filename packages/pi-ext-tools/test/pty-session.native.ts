import { expect, test } from "bun:test";
import { PtySession } from "../src/native-bridge.js";

const decoder = new TextDecoder();

test("PtySession reads input, resizes, and reaps its child", async (): Promise<void> => {
	const session = new PtySession({
		command: "/bin/sh",
		args: ["-c", 'printf ready; read line; printf ":$line"'],
		cwd: process.cwd(),
		rows: 24,
		cols: 80,
	});
	const first = await session.read();
	expect(decoder.decode(first.output, { stream: true })).toContain("ready");
	expect(first.eof).toBe(false);
	session.resize(30, 100);
	session.write(Buffer.from("done\n", "utf8"));

	let output = "";
	for (;;) {
		const next = await session.read();
		output += decoder.decode(next.output, { stream: !next.eof });
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
		args: ["-c", "sleep 10 & echo $!; wait"],
		cwd: process.cwd(),
		rows: 24,
		cols: 80,
	});
	expect(decoder.decode((await session.read()).output).trim()).not.toBe("");
	const wait = session.wait();
	session.close();
	const status = await wait;
	expect(status.code).not.toBe(0);
});

test("PtySession shares its child-reap promise", async (): Promise<void> => {
	const session = new PtySession({
		command: "/bin/sh",
		args: ["-c", "exit 0"],
		cwd: process.cwd(),
		rows: 24,
		cols: 80,
	});
	expect(session.wait()).toBe(session.wait());
	await session.wait();
});

test("PtySession close settles a pending read", async (): Promise<void> => {
	const session = new PtySession({
		command: "/bin/sh",
		args: ["-c", "sleep 10"],
		cwd: process.cwd(),
		rows: 24,
		cols: 80,
	});
	const read = session.read().then(
		() => "settled",
		() => "settled",
	);
	session.close();
	const outcome = await Promise.race([read, Bun.sleep(1000).then(() => "timeout")]);
	expect(outcome).toBe("settled");
	await session.wait();
});
