import { expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { createSftpPatchFs } from "../src/apply-patch/fs.js";

test("SFTP staging writes preserve the requested mode", async () => {
	let uploadedMode: number | undefined;
	const fs = createSftpPatchFs(
		{
			async sftpPut(_alias: string, localPath: string) {
				uploadedMode = (await stat(localPath)).mode & 0o7777;
				return { code: 0, timedOut: false, stderr: "" };
			},
		} as never,
		"ileqm",
	);

	await fs.writeAtomic("temporary", Buffer.from("updated\n"), 0o755);

	expect(uploadedMode).toBe(0o755);
});
