import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// One profile attempt owns its database snapshot, decryption, and diagnostics.
// These tests drive the real filesystem and a real SQLite database, stubbing only
// the platform secret lookups (secret-tool, kwallet-query, PowerShell DPAPI) and
// the platform name, so fixtures stay identical on every host.

const h = vi.hoisted(() => ({
	home: "",
	tmp: "",
	realTmp: "",
	commands: [] as string[],
	responses: new Map<string, string>(),
}));

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	h.realTmp = actual.tmpdir();
	return {
		...actual,
		homedir: () => h.home,
		tmpdir: () => h.tmp || actual.tmpdir(),
	};
});

vi.mock("node:child_process", () => ({
	execFile: (
		command: string,
		_args: string[],
		optionsOrCallback: unknown,
		maybeCallback?: unknown,
	) => {
		const callback = (
			typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback
		) as (error: Error | null, stdout: string) => void;
		h.commands.push(command);
		const stdout = h.responses.get(command);
		setImmediate(() =>
			stdout === undefined
				? callback(new Error(`${command} unavailable`), "")
				: callback(null, stdout),
		);
	},
}));

let cookies: typeof import("../src/chrome-cookies.ts");
let home: string;
let configDir: string;

const CHROME_ROOT = ".config/google-chrome";
const SNAPSHOT_PREFIX = "pi-chrome-cookies-";
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
}

function chromiumKey(secret: string): Buffer {
	return pbkdf2Sync(secret, "saltysalt", 1, 16, "sha1");
}

/** v10 AES-128-CBC as Chromium stores it, with the v24 host hash prefix. */
function encryptV10(value: string, secret: string, hostKey: string): Buffer {
	const payload = Buffer.concat([
		createHash("sha256").update(hostKey).digest(),
		Buffer.from(value, "utf8"),
	]);
	const padding = 16 - (payload.length % 16);
	const padded = Buffer.concat([payload, Buffer.alloc(padding, padding)]);
	const cipher = createCipheriv("aes-128-cbc", chromiumKey(secret), Buffer.alloc(16, 0x20));
	cipher.setAutoPadding(false);
	return Buffer.concat([Buffer.from("v10"), cipher.update(padded), cipher.final()]);
}

function chromeMicros(offsetMillis: number): number {
	return (Date.now() + 11644473600000 + offsetMillis) * 1000;
}

interface CookieRow {
	host: string;
	name: string;
	path?: string;
	value?: string;
	encrypted?: Buffer;
	expires?: number;
}

interface DbOptions {
	metaVersion?: number;
	partitionColumns?: boolean;
}

function createCookieDb(dbPath: string, options: DbOptions = {}): DatabaseSync {
	const db = new DatabaseSync(dbPath);
	const partitionColumns = options.partitionColumns
		? ", is_partitioned INTEGER, top_frame_site_key TEXT"
		: "";
	db.exec(
		`CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER); CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER${partitionColumns});`,
	);
	db.prepare("INSERT INTO meta (key, value) VALUES ('version', ?)").run(options.metaVersion ?? 24);
	return db;
}

function insertCookieRows(db: DatabaseSync, rows: CookieRow[]): void {
	const insert = db.prepare(
		"INSERT INTO cookies (host_key, name, value, encrypted_value, path, expires_utc) VALUES (?, ?, ?, ?, ?, ?)",
	);
	for (const row of rows) {
		insert.run(
			row.host,
			row.name,
			row.value ?? null,
			row.encrypted ?? null,
			row.path ?? "/",
			row.expires ?? 0,
		);
	}
}

function writeCookieDb(dbPath: string, rows: CookieRow[], options: DbOptions = {}): void {
	const db = createCookieDb(dbPath, options);
	insertCookieRows(db, rows);
	db.close();
}

/** A Linux Chrome profile whose cookie database sits at the legacy path. */
async function writeProfile(
	rows: CookieRow[],
	options: DbOptions & { profile?: string } = {},
): Promise<string> {
	const profileDir = join(home, CHROME_ROOT, options.profile ?? "Default");
	await mkdir(profileDir, { recursive: true });
	writeCookieDb(join(profileDir, "Cookies"), rows, options);
	return profileDir;
}

async function snapshotDirs(): Promise<string[]> {
	const entries = await readdir(h.tmp);
	return entries.filter((entry) => entry.startsWith(SNAPSHOT_PREFIX));
}

function commandCount(command: string): number {
	return h.commands.filter((candidate) => candidate === command).length;
}

