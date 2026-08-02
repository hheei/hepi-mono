import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BUNDLED_MPATCH_VERSION = "1.6.4";

export interface BundledMpatchSource {
	readonly target: string;
	readonly archiveUrl: string;
	readonly archiveSha256: string;
}

const SOURCES: Readonly<Record<string, BundledMpatchSource>> = {
	"darwin-arm64": {
		target: "darwin-arm64",
		archiveUrl:
			"https://github.com/Romelium/mpatch/releases/download/v1.6.4/mpatch-aarch64-apple-darwin-v1.6.4.zip",
		archiveSha256: "5e360959393a79ba4e707d815b7d4f92f326311eace3f93845003f03272c36c0",
	},
	"darwin-x64": {
		target: "darwin-x64",
		archiveUrl:
			"https://github.com/Romelium/mpatch/releases/download/v1.6.4/mpatch-x86_64-apple-darwin-v1.6.4.zip",
		archiveSha256: "5e491764124acf546b56a417169bb0e8723c51d14690d5da031c72c1eb999ba6",
	},
	"linux-arm64": {
		target: "linux-arm64",
		archiveUrl:
			"https://github.com/Romelium/mpatch/releases/download/v1.6.4/mpatch-aarch64-unknown-linux-musl-v1.6.4.tar.gz",
		archiveSha256: "ee28bae39fbdc8ec63321b0cbbca276ddba20938fdd4b0a94dc669a0889ef6ee",
	},
	"linux-x64": {
		target: "linux-x64",
		archiveUrl:
			"https://github.com/Romelium/mpatch/releases/download/v1.6.4/mpatch-x86_64-unknown-linux-musl-v1.6.4.tar.gz",
		archiveSha256: "72fcd28d0ba7ad8163b3a6bee4606430670dd177bf86c059bddf6f4e45b0f896",
	},
	"win32-arm64": {
		target: "win32-arm64",
		archiveUrl:
			"https://github.com/Romelium/mpatch/releases/download/v1.6.4/mpatch-aarch64-pc-windows-msvc-v1.6.4.zip",
		archiveSha256: "45608886372883f3b696201e3dc9bd3ff05f8e091dd4bd66756c60a63fd5a6a5",
	},
	"win32-x64": {
		target: "win32-x64",
		archiveUrl:
			"https://github.com/Romelium/mpatch/releases/download/v1.6.4/mpatch-x86_64-pc-windows-msvc-v1.6.4.zip",
		archiveSha256: "776f9e4008687e6cf968e6f90dc6232c852f9fee796b36f2223c43a256393001",
	},
};

export const BUNDLED_MPATCH_SOURCES: readonly BundledMpatchSource[] = Object.values(SOURCES);

function targetFor(platform: string, arch: string): BundledMpatchSource {
	const target = SOURCES[`${platform}-${arch}`];
	if (target === undefined)
		throw new Error(
			`Bundled mpatch ${BUNDLED_MPATCH_VERSION} does not support ${platform}-${arch}`,
		);
	return target;
}

/** Returns package-owned mpatch executable; it never probes user-managed binaries. */
export function getBundledMpatchPath(
	platform: string = process.platform,
	arch: string = process.arch,
): string {
	const target = targetFor(platform, arch);
	const executable = platform === "win32" ? "mpatch.exe" : "mpatch";
	const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
	const path = join(packageRoot, "bin", "mpatch", target.target, executable);
	if (!existsSync(path)) throw new Error(`Bundled mpatch executable is missing: ${path}`);
	return path;
}
