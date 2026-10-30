import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExtractedContent, VideoFrame } from "../src/extract.ts";

// Video frame requests plan a timestamp window and assemble one result shape,
// whether the video is a YouTube stream or a local file. These tests pin that
// planning and assembly while the sampling calls stay the existing ones.

const h = vi.hoisted(() => ({
	streamInfo: vi.fn(),
	youtubeFrames: vi.fn(),
	youtubeFrame: vi.fn(),
	youtubeAnalyze: vi.fn(),
	localDuration: vi.fn(),
	localFrame: vi.fn(),
	localAnalyze: vi.fn(),
}));

vi.mock("../src/ssrf-protection.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/ssrf-protection.ts")>()),
	fetchRemoteUrl: vi.fn(async () => new Response("", { status: 500 })),
}));
vi.mock("../src/youtube-extract.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/youtube-extract.ts")>()),
	getYouTubeStreamInfo: h.streamInfo,
	extractYouTubeFrames: h.youtubeFrames,
	extractYouTubeFrame: h.youtubeFrame,
	extractYouTube: h.youtubeAnalyze,
}));
vi.mock("../src/video-extract.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/video-extract.ts")>()),
	getLocalVideoDuration: h.localDuration,
	extractVideoFrame: h.localFrame,
	extractVideo: h.localAnalyze,
}));

const { extractContent } = await import("../src/extract.ts");

const extract = (url: string, options: Record<string, unknown> = {}) =>
	extractContent(url, undefined, { lookup, ...options });

const YOUTUBE_URL = "https://www.youtube.com/watch?v=abc12345678";
const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
const streamInfo = { duration: 100, streamUrl: "https://cdn.test/stream" };
const frame = (timestamp: string): VideoFrame => ({
	data: "AA",
	mimeType: "image/jpeg",
	timestamp,
});
const frames = (timestamps: number[]) => ({
	frames: timestamps.map((t) => frame(String(t))),
	duration: 100,
	error: null,
});

let tempDir: string;
let videoPath: string;
let originalAgentDir: string | undefined;

beforeEach(async () => {
	originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	tempDir = await mkdtemp(join(tmpdir(), "pi-web-access-frames-"));
	process.env.PI_CODING_AGENT_DIR = tempDir;
	videoPath = join(tempDir, "clip.mp4");
	await writeFile(videoPath, "video");
	for (const fn of [
		h.streamInfo,
		h.youtubeFrames,
		h.youtubeFrame,
		h.youtubeAnalyze,
		h.localDuration,
		h.localFrame,
		h.localAnalyze,
	])
		fn.mockReset();
	h.streamInfo.mockResolvedValue(streamInfo);
	h.youtubeFrames.mockImplementation(async (_id: string, timestamps: number[]) =>
		frames(timestamps),
	);
	h.youtubeFrame.mockResolvedValue(frame("0"));
	h.localDuration.mockResolvedValue(60);
	h.localFrame.mockResolvedValue(frame("0"));
});

afterEach(async () => {
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	await rm(tempDir, { recursive: true, force: true });
});

describe("full-video frame sampling", () => {
	test("samples a YouTube video across its reported duration", async () => {
		const result = await extract(YOUTUBE_URL, { frames: 3 });

		expect(h.youtubeFrames).toHaveBeenCalledWith("abc12345678", [0, 50, 100], streamInfo);
		expect(result).toMatchObject({
			title: "Frames 0:00-1:40 (3/3)",
			content: "3 frames extracted from 0:00-1:40",
			error: null,
			duration: 100,
		});
		expect(result.frames).toHaveLength(3);
	});

	test("rejects a YouTube video without a known duration", async () => {
		h.streamInfo.mockResolvedValue({ duration: null, streamUrl: "https://cdn.test/stream" });

		const result = await extract(YOUTUBE_URL, { frames: 3 });

		expect(result).toMatchObject({
			title: "Frames",
			error: "Cannot determine video duration. Use a timestamp range instead.",
		});
	});

	test("reports a stream lookup failure under the plain Frames title", async () => {
		h.streamInfo.mockResolvedValue({ error: "yt-dlp failed: nope" });

		const result = await extract(YOUTUBE_URL, { frames: 3 });

		expect(result).toMatchObject({ title: "Frames", error: "yt-dlp failed: nope" });
		expect(h.youtubeFrames).not.toHaveBeenCalled();
	});

	test("samples a local file across its probed duration", async () => {
		const result = await extract(videoPath, { frames: 2 });

		expect(h.localDuration).toHaveBeenCalledWith(videoPath);
		expect(h.localFrame).toHaveBeenCalledTimes(2);
		expect(result).toMatchObject({ title: "Frames 0:00-1:00 (2/2)", duration: 60, error: null });
	});

	test("reports a local duration probe failure under the plain Frames title", async () => {
		h.localDuration.mockResolvedValue({ error: "ffprobe failed: nope" });

		const result = await extract(videoPath, { frames: 2 });

		expect(result).toMatchObject({ title: "Frames", error: "ffprobe failed: nope" });
	});

	test("rejects non-video targets", async () => {
		const result = await extract("https://example.test/page", { frames: 2 });

		expect(result.error).toBe("Frame extraction only works with YouTube and local video files");
	});
});