beforeEach(async () => {
	vi.resetModules();
	vi.stubEnv("PI_ALLOW_BROWSER_COOKIES", "1");
	h.tmp = await mkdtemp(join(h.realTmp, "pi-cookies-root-"));
	home = await mkdtemp(join(h.tmp, "pi-cookies-home-"));
	configDir = await mkdtemp(join(h.tmp, "pi-cookies-config-"));
	h.home = home;
	h.commands = [];
	h.responses.clear();
	vi.stubEnv("PI_CODING_AGENT_DIR", configDir);
	vi.stubEnv("KDE_FULL_SESSION", undefined);
	vi.stubEnv("XDG_CURRENT_DESKTOP", undefined);
	setPlatform("linux");
	cookies = await import("../src/chrome-cookies.ts");
});

afterEach(async () => {
	Object.defineProperty(process, "platform", platformDescriptor as PropertyDescriptor);
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	await rm(h.tmp, { recursive: true, force: true });
});

describe("successful reads", () => {
	test("returns cookies and a longest-path-first header", async () => {
		await writeProfile([
			{ host: ".google.com", name: "NID", value: "n1", path: "/" },
			{ host: "gemini.google.com", name: "__Secure-1PSID", value: "ps", path: "/app" },
		]);

		const result = await cookies.getBrowserCookiesForHosts({
			hosts: ["gemini.google.com"],
			requestUrl: new URL("https://gemini.google.com/app"),
		});

		expect(result?.cookies).toEqual({ NID: "n1", "__Secure-1PSID": "ps" });
		expect(result?.warnings).toEqual([]);
		expect(result?.cookieHeader).toBe("__Secure-1PSID=ps; NID=n1");
	});

	test("decrypts v10 values and strips the v24 host hash", async () => {
		await writeProfile([
			{
				host: "gemini.google.com",
				name: "__Secure-1PSID",
				encrypted: encryptV10("decrypted-value", "peanuts", "gemini.google.com"),
			},
		]);

		const result = await cookies.getBrowserCookiesForHosts({
			hosts: ["gemini.google.com"],
			requiredCookies: ["__Secure-1PSID"],
			requiredLabel: "Gemini",
		});

		expect(result?.cookies).toEqual({ "__Secure-1PSID": "decrypted-value" });
	});

	test("filters by request path and skips non-matching cookies", async () => {
		await writeProfile([
			{ host: "gemini.google.com", name: "A", value: "a", path: "/" },
			{ host: "gemini.google.com", name: "B", value: "b", path: "/other" },
		]);

		const result = await cookies.getBrowserCookiesForHosts({
			hosts: ["gemini.google.com"],
			requestUrl: new URL("https://gemini.google.com/app/page"),
		});

		expect(result?.cookies).toEqual({ A: "a" });
		expect(result?.cookieHeader).toBe("A=a");
	});

	test("drops expired and partitioned cookies for a request URL", async () => {
		const profileDir = await writeProfile(
			[
				{ host: "gemini.google.com", name: "VALID", value: "v", expires: chromeMicros(60_000) },
				{ host: "gemini.google.com", name: "EXPIRED", value: "e", expires: chromeMicros(-60_000) },
				{ host: "gemini.google.com", name: "PARTITIONED", value: "p" },
			],
			{ partitionColumns: true },
		);
		const db = new DatabaseSync(join(profileDir, "Cookies"));
		db.prepare(
			"UPDATE cookies SET is_partitioned = 1, top_frame_site_key = 'https://other.example' WHERE name = 'PARTITIONED'",
		).run();
		db.close();

		const result = await cookies.getBrowserCookiesForHosts({
			hosts: ["gemini.google.com"],
			requestUrl: new URL("https://gemini.google.com/app"),
		});

		expect(result?.cookies).toEqual({ VALID: "v" });
	});

	test("reads rows that still live in the WAL sidecar", async () => {
		const profileDir = join(home, CHROME_ROOT, "Default");
		await mkdir(profileDir, { recursive: true });
		const dbPath = join(profileDir, "Cookies");
		const db = createCookieDb(dbPath);
		db.exec("PRAGMA journal_mode = WAL");
		insertCookieRows(db, [{ host: "gemini.google.com", name: "NID", value: "n1" }]);

		const result = await cookies.getBrowserCookiesForHosts({
			hosts: ["gemini.google.com"],
			browser: "chrome",
			profile: "Default",
		});

		db.close();
		expect(result?.cookies).toEqual({ NID: "n1" });
	});
});

