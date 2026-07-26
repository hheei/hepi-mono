import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	createTextReplayFrame,
	finalFrameAnsi,
	finalFrameSvg,
	formatReplay,
	replayTui,
	stripAnsi,
	type TuiReplayResult,
	writeReplayArtifacts,
	writeReplaySnapshot,
} from "../src/tui-replay.js";

const REPLAY_CLI = join(dirname(import.meta.path), "../src/tui-replay.ts");

describe("TUI replay", () => {
	test("captures input and resize actions", async () => {
		let text = "";
		const result = await replayTui({
			columns: 20,
			rows: 2,
			create: (host) => ({
				render: () => [`${host.columns}x${host.rows}`, `> ${text}`],
				handleInput(input) {
					text += input;
					host.requestRender();
				},
			}),
			actions: [
				{ type: "text", text: "hello" },
				{ type: "resize", columns: 30 },
			],
		});
		expect(result.last.lines).toEqual(["30x2", "> hello"]);
		expect(formatReplay(result)).toContain("--- #2 resize 30x=");
		expect(stripAnsi("\x1b[32mgreen\x1b[0m")).toBe("green");
		const controls = createTextReplayFrame("\x07safe\x9b2J\x1b[31mred\x1b[0m\x9dtitle\x07end");
		const ansi = finalFrameAnsi(controls);
		expect(ansi).toContain("safe\x1b[31mred\x1b[0mend");
		expect(ansi).not.toContain("\x07");
		expect(ansi).not.toContain("\x9b");
		expect(ansi).not.toContain("\x9d");
		expect(stripAnsi("before\x1b[12")).toBe("before");
		expect(stripAnsi("before\x9dunterminated")).toBe("before");
		expect(stripAnsi("before\x1bPunterminated")).toBe("before");
	});

	test("renders SVG with Maple Mono and ANSI foreground colors", () => {
		const frame = createTextReplayFrame(
			"\x1b[31mstandard\x1b[0m \x1b[38;5;42mindexed\x1b[0m \x1b[38;2;12;34;56mtruecolor\x1b[0m\n\x1b[1m界\x1b[22m│",
		);
		const svg = finalFrameSvg(frame);
		expect(svg).toContain(
			`font-family="'Maple Mono NF CN', Menlo, Monaco, 'Courier New', monospace"`,
		);
		expect(svg).toContain(
			'<tspan x="12" textLength="67.2" lengthAdjust="spacingAndGlyphs" fill="#c50f1f">standard</tspan>',
		);
		expect(svg).toContain(
			'<tspan x="87.6" textLength="58.8" lengthAdjust="spacingAndGlyphs" fill="rgb(0,215,135)">indexed</tspan>',
		);
		expect(svg).toContain(
			'<tspan x="154.8" textLength="75.6" lengthAdjust="spacingAndGlyphs" fill="rgb(12,34,56)">truecolor</tspan>',
		);
		expect(svg).toContain(
			'<tspan x="12" textLength="16.8" lengthAdjust="spacingAndGlyphs" fill="#d8dee9" font-weight="700">界</tspan>',
		);
		expect(svg).toContain(
			'<tspan x="28.8" textLength="8.4" lengthAdjust="spacingAndGlyphs" fill="#d8dee9">│</tspan>',
		);
		expect(svg).not.toContain("\x1b");
	});

	test("writes only the selected shell-text snapshot format", async () => {
		const rootDir = await mkdtemp(join(tmpdir(), "pi-debug-snapshot-"));
		try {
			const frame = createTextReplayFrame("\x1b[32mgreen\x1b[0m\nlong line", {
				columns: 6,
			});
			expect(createTextReplayFrame("界界x", { columns: 4 }).lines.map(stripAnsi)).toEqual(["界界"]);
			const ans = await writeReplaySnapshot(frame, { format: "ans", rootDir });
			expect(basename(dirname(ans))).toBe("replay-0001");
			expect(await readdir(dirname(ans))).toEqual(["final.ans"]);
			expect(await readFile(ans, "utf8")).toContain("\x1b[32mgreen\x1b[0m");
			const svg = await writeReplaySnapshot(frame, { format: "svg", rootDir });
			expect(basename(dirname(svg))).toBe("replay-0002");
			expect(await readdir(dirname(svg))).toEqual(["final.svg"]);
			expect(await readFile(svg, "utf8")).toContain("<svg");
		} finally {
			await rm(rootDir, { recursive: true, force: true });
		}
	});

	test("sanitizes automatic CLI success paths", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-debug-cli-output-"));
		const cwd = join(root, "cwd\x1b]0;path-injection\x07");
		await mkdir(cwd);
		try {
			const child = Bun.spawn([process.execPath, REPLAY_CLI, "--text", "ok", "--format", "ans"], {
				cwd,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(exitCode).toBe(0);
			expect(stderr).toBe("");
			expect(stdout).not.toContain("\x1b]");
			expect(stdout).not.toContain("\x07");
			expect(await readdir(join(cwd, "outputs"))).toEqual(["replay-0001"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("writes replay artifacts from the package API", async () => {
		const rootDir = await mkdtemp(join(tmpdir(), "pi-debug-replay-"));
		try {
			await mkdir(join(rootDir, "replay-20260724000000000"));
			const result = await replayTui({
				columns: 10,
				rows: 1,
				create: () => ({ render: () => ["frame"] }),
			});
			const artifacts = await writeReplayArtifacts(result, { rootDir });
			const concurrent = await Promise.all([
				writeReplayArtifacts(result, { rootDir }),
				writeReplayArtifacts(result, { rootDir }),
			]);
			expect(basename(artifacts.directory)).toBe("replay-0001");
			expect(concurrent.map((item) => basename(item.directory)).sort()).toEqual([
				"replay-0002",
				"replay-0003",
			]);
			const [snapshot, mixedBundle] = await Promise.all([
				writeReplaySnapshot(result.last, { format: "ans", rootDir }),
				writeReplayArtifacts(result, { rootDir }),
			]);
			expect([basename(dirname(snapshot)), basename(mixedBundle.directory)].sort()).toEqual([
				"replay-0004",
				"replay-0005",
			]);
			for (const replay of [artifacts, ...concurrent, mixedBundle])
				expect((await readdir(replay.directory)).sort()).toEqual([
					"final.ans",
					"final.svg",
					"final.txt",
					"metadata.json",
					"replay.ans",
					"replay.txt",
				]);
			expect((await readdir(rootDir)).some((name) => name.startsWith(".replay-"))).toBe(false);
			expect(await readFile(artifacts.finalPlain, "utf8")).toBe("frame\n");
			expect(await readFile(artifacts.finalScreenshot, "utf8")).toContain("<svg");

			const poisoned: TuiReplayResult = {
				...result,
				modelResults: [
					{
						prompt: "prompt",
						get model(): string {
							throw new Error("metadata failed");
						},
						thinking: "low",
						text: "",
						events: [],
						stderr: "",
					},
				],
			};
			const beforeFailure = (await readdir(rootDir)).sort();
			await expect(writeReplayArtifacts(poisoned, { rootDir })).rejects.toThrow("metadata failed");
			expect((await readdir(rootDir)).sort()).toEqual(beforeFailure);
			await expect(
				writeReplayArtifacts(result, {
					rootDir,
					publish: async () => {
						throw new Error("generation changed");
					},
				}),
			).rejects.toThrow("generation changed");
			expect((await readdir(rootDir)).sort()).toEqual(beforeFailure);
		} finally {
			await rm(rootDir, { recursive: true, force: true });
		}
	});
});