describe("timestamp frame sampling", () => {
	test("samples a range with the default frame count", async () => {
		const result = await extract(YOUTUBE_URL, { timestamp: "10-40" });

		expect(h.youtubeFrames).toHaveBeenCalledWith(
			"abc12345678",
			[10, 16, 22, 28, 34, 40],
			streamInfo,
		);
		expect(result).toMatchObject({
			title: "Frames 0:10-0:40 (6/6)",
			content: "6 frames extracted from 0:10-0:40",
			error: null,
			duration: 100,
		});
	});

	test("rejects a range that starts past the reported duration", async () => {
		const result = await extract(YOUTUBE_URL, { timestamp: "110-120" });

		expect(result).toMatchObject({
			title: "Frames 1:50-2:00",
			error: "Timestamp 2:00 exceeds video duration (1:40)",
		});
		expect(h.youtubeFrames).not.toHaveBeenCalled();
	});

	test("samples a counted window from a single timestamp", async () => {
		const result = await extract(YOUTUBE_URL, {
			timestamp: "15",
			frames: 3,
		});

		expect(h.youtubeFrames).toHaveBeenCalledWith("abc12345678", [15, 20, 25], streamInfo);
		expect(result).toMatchObject({ title: "Frames 0:15-0:25 (3/3)", error: null });
	});

	test("rejects a counted window that runs past the duration", async () => {
		const result = await extract(YOUTUBE_URL, {
			timestamp: "95",
			frames: 3,
		});

		expect(result).toMatchObject({
			title: "Frames 1:35-1:45",
			error: "Timestamp 1:45 exceeds video duration (1:40)",
		});
	});

	test("returns a single frame as the image payload", async () => {
		const result = await extract(YOUTUBE_URL, { timestamp: "15" });

		expect(h.youtubeFrame).toHaveBeenCalledWith("abc12345678", 15, streamInfo);
		expect(result).toMatchObject({
			title: "Frame at 15",
			content: "Video frame at 15",
			error: null,
			mimeType: "image/jpeg",
			thumbnail: { data: "AA", mimeType: "image/jpeg" },
		});
	});

	test("rejects a single timestamp past the reported duration", async () => {
		const result = await extract(YOUTUBE_URL, { timestamp: "200" });

		expect(result).toMatchObject({
			title: "Frame at 200",
			error: "Timestamp 3:20 exceeds video duration (1:40)",
		});
	});

	test("samples a local range without probing the duration", async () => {
		const result = await extract(videoPath, { timestamp: "200-260" });

		expect(h.localDuration).not.toHaveBeenCalled();
		expect(h.localFrame).toHaveBeenCalledTimes(6);
		expect(result).toMatchObject({ title: "Frames 3:20-4:20 (6/6)", error: null });
	});

	test("returns a single local frame as the image payload", async () => {
		const result = await extract(videoPath, { timestamp: "5" });

		expect(h.localFrame).toHaveBeenCalledWith(videoPath, 5);
		expect(result).toMatchObject({ title: "Frame at 5", mimeType: "image/jpeg", error: null });
	});

	test("rejects an unparseable timestamp", async () => {
		const result = await extract(YOUTUBE_URL, { timestamp: "soon" });

		expect(result.error).toBe(
			'Invalid timestamp format: "soon". Use "H:MM:SS", "MM:SS", "85", or "start-end".',
		);
	});

	test("rejects non-video targets", async () => {
		const result = await extract("https://example.test/page", {
			timestamp: "5",
		});

		expect(result.error).toBe("Timestamp extraction only works with YouTube and local video files");
	});
});

describe("frame request gates", () => {
	test.each([
		{ frames: 2 },
		{ timestamp: "5" },
	])("respects the image feature gate %o", async (opts) => {
		await writeFile(
			join(tempDir, "ext_settings.json"),
			JSON.stringify({ webSearch: { image: { enabled: false } } }),
		);

		const result = await extract(YOUTUBE_URL, opts);

		expect(result.error).toBe("Image fetching is disabled by image.enabled");
		expect(h.streamInfo).not.toHaveBeenCalled();
	});
});

describe("whole-video analysis", () => {
	test("delegates a local video to the video analyzer", async () => {
		const analyzed: ExtractedContent = {
			url: videoPath,
			title: "Analysis",
			content: "description",
			error: null,
		};
		h.localAnalyze.mockResolvedValue(analyzed);

		const result = await extract(videoPath, { prompt: "what happens" });

		expect(h.localAnalyze).toHaveBeenCalledWith(
			expect.objectContaining({ absolutePath: videoPath }),
			undefined,
			expect.objectContaining({ prompt: "what happens" }),
		);
		expect(result.content).toBe("description");
	});
});