describe("snapshot lifecycle", () => {
	test("removes the snapshot after a successful read", async () => {
		await writeProfile([{ host: "gemini.google.com", name: "NID", value: "n1" }]);

		await cookies.getBrowserCookiesForHosts({ hosts: ["gemini.google.com"] });

		expect(await snapshotDirs()).toEqual([]);
	});

	test("removes the snapshot when the profile is skipped", async () => {
		await writeProfile([{ host: "gemini.google.com", name: "NID", value: "n1" }]);

		const result = await cookies.getBrowserCookiesForHosts({
			hosts: ["gemini.google.com"],
			browser: "chrome",
			requiredCookies: ["__Secure-1PSID"],
		});

		expect(result).toBeNull();
		expect(await snapshotDirs()).toEqual([]);
	});

	test("removes the snapshot when the copy fails", async () => {
		const profileDir = join(home, CHROME_ROOT, "Default");
		await mkdir(join(profileDir, "Cookies"), { recursive: true });

		await expect(
			cookies.getBrowserCookiesForHosts({
				hosts: ["gemini.google.com"],
				browser: "chrome",
				profile: "Default",
			}),
		).rejects.toThrow();
		expect(await snapshotDirs()).toEqual([]);
	});
});

describe("KWallet fallback", () => {
	test("retries every required cookie with one KWallet lookup", async () => {
		vi.stubEnv("KDE_FULL_SESSION", "true");
		h.responses.set("secret-tool", "wrong-secret");
		h.responses.set("kwallet-query", "kwallet-secret");
		await writeProfile([
			{
				host: "gemini.google.com",
				name: "__Secure-1PSID",
				encrypted: encryptV10("first", "kwallet-secret", "gemini.google.com"),
			},
			{
				host: "gemini.google.com",
				name: "__Secure-1PSIDTS",
				encrypted: encryptV10("second", "kwallet-secret", "gemini.google.com"),
			},
		]);

		const result = await cookies.getBrowserCookiesForHosts({
			hosts: ["gemini.google.com"],
			browser: "chrome",
			requiredCookies: ["__Secure-1PSID", "__Secure-1PSIDTS"],
			requiredLabel: "Gemini",
		});

		expect(result?.cookies).toEqual({ "__Secure-1PSID": "first", "__Secure-1PSIDTS": "second" });
		expect(commandCount("kwallet-query")).toBe(1);
	});

	test("does not retry optional cookies through KWallet", async () => {
		vi.stubEnv("KDE_FULL_SESSION", "true");
		h.responses.set("secret-tool", "wrong-secret");
		h.responses.set("kwallet-query", "kwallet-secret");
		await writeProfile([
			{
				host: "gemini.google.com",
				name: "OPTIONAL",
				encrypted: encryptV10("from-kwallet", "kwallet-secret", "gemini.google.com"),
			},
		]);

		const result = await cookies.getBrowserCookiesForHosts({ hosts: ["gemini.google.com"] });

		expect(result).toBeNull();
		expect(commandCount("kwallet-query")).toBe(0);
	});

	test("caches the fallback key for later lookups", async () => {
		vi.stubEnv("KDE_FULL_SESSION", "true");
		h.responses.set("secret-tool", "wrong-secret");
		h.responses.set("kwallet-query", "kwallet-secret");
		await writeProfile([
			{
				host: "gemini.google.com",
				name: "__Secure-1PSID",
				encrypted: encryptV10("cached", "kwallet-secret", "gemini.google.com"),
			},
		]);
		const request = {
			hosts: ["gemini.google.com"],
			browser: "chrome" as const,
			requiredCookies: ["__Secure-1PSID"],
		};

		expect((await cookies.getBrowserCookiesForHosts(request))?.cookies).toEqual({
			"__Secure-1PSID": "cached",
		});
		expect((await cookies.getBrowserCookiesForHosts(request))?.cookies).toEqual({
			"__Secure-1PSID": "cached",
		});
		expect(commandCount("secret-tool")).toBe(1);
		expect(commandCount("kwallet-query")).toBe(1);
		expect(commandCount("secret-tool")).toBe(1);
		expect(commandCount("kwallet-query")).toBe(1);
	});
});

describe("failure diagnostics", () => {
	test("reports missing required cookies with per-profile attempts", async () => {
		await writeProfile([{ host: "gemini.google.com", name: "NID", value: "n1" }]);

		const result = await cookies.getBrowserCookiesForHosts({
			hosts: ["gemini.google.com"],
			browser: "chrome",
			profile: "Default",
			requiredCookies: ["__Secure-1PSID"],
			requiredLabel: "Gemini",
		});

		expect(result).toBeNull();
		expect(cookies.getLastBrowserCookieDiagnostic()).toBe(
			"No detected Chromium profile contains the required Gemini cookies.",
		);
		expect(cookies.getLastGoogleCookieDiagnosticDetails()?.attempts).toEqual([
			{ browser: "Chrome", profile: "Default", status: "missing-required-cookies" },
		]);
	});

	test("reports undecryptable required cookies", async () => {
		await writeProfile([
			{
				host: "gemini.google.com",
				name: "__Secure-1PSID",
				encrypted: encryptV10("value", "another-secret", "gemini.google.com"),
			},
		]);

		const result = await cookies.getBrowserCookiesForHosts({
			hosts: ["gemini.google.com"],
			browser: "chrome",
			profile: "Default",
			requiredCookies: ["__Secure-1PSID"],
			requiredLabel: "Gemini",
		});

		expect(result).toBeNull();
		expect(cookies.getLastBrowserCookieDiagnostic()).toBe(
			"Required Gemini cookies could not be decrypted.",
		);
	});

	test("reports a named profile without a cookie database", async () => {
		const result = await cookies.getBrowserCookiesForHosts({
			hosts: ["gemini.google.com"],
			browser: "chrome",
			profile: "Profile 7",
		});

		expect(result).toBeNull();
		expect(cookies.getLastBrowserCookieDiagnostic()).toBe(
			"Chromium profile 'Profile 7' does not contain a cookie database.",
		);
	});

	test("rejects a profile that resolves outside the browser root", async () => {
		const outside = await mkdtemp(join(h.tmp, "pi-cookies-outside-"));
		writeCookieDb(join(outside, "Cookies"), [
			{ host: "gemini.google.com", name: "NID", value: "n1" },
		]);
		await mkdir(join(home, CHROME_ROOT), { recursive: true });
		await symlink(outside, join(home, CHROME_ROOT, "Default"), "junction");

		const result = await cookies.getBrowserCookiesForHosts({
			hosts: ["gemini.google.com"],
			browser: "chrome",
			profile: "Default",
		});

		expect(result).toBeNull();
		expect(cookies.getLastBrowserCookieDiagnostic()).toBe(
			"Configured Chromium profile must resolve inside the browser profile root.",
		);
	});

	test("rejects a profile name that looks like a path", async () => {
		const result = await cookies.getBrowserCookiesForHosts({
			hosts: ["gemini.google.com"],
			profile: "../escape",
		});

		expect(result).toBeNull();
		expect(cookies.getLastBrowserCookieDiagnostic()).toBe(
			"Configured Chromium profile must be a profile directory name, not a path.",
		);
	});

	test("rejects a preset that this platform does not support", async () => {
		const result = await cookies.getBrowserCookiesForHosts({
			hosts: ["gemini.google.com"],
			browser: "arc",
		});

		expect(result).toBeNull();
		expect(cookies.getLastBrowserCookieDiagnostic()).toBe(
			"Browser preset 'arc' is not supported on this platform.",
		);
	});

	test("requires browser cookie access to be allowed", async () => {
		vi.stubEnv("PI_ALLOW_BROWSER_COOKIES", undefined);

		const result = await cookies.getBrowserCookiesForHosts({ hosts: ["gemini.google.com"] });

		expect(result).toBeNull();
		expect(cookies.getLastBrowserCookieDiagnostic()).toBe(
			"Browser cookie access is disabled; enable allowBrowserCookies to use browser cookies.",
		);
	});
});

describe("Windows app-bound cookies", () => {
	test("reports the v20 diagnostic instead of a decryption failure", async () => {
		setPlatform("win32");
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv("LOCALAPPDATA", home);
		const dataDir = join(home, "Google", "Chrome", "User Data");
		const profileDir = join(dataDir, "Default");
		await mkdir(profileDir, { recursive: true });
		const dpapiKey = randomBytes(32);
		await writeFile(
			join(dataDir, "Local State"),
			JSON.stringify({
				os_crypt: {
					encrypted_key: Buffer.concat([Buffer.from("DPAPI"), dpapiKey]).toString("base64"),
				},
			}),
		);
		h.responses.set("powershell.exe", dpapiKey.toString("base64"));
		writeCookieDb(join(profileDir, "Cookies"), [
			{
				host: "gemini.google.com",
				name: "__Secure-1PSID",
				encrypted: Buffer.concat([Buffer.from("v20"), randomBytes(48)]),
			},
		]);

		const result = await cookies.getBrowserCookiesForHosts({
			hosts: ["gemini.google.com"],
			browser: "chrome",
			profile: "Default",
			requiredCookies: ["__Secure-1PSID"],
			requiredLabel: "Gemini",
		});

		expect(result).toBeNull();
		expect(cookies.getLastBrowserCookieDiagnostic()).toBe(
			"Windows Chromium v20 app-bound cookies are not supported.",
		);
	});
});
