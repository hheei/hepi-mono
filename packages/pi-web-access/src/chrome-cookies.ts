import { execFile } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { type BrowserCookiePreset, isBrowserCookieAccessAllowed } from "./gemini-web-config.ts";

export type CookieMap = Record<string, string>;

interface BrowserConfig {
	id: BrowserCookiePreset;
	name: string;
	baseDir: string;
	usesLocalAppData?: boolean;
	keychainService?: string;
	keychainAccount?: string;
	secretToolApp?: string;
	kwalletFolder?: string;
	kwalletEntry?: string;
}

type BrowserPassword = {
	value: string | null;
	source?: "secret-service" | "kwallet";
	warning?: string;
};

type SqliteRow = Record<string, unknown>;
type SqliteFailure = "unavailable" | "query";

export type BrowserCookieAttemptStatus =
	| "missing-database"
	| "missing-required-cookies"
	| "password-read-failed"
	| "decryption-failed"
	| "sqlite-unavailable"
	| "sqlite-query-failed"
	| "unsafe-profile"
	| "no-host-cookies";

export interface BrowserCookieAttemptDiagnostic {
	browser: string;
	profile: string;
	status: BrowserCookieAttemptStatus;
}

export interface BrowserCookieDiagnosticDetails {
	message: string;
	attempts: BrowserCookieAttemptDiagnostic[];
}

interface BrowserCookieEntry {
	name: string;
	value: string;
	path: string;
}

const GOOGLE_ORIGINS = [
	"https://gemini.google.com",
	"https://accounts.google.com",
	"https://www.google.com",
];

const ALL_COOKIE_NAMES = new Set([
	"__Secure-1PSID",
	"__Secure-1PSIDTS",
	"__Secure-1PSIDCC",
	"__Secure-1PAPISID",
	"NID",
	"AEC",
	"SOCS",
	"__Secure-BUCKET",
	"__Secure-ENID",
	"SID",
	"HSID",
	"SSID",
	"APISID",
	"SAPISID",
	"__Secure-3PSID",
	"__Secure-3PSIDTS",
	"__Secure-3PAPISID",
	"SIDCC",
]);

const MACOS_BROWSER_CONFIGS: BrowserConfig[] = [
	{
		id: "helium",
		name: "Helium",
		baseDir: "Library/Application Support/net.imput.helium",
		keychainService: "Helium Storage Key",
		keychainAccount: "Helium",
	},
	{
		id: "chrome",
		name: "Chrome",
		baseDir: "Library/Application Support/Google/Chrome",
		keychainService: "Chrome Safe Storage",
		keychainAccount: "Chrome",
	},
	{
		id: "brave",
		name: "Brave",
		baseDir: "Library/Application Support/BraveSoftware/Brave-Browser",
		keychainService: "Brave Safe Storage",
		keychainAccount: "Brave",
	},
	{
		id: "arc",
		name: "Arc",
		baseDir: "Library/Application Support/Arc/User Data",
		keychainService: "Arc Safe Storage",
		keychainAccount: "Arc",
	},
];

const LINUX_BROWSER_CONFIGS: BrowserConfig[] = [
	{
		id: "chromium",
		name: "Chromium",
		baseDir: ".config/chromium",
		secretToolApp: "chromium",
		kwalletFolder: "Chromium Keys",
		kwalletEntry: "Chromium Safe Storage",
	},
	{
		id: "chrome",
		name: "Chrome",
		baseDir: ".config/google-chrome",
		secretToolApp: "chrome",
		kwalletFolder: "Chrome Keys",
		kwalletEntry: "Chrome Safe Storage",
	},
];

const WINDOWS_BROWSER_CONFIGS: BrowserConfig[] = [
	{ id: "chrome", name: "Chrome", baseDir: "Google/Chrome/User Data", usesLocalAppData: true },
	{ id: "edge", name: "Edge", baseDir: "Microsoft/Edge/User Data", usesLocalAppData: true },
];

const browserPasswordCache = new Map<string, Promise<BrowserPassword[]>>();
let lastCookieDiagnostic: string | null = null;
let lastCookieDiagnosticDetails: BrowserCookieDiagnosticDetails | null = null;
let sqliteModule: typeof import("node:sqlite") | null = null;
let sqliteImportAttempted = false;

export function getLastGoogleCookieDiagnostic(): string | null {
	return lastCookieDiagnostic;
}

export function getLastBrowserCookieDiagnostic(): string | null {
	return lastCookieDiagnostic;
}

export function getLastGoogleCookieDiagnosticDetails(): BrowserCookieDiagnosticDetails | null {
	return lastCookieDiagnosticDetails;
}

export async function getGoogleCookies(options?: {
	browser?: BrowserCookiePreset | undefined;
	profile?: string | undefined;
	requiredCookies?: string[] | undefined;
}): Promise<{ cookies: CookieMap; warnings: string[] } | null> {
	return getBrowserCookiesForHosts({
		hosts: GOOGLE_ORIGINS.map((origin) => new URL(origin).hostname),
		browser: options?.browser,
		profile: options?.profile,
		requiredCookies: options?.requiredCookies,
		cookieNames: ALL_COOKIE_NAMES,
		requiredLabel: "Gemini",
	});
}

/** Everything the per-profile attempts of one lookup share. */
interface CookieRequest {
	platform: typeof process.platform;
	home: string;
	hosts: string[];
	requiredCookies: string[] | undefined;
	cookieNames: string[] | undefined;
	requestUrl: URL | undefined;
	requiredLabel: string | undefined;
	/** Warnings collected across attempts; a successful attempt returns them. */
	warnings: Set<string>;
}

/** What one profile attempt observed, whether or not it returned cookies. */
interface ProfileAttempt {
	browser: string;
	profile: string;
	status: BrowserCookieAttemptStatus;
	backendFailure: SqliteFailure | undefined;
	/** The copied database was readable, so the profile was a real candidate. */
	sawDatabase: boolean;
	/** The required cookie names were present before decryption. */
	sawRequired: boolean;
	/** At least one host cookie decrypted, even if the required set was incomplete. */
	sawHostCookie: boolean;
	/** A Windows v20 app-bound cookie was skipped. */
	sawAppBoundCookie: boolean;
}

type AttemptOutcome =
	| { kind: "cookies"; cookies: CookieMap; cookieHeader: string | undefined }
	| { kind: "skip"; attempt: ProfileAttempt };

/** Key material for one profile's database. */
interface ProfileKeys {
	/** Chromium keychain/secret-service keys, tried in order. */
	browserKeys: Buffer[];
	/** Windows DPAPI key. */
	windowsKey: Buffer | null;
	/** Keychain/secret-service entries, reused by the KWallet fallback. */
	sources: BrowserPassword[];
	kwalletAttempted: boolean;
}

interface BrowserCookieRequestOptions {
	hosts: string[];
	browser?: BrowserCookiePreset | undefined;
	profile?: string | undefined;
	requiredCookies?: string[] | undefined;
	cookieNames?: Iterable<string> | undefined;
	requiredLabel?: string | undefined;
	requestUrl?: URL | undefined;
}

export async function getBrowserCookiesForHosts(
	options: BrowserCookieRequestOptions,
): Promise<{ cookies: CookieMap; warnings: string[]; cookieHeader?: string } | null> {
	lastCookieDiagnostic = null;
	lastCookieDiagnosticDetails = null;
	const plan = planCookieRequest(options);
	if (plan.kind === "diagnostic") {
		setCookieDiagnostic(plan.message);
		return null;
	}

	const { request, configs, requestedProfile } = plan;
	const attempts: ProfileAttempt[] = [];
	for (const config of configs) {
		const profiles = requestedProfile
			? [requestedProfile]
			: listBrowserProfiles(request.home, config);
		for (const profile of profiles) {
			const outcome = await attemptProfile(request, config, profile);
			if (outcome.kind === "cookies") {
				return {
					cookies: outcome.cookies,
					warnings: [...request.warnings],
					...(outcome.cookieHeader !== undefined ? { cookieHeader: outcome.cookieHeader } : {}),
				};
			}
			attempts.push(outcome.attempt);
		}
	}

	setCookieDiagnostic(
		cookieFailureDiagnostic(request, requestedProfile, attempts),
		attempts.map(({ browser, profile, status }) => ({ browser, profile, status })),
	);
	return null;
}

type CookieRequestPlan =
	| {
			kind: "request";
			request: CookieRequest;
			configs: BrowserConfig[];
			requestedProfile: string | undefined;
	  }
	| { kind: "diagnostic"; message: string };

/** Validates the request and resolves the browser configs it may read. */
function planCookieRequest(options: BrowserCookieRequestOptions): CookieRequestPlan {
	if (!isBrowserCookieAccessAllowed()) {
		return {
			kind: "diagnostic",
			message:
				"Browser cookie access is disabled; enable allowBrowserCookies to use browser cookies.",
		};
	}

	const platform = process.platform;
	const platformConfigs =
		platform === "darwin"
			? MACOS_BROWSER_CONFIGS
			: platform === "linux"
				? LINUX_BROWSER_CONFIGS
				: platform === "win32"
					? WINDOWS_BROWSER_CONFIGS
					: [];
	const configs = options.browser
		? platformConfigs.filter((config) => config.id === options.browser)
		: platformConfigs;
	if (options.browser && configs.length === 0) {
		return {
			kind: "diagnostic",
			message: `Browser preset '${options.browser}' is not supported on this platform.`,
		};
	}
	if (configs.length === 0) {
		return {
			kind: "diagnostic",
			message: "Chromium cookie extraction is unsupported on this platform.",
		};
	}

	const rawProfile = typeof options.profile === "string" ? options.profile.trim() : "";
	const requestedProfile = normalizeProfileName(options.profile);
	if (rawProfile && !requestedProfile) {
		return {
			kind: "diagnostic",
			message: "Configured Chromium profile must be a profile directory name, not a path.",
		};
	}

	const hosts = normalizeHosts(options.hosts);
	if (hosts.length === 0) {
		return { kind: "diagnostic", message: "No valid cookie hosts were requested." };
	}

	return {
		kind: "request",
		configs,
		requestedProfile,
		request: {
			platform,
			home: platform === "win32" ? process.env.USERPROFILE || homedir() : homedir(),
			hosts,
			requiredCookies: normalizeCookieNames(options.requiredCookies),
			cookieNames: normalizeCookieNames(options.cookieNames ? [...options.cookieNames] : undefined),
			requestUrl: options.requestUrl,
			requiredLabel: options.requiredLabel,
			warnings: new Set<string>(),
		},
	};
}

/**
 * One profile attempt owns its database snapshot: copy, read, decrypt, filter, and
 * always clean the copy up. Profile path confinement and the cookie database
 * lookup happen before any copy is made.
 */
async function attemptProfile(
	request: CookieRequest,
	config: BrowserConfig,
	profile: string,
): Promise<AttemptOutcome> {
	const profilePath = resolveProfilePath(request.home, config, profile);
	if (profilePath === "outside-root") return skipped(config, profile, "unsafe-profile");
	if (!profilePath) return skipped(config, profile, "missing-database");
	const cookiesPath = cookieDatabasePath(profilePath, config);
	if (!cookiesPath) return skipped(config, profile, "missing-database");

	const tempDir = mkdtempSync(join(tmpdir(), "pi-chrome-cookies-"));
	try {
		const tempDb = join(tempDir, "Cookies");
		copyFileSync(cookiesPath, tempDb);
		copySidecar(cookiesPath, tempDb, "-wal");
		copySidecar(cookiesPath, tempDb, "-shm");
		return await readProfileCookies(request, config, profile, tempDb);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

/** Reads one snapshot: required-cookie preflight, key material, rows, decryption. */
async function readProfileCookies(
	request: CookieRequest,
	config: BrowserConfig,
	profile: string,
	tempDb: string,
): Promise<AttemptOutcome> {
	const { requiredCookies } = request;
	if (requiredCookies?.length) {
		const preflight = await hasCookieNames(tempDb, request.hosts, requiredCookies);
		if (preflight.failure) return backendFailure(config, profile, preflight.failure);
		if (!preflight.present) {
			return skipped(config, profile, "missing-required-cookies", { sawDatabase: true });
		}
	}

	const keys = await loadProfileKeys(request, config);
	if (!keys) {
		return skipped(config, profile, "password-read-failed", {
			sawDatabase: true,
			sawRequired: Boolean(requiredCookies?.length),
		});
	}

	const metaVersion = await readMetaVersion(tempDb);
	if (metaVersion.value === null) return backendFailure(config, profile, "unavailable");

	const rows = await queryCookieRows(
		tempDb,
		request.hosts,
		request.cookieNames ?? null,
		Boolean(request.requestUrl),
	);
	if (rows.status === "failure") return backendFailure(config, profile, rows.failure);

	const observed = {
		sawDatabase: true,
		sawRequired: Boolean(requiredCookies?.length),
	};
	const entries: BrowserCookieEntry[] = [];
	const cookies: CookieMap = {};
	const failedRequired = new Set<string>();
	let appBoundCookie = false;

	for (const row of rows.rows) {
		const name = typeof row.name === "string" ? row.name : "";
		if (!name) continue;
		let value = typeof row.value === "string" && row.value.length > 0 ? row.value : null;
		const encryptedHex = row.encrypted_value_hex;
		if (!value && typeof encryptedHex === "string" && /^[0-9a-f]*$/i.test(encryptedHex)) {
			const decrypted = await decryptRowValue(
				request,
				config,
				name,
				Buffer.from(encryptedHex, "hex"),
				keys,
				metaVersion.value,
				typeof row.host_key === "string" ? row.host_key : "",
			);
			value = decrypted.value;
			if (decrypted.appBoundCookie) appBoundCookie = true;
			if (!value && requiredCookies?.includes(name)) failedRequired.add(name);
		}
		if (!value) continue;
		const path = typeof row.path === "string" && row.path.startsWith("/") ? row.path : "/";
		if (request.requestUrl && !pathMatches(request.requestUrl.pathname || "/", path)) continue;
		entries.push({ name, value, path });
		if (!cookies[name]) cookies[name] = value;
	}

	const outcome = {
		...observed,
		sawHostCookie: entries.length > 0,
		sawAppBoundCookie: appBoundCookie,
	};
	if (requiredCookies?.length && !requiredCookies.every((name) => Boolean(cookies[name]))) {
		const decryptFailed = requiredCookies.some(
			(name) => !cookies[name] && failedRequired.has(name),
		);
		return skipped(
			config,
			profile,
			decryptFailed ? "decryption-failed" : "missing-required-cookies",
			outcome,
		);
	}
	if (entries.length === 0) {
		return skipped(
			config,
			profile,
			failedRequired.size > 0 ? "decryption-failed" : "no-host-cookies",
			outcome,
		);
	}
	return {
		kind: "cookies",
		cookies,
		cookieHeader: request.requestUrl ? buildCookieHeader(entries) : undefined,
	};
}

/** Keychain/secret-service (or Windows DPAPI) key material for one profile. */
async function loadProfileKeys(
	request: CookieRequest,
	config: BrowserConfig,
): Promise<ProfileKeys | null> {
	const { platform, home, warnings } = request;
	const sources = platform === "win32" ? [] : await readBrowserPasswords(config, platform);
	for (const source of sources) if (source.warning) warnings.add(source.warning);
	const windowsKey = platform === "win32" ? await readWindowsEncryptionKey(config, home) : null;
	const browserKeys = sources.flatMap((source) =>
		source.value
			? [pbkdf2Sync(source.value, "saltysalt", platform === "darwin" ? 1003 : 1, 16, "sha1")]
			: [],
	);
	if (platform === "win32" ? !windowsKey : browserKeys.length === 0) {
		warnings.add(
			platform === "win32"
				? `Could not read ${config.name} Windows cookie encryption key`
				: `Could not read ${config.name} cookie encryption password`,
		);
		return null;
	}
	return {
		browserKeys,
		windowsKey,
		sources,
		kwalletAttempted: sources.some((source) => source.source === "kwallet"),
	};
}

/** Decrypts one row value: DPAPI on Windows, otherwise the key list with a KWallet retry. */
async function decryptRowValue(
	request: CookieRequest,
	config: BrowserConfig,
	name: string,
	encrypted: Buffer,
	keys: ProfileKeys,
	metaVersion: number,
	hostKey: string,
): Promise<{ value: string | null; appBoundCookie: boolean }> {
	const { platform, requiredCookies, warnings } = request;
	const appBoundCookie =
		platform === "win32" && encrypted.subarray(0, 3).toString("utf8") === "v20";
	const hostHash = metaVersion >= 24 ? createHash("sha256").update(hostKey).digest() : null;

	if (platform === "win32") {
		return {
			value: keys.windowsKey
				? decryptWindowsCookieValue(encrypted, keys.windowsKey, hostHash)
				: null,
			appBoundCookie,
		};
	}

	for (const key of keys.browserKeys) {
		const value = decryptCookieValue(encrypted, key, hostHash);
		if (value) return { value, appBoundCookie };
	}

	// KWallet gets one shot per profile, and only for a required cookie that the
	// secret service could not decrypt. A success is cached so later rows skip it.
	if (platform !== "linux" || keys.kwalletAttempted) return { value: null, appBoundCookie };
	if (!keys.sources.some((source) => source.source === "secret-service")) {
		return { value: null, appBoundCookie };
	}
	if (!requiredCookies?.includes(name)) return { value: null, appBoundCookie };

	keys.kwalletAttempted = true;
	const fallback = await readKWalletPassword(config);
	if (fallback.warning) warnings.add(fallback.warning);
	if (!fallback.value) return { value: null, appBoundCookie };
	const key = pbkdf2Sync(fallback.value, "saltysalt", 1, 16, "sha1");
	keys.browserKeys.push(key);
	const value = decryptCookieValue(encrypted, key, hostHash);
	if (!value) return { value: null, appBoundCookie };
	keys.sources.push(fallback);
	browserPasswordCache.set(passwordCacheKey(config, platform), Promise.resolve([...keys.sources]));
	return { value, appBoundCookie };
}

function skipped(
	config: BrowserConfig,
	profile: string,
	status: BrowserCookieAttemptStatus,
	observed: Partial<
		Pick<
			ProfileAttempt,
			"backendFailure" | "sawDatabase" | "sawRequired" | "sawHostCookie" | "sawAppBoundCookie"
		>
	> = {},
): AttemptOutcome {
	return {
		kind: "skip",
		attempt: {
			browser: config.name,
			profile,
			status,
			backendFailure: undefined,
			sawDatabase: false,
			sawRequired: false,
			sawHostCookie: false,
			sawAppBoundCookie: false,
			...observed,
		},
	};
}

function backendFailure(
	config: BrowserConfig,
	profile: string,
	failure: SqliteFailure,
): AttemptOutcome {
	return skipped(
		config,
		profile,
		failure === "unavailable" ? "sqlite-unavailable" : "sqlite-query-failed",
		{ sawDatabase: true, backendFailure: failure },
	);
}

/** The failure that best explains why no profile produced cookies. */
function cookieFailureDiagnostic(
	request: CookieRequest,
	requestedProfile: string | undefined,
	attempts: ProfileAttempt[],
): string {
	const label = request.requiredLabel ?? "browser";
	const backendFailure = attempts.reduce<SqliteFailure | undefined>(
		(last, attempt) => attempt.backendFailure ?? last,
		undefined,
	);

	if (backendFailure === "unavailable") {
		return "SQLite backend unavailable: install sqlite3 or use a runtime with SQLite support.";
	}
	if (backendFailure === "query") {
		return "SQLite query failed while reading the copied Chromium cookie database.";
	}
	if (attempts.some((attempt) => attempt.status === "unsafe-profile")) {
		return "Configured Chromium profile must resolve inside the browser profile root.";
	}
	if (!attempts.some((attempt) => attempt.sawDatabase)) {
		return requestedProfile
			? `Chromium profile '${requestedProfile}' does not contain a cookie database.`
			: "No detected Chromium profile contains a cookie database.";
	}
	if (request.requiredCookies?.length && !attempts.some((attempt) => attempt.sawRequired)) {
		return `No detected Chromium profile contains the required ${label} cookies.`;
	}
	if (attempts.some((attempt) => attempt.sawAppBoundCookie)) {
		return "Windows Chromium v20 app-bound cookies are not supported.";
	}
	const [firstWarning] = [...request.warnings];
	if (firstWarning) return firstWarning;
	if (attempts.some((attempt) => attempt.status === "decryption-failed")) {
		return `Required ${label} cookies could not be decrypted.`;
	}
	if (!attempts.some((attempt) => attempt.sawHostCookie)) {
		return request.requestUrl
			? "No detected Chromium profile contains cookies for the requested URL."
			: "No detected Chromium profile contains cookies for the requested host.";
	}
	return "Required Gemini cookies were not available or could not be decrypted.";
}

function setCookieDiagnostic(
	message: string,
	attempts: BrowserCookieAttemptDiagnostic[] = [],
): void {
	lastCookieDiagnostic = message;
	lastCookieDiagnosticDetails = { message, attempts };
}

function normalizeProfileName(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	if (!normalized) return undefined;
	if (
		isAbsolute(normalized) ||
		normalized === "." ||
		normalized === ".." ||
		normalized.includes("/") ||
		normalized.includes("\\")
	) {
		return undefined;
	}
	return normalized;
}

function resolveProfilePath(
	home: string,
	config: BrowserConfig,
	profile: string,
): string | "outside-root" | null {
	const basePath = browserBasePath(home, config);
	const profilePath = join(basePath, profile);
	if (!cookieDatabasePath(profilePath, config)) return null;
	try {
		const baseRealPath = realpathSync(basePath);
		const profileRealPath = realpathSync(profilePath);
		if (profileRealPath !== baseRealPath && !profileRealPath.startsWith(`${baseRealPath}${sep}`))
			return "outside-root";
		return profileRealPath;
	} catch {
		return null;
	}
}

function cookieDatabasePath(profilePath: string, config: BrowserConfig): string | null {
	const networkCookies = join(profilePath, "Network", "Cookies");
	if (config.usesLocalAppData && existsSync(networkCookies)) return networkCookies;
	const legacyCookies = join(profilePath, "Cookies");
	return existsSync(legacyCookies) ? legacyCookies : null;
}

function browserBasePath(home: string, config: BrowserConfig): string {
	return config.usesLocalAppData
		? join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), config.baseDir)
		: join(home, config.baseDir);
}

function normalizeCookieNames(names: string[] | undefined): string[] | undefined {
	if (!names?.length) return undefined;
	const normalized = names
		.filter((name): name is string => typeof name === "string")
		.map((name) => name.trim())
		.filter(Boolean);
	return normalized.length > 0 ? [...new Set(normalized)] : undefined;
}

function normalizeHosts(hosts: string[]): string[] {
	return [
		...new Set(
			hosts
				.map((host) =>
					host
						.trim()
						.toLowerCase()
						.replace(/^\[|\]$/g, "")
						.replace(/\.$/, ""),
				)
				.filter(Boolean),
		),
	];
}

function listBrowserProfiles(home: string, config: BrowserConfig): string[] {
	const basePath = browserBasePath(home, config);
	if (!existsSync(basePath)) return ["Default"];
	const profiles = new Set<string>();
	try {
		for (const entry of readdirSync(basePath, { withFileTypes: true })) {
			if (entry.isDirectory() && cookieDatabasePath(join(basePath, entry.name), config))
				profiles.add(entry.name);
		}
	} catch {}
	if (profiles.size === 0) return ["Default"];
	return [...profiles].sort(compareProfileNames);
}

function compareProfileNames(a: string, b: string): number {
	const key = (name: string): [number, number] => {
		if (name === "Default") return [0, 0];
		const profile = /^Profile\s+(\d+)$/i.exec(name);
		if (profile) return [1, Number(profile[1])];
		const person = /^Person\s+(\d+)$/i.exec(name);
		if (person) return [2, Number(person[1])];
		return [3, Number.MAX_SAFE_INTEGER];
	};
	const [ap, ai] = key(a);
	const [bp, bi] = key(b);
	return (
		ap - bp || ai - bi || a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })
	);
}

/** v24+ rows prefix the plaintext with sha256(host_key), which also rejects a wrong key. */
function stripHostHash(payload: Buffer, hostHash: Buffer | null): Buffer | null {
	if (!hostHash) return payload;
	if (payload.length < 32 || !payload.subarray(0, 32).equals(hostHash)) return null;
	return payload.subarray(32);
}

function decryptCookieValue(
	encrypted: Uint8Array,
	key: Buffer,
	hostHash: Buffer | null,
): string | null {
	const buf = Buffer.from(encrypted);
	if (buf.length < 3 || !/^v\d\d$/.test(buf.subarray(0, 3).toString("utf8"))) return null;
	const ciphertext = buf.subarray(3);
	if (!ciphertext.length) return "";
	try {
		const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
		decipher.setAutoPadding(false);
		const unpadded = removePkcs7Padding(
			Buffer.concat([decipher.update(ciphertext), decipher.final()]),
		);
		const payload = stripHostHash(unpadded, hostHash);
		if (!payload) return null;
		const decoded = new TextDecoder("utf-8", { fatal: true }).decode(payload);
		let i = 0;
		while (i < decoded.length && decoded.charCodeAt(i) < 0x20) i++;
		return decoded.slice(i);
	} catch {
		return null;
	}
}

function decryptWindowsCookieValue(
	encrypted: Uint8Array,
	key: Buffer,
	hostHash: Buffer | null,
): string | null {
	const buf = Buffer.from(encrypted);
	if (buf.subarray(0, 3).toString("utf8") !== "v10" || buf.length < 3 + 12 + 16) return null;
	try {
		const nonce = buf.subarray(3, 15);
		const ciphertext = buf.subarray(15, -16);
		const decipher = createDecipheriv("aes-256-gcm", key, nonce);
		decipher.setAuthTag(buf.subarray(-16));
		const payload = stripHostHash(
			Buffer.concat([decipher.update(ciphertext), decipher.final()]),
			hostHash,
		);
		return payload ? new TextDecoder("utf-8", { fatal: true }).decode(payload) : null;
	} catch {
		return null;
	}
}

function removePkcs7Padding(buf: Buffer): Buffer {
	if (!buf.length) return buf;
	const padding = buf[buf.length - 1];
	return !padding || padding > 16 ? buf : buf.subarray(0, buf.length - padding);
}

function passwordCacheKey(config: BrowserConfig, currentPlatform: typeof process.platform): string {
	return `${currentPlatform}:${config.name}`;
}

function readBrowserPasswords(
	config: BrowserConfig,
	currentPlatform: typeof process.platform,
): Promise<BrowserPassword[]> {
	const cacheKey = passwordCacheKey(config, currentPlatform);
	const cached = browserPasswordCache.get(cacheKey);
	if (cached) return cached;
	const passwordResult =
		currentPlatform === "darwin"
			? config.keychainAccount && config.keychainService
				? readKeychainPassword(config.keychainAccount, config.keychainService).then((value) => ({
						value,
						cacheable: Boolean(value),
					}))
				: Promise.resolve({ value: null, cacheable: false })
			: currentPlatform === "linux"
				? readLinuxPassword(config)
				: Promise.resolve({ value: null, cacheable: false });
	const passwordPromise = passwordResult.then(
		({ cacheable, ...password }) => {
			if (!cacheable) browserPasswordCache.delete(cacheKey);
			return [password];
		},
		(error) => {
			browserPasswordCache.delete(cacheKey);
			throw error;
		},
	);
	browserPasswordCache.set(cacheKey, passwordPromise);
	return passwordPromise;
}

async function readWindowsEncryptionKey(
	config: BrowserConfig,
	home: string,
): Promise<Buffer | null> {
	try {
		const localState = JSON.parse(
			readFileSync(join(browserBasePath(home, config), "Local State"), "utf8"),
		) as { os_crypt?: { encrypted_key?: unknown } };
		const encodedKey = localState.os_crypt?.encrypted_key;
		if (typeof encodedKey !== "string") return null;
		const protectedKey = Buffer.from(encodedKey, "base64");
		if (protectedKey.subarray(0, 5).toString("utf8") !== "DPAPI") return null;
		const decrypted = await unprotectWindowsData(protectedKey.subarray(5));
		return decrypted?.length === 32 ? decrypted : null;
	} catch {
		return null;
	}
}

function unprotectWindowsData(protectedData: Buffer): Promise<Buffer | null> {
	return new Promise((resolve) => {
		const script =
			"Add-Type -AssemblyName System.Security;$data=[Convert]::FromBase64String($env:PIWA_PROTECTED);$clear=[System.Security.Cryptography.ProtectedData]::Unprotect($data,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Write([Convert]::ToBase64String($clear))";
		const encoded = Buffer.from(script, "utf16le").toString("base64");
		execFile(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
			{
				timeout: 5000,
				maxBuffer: 1024 * 1024,
				env: { ...process.env, PIWA_PROTECTED: protectedData.toString("base64") },
			},
			(err, stdout) => {
				if (err) {
					resolve(null);
					return;
				}
				try {
					resolve(Buffer.from(stdout.trim(), "base64"));
				} catch {
					resolve(null);
				}
			},
		);
	});
}

function readKeychainPassword(account: string, service: string): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(
			"security",
			["find-generic-password", "-w", "-a", account, "-s", service],
			{ timeout: 5000 },
			(err, stdout) => {
				if (err) {
					resolve(null);
					return;
				}
				resolve(stdout.trim() || null);
			},
		);
	});
}

function readLinuxCommandPassword(
	command: string,
	args: string[],
): Promise<{ value: string | null; failed: boolean }> {
	return new Promise((resolve) => {
		execFile(command, args, { timeout: 5000 }, (err, stdout) =>
			resolve({ value: err ? null : stdout.trim() || null, failed: Boolean(err) }),
		);
	});
}

function isKdeSession(): boolean {
	const desktop = process.env.XDG_CURRENT_DESKTOP?.toLowerCase().split(":") ?? [];
	return process.env.KDE_FULL_SESSION?.toLowerCase() === "true" || desktop.includes("kde");
}

async function readKWalletPassword(config: BrowserConfig): Promise<BrowserPassword> {
	if (!isKdeSession() || !config.kwalletFolder || !config.kwalletEntry) return { value: null };
	const result = await readLinuxCommandPassword("kwallet-query", [
		"-f",
		config.kwalletFolder,
		"-r",
		config.kwalletEntry,
		"kdewallet",
	]);
	return {
		value: result.value,
		...(result.value ? { source: "kwallet" as const } : {}),
		...(result.failed
			? { warning: `Could not read ${config.name} KWallet cookie encryption password` }
			: {}),
	};
}

async function readLinuxPassword(
	config: BrowserConfig,
): Promise<BrowserPassword & { cacheable: boolean }> {
	if (!config.secretToolApp) return { value: "peanuts", cacheable: false };
	const secretService = await readLinuxCommandPassword("secret-tool", [
		"lookup",
		"application",
		config.secretToolApp,
	]);
	if (secretService.value)
		return { value: secretService.value, source: "secret-service", cacheable: true };
	const kwallet = await readKWalletPassword(config);
	if (kwallet.value) return { ...kwallet, cacheable: true };
	return {
		value: "peanuts",
		...(kwallet.warning !== undefined ? { warning: kwallet.warning } : {}),
		cacheable: false,
	};
}

async function importSqlite(): Promise<typeof import("node:sqlite") | null> {
	if (process.env.PI_WEB_ACCESS_DISABLE_NODE_SQLITE === "1") return null;
	if (sqliteImportAttempted) return sqliteModule;
	sqliteImportAttempted = true;
	try {
		sqliteModule = await import("node:sqlite");
	} catch {
		sqliteModule = null;
	}
	return sqliteModule;
}

type QueryResult =
	| { status: "success"; rows: SqliteRow[] }
	| { status: "failure"; failure: SqliteFailure };

async function runSqliteQuery(dbPath: string, sql: string): Promise<QueryResult> {
	const sqlite = await importSqlite();
	let queryFailed = false;
	if (sqlite) {
		try {
			const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
			try {
				return { status: "success", rows: db.prepare(sql).all() as SqliteRow[] };
			} finally {
				db.close();
			}
		} catch {
			queryFailed = true;
		}
	}

	const cli = await runSqliteCli(dbPath, sql);
	if (cli.status === "success") return cli;
	if (cli.failure === "query") queryFailed = true;
	const python = await runPythonSqlite(dbPath, sql);
	if (python.status === "success") return python;
	if (python.failure === "query") queryFailed = true;
	return { status: "failure", failure: queryFailed ? "query" : "unavailable" };
}

function runSqliteCli(dbPath: string, sql: string): Promise<QueryResult> {
	return new Promise((resolve) => {
		execFile(
			"sqlite3",
			["-readonly", "-json", dbPath, sql],
			{ timeout: 5000, maxBuffer: 1024 * 1024 },
			(err, stdout) => {
				if (err) {
					resolve({ status: "failure", failure: err.code === "ENOENT" ? "unavailable" : "query" });
					return;
				}
				try {
					const parsed = JSON.parse(stdout || "[]");
					resolve(
						Array.isArray(parsed)
							? { status: "success", rows: parsed as SqliteRow[] }
							: { status: "failure", failure: "query" },
					);
				} catch {
					resolve({ status: "failure", failure: "query" });
				}
			},
		);
	});
}

function runPythonSqlite(dbPath: string, sql: string): Promise<QueryResult> {
	const script =
		"import json,sqlite3,sys\ntry:\n c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)\n c.row_factory=sqlite3.Row\n print(json.dumps([dict(r) for r in c.execute(sys.argv[2]).fetchall()]))\nexcept Exception:\n sys.exit(1)";
	return new Promise((resolve) => {
		execFile(
			"python3",
			["-c", script, dbPath, sql],
			{ timeout: 5000, maxBuffer: 1024 * 1024 },
			(err, stdout) => {
				if (err) {
					resolve({ status: "failure", failure: err.code === "ENOENT" ? "unavailable" : "query" });
					return;
				}
				try {
					const parsed = JSON.parse(stdout || "[]");
					resolve(
						Array.isArray(parsed)
							? { status: "success", rows: parsed as SqliteRow[] }
							: { status: "failure", failure: "query" },
					);
				} catch {
					resolve({ status: "failure", failure: "query" });
				}
			},
		);
	});
}

async function readMetaVersion(
	dbPath: string,
): Promise<{ value: number | null; failure?: SqliteFailure }> {
	const result = await runSqliteQuery(dbPath, "SELECT value FROM meta WHERE key = 'version'");
	if (result.status === "failure") {
		return result.failure === "unavailable"
			? { value: null, failure: result.failure }
			: { value: 0 };
	}
	const value = result.rows[0]?.value;
	if (typeof value === "number") return { value: Math.floor(value) };
	if (typeof value === "string") return { value: parseInt(value, 10) || 0 };
	return { value: 0 };
}

async function hasCookieNames(
	dbPath: string,
	hosts: string[],
	names: string[],
): Promise<{ present: boolean; failure?: SqliteFailure }> {
	const result = await runSqliteQuery(
		dbPath,
		`SELECT DISTINCT name FROM cookies WHERE ${buildCookieWhere(hosts, names)}`,
	);
	if (result.status === "failure") return { present: false, failure: result.failure };
	const present = new Set(result.rows.map((row) => (typeof row.name === "string" ? row.name : "")));
	return { present: names.every((name) => present.has(name)) };
}

async function queryCookieRows(
	dbPath: string,
	hosts: string[],
	names: Iterable<string> | null,
	filterExpired: boolean,
): Promise<QueryResult> {
	const columns = await readCookieColumns(dbPath);
	if (columns.status === "failure") return columns;
	const pathExpr = columns.columns.has("path") ? "path" : "'/' AS path";
	const expiresExpr = columns.columns.has("expires_utc") ? chromeExpiryMillisExpr() : "0";
	const expiryFilter =
		filterExpired && columns.columns.has("expires_utc")
			? ` AND (${expiresExpr} = 0 OR ${expiresExpr} > ${chromeExpiryNowMillis()})`
			: "";
	const partitionFilter = filterExpired ? unpartitionedCookieFilter(columns.columns) : "";
	return runSqliteQuery(
		dbPath,
		`SELECT name, value, host_key, ${pathExpr}, ${expiresExpr} AS expires_utc, hex(encrypted_value) AS encrypted_value_hex FROM cookies WHERE ${buildCookieWhere(hosts, names ?? undefined)}${expiryFilter}${partitionFilter} ORDER BY length(path) DESC, ${expiresExpr} ASC`,
	);
}

async function readCookieColumns(
	dbPath: string,
): Promise<
	{ status: "success"; columns: Set<string> } | { status: "failure"; failure: SqliteFailure }
> {
	const result = await runSqliteQuery(dbPath, "PRAGMA table_info(cookies)");
	if (result.status === "failure") return result;
	return {
		status: "success",
		columns: new Set(result.rows.map((row) => (typeof row.name === "string" ? row.name : ""))),
	};
}

function chromeExpiryMillisExpr(): string {
	return "CASE WHEN expires_utc = 0 THEN 0 ELSE CAST(expires_utc / 1000 AS INTEGER) + CASE WHEN expires_utc % 1000 = 0 THEN 0 ELSE 1 END END";
}

function chromeExpiryNowMillis(): number {
	return Date.now() + 11644473600000;
}

function unpartitionedCookieFilter(columns: Set<string>): string {
	const clauses: string[] = [];
	if (columns.has("top_frame_site_key"))
		clauses.push("(top_frame_site_key IS NULL OR top_frame_site_key = '')");
	if (columns.has("partition_key")) clauses.push("(partition_key IS NULL OR partition_key = '')");
	if (columns.has("is_partitioned")) clauses.push("(is_partitioned IS NULL OR is_partitioned = 0)");
	return clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "";
}

function buildCookieHeader(entries: BrowserCookieEntry[]): string {
	return entries
		.sort((a, b) => b.path.length - a.path.length)
		.map(({ name, value }) => `${name}=${value}`)
		.join("; ");
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
	if (requestPath === cookiePath) return true;
	if (!requestPath.startsWith(cookiePath)) return false;
	if (cookiePath.endsWith("/")) return true;
	return requestPath[cookiePath.length] === "/";
}

function buildCookieWhere(hosts: string[], cookieNames?: Iterable<string>): string {
	const hostClauses: string[] = [];
	for (const host of hosts) {
		const escapedHost = escapeSqlString(host);
		hostClauses.push(`host_key = '${escapedHost}'`);
		for (const candidate of domainCookieHosts(host)) {
			hostClauses.push(`host_key = '.${escapeSqlString(candidate)}'`);
		}
	}
	let where = `(${[...new Set(hostClauses)].join(" OR ")})`;
	const names = cookieNames ? [...cookieNames].filter(Boolean) : [];
	if (names.length)
		where += ` AND name IN (${names.map((name) => `'${escapeSqlString(name)}'`).join(", ")})`;
	return where;
}

function escapeSqlString(value: string): string {
	return value.replaceAll("'", "''");
}

function domainCookieHosts(host: string): string[] {
	const parts = host.split(".").filter(Boolean);
	if (parts.length <= 1) return [];
	const candidates = new Set<string>();
	for (let i = 0; i <= parts.length - 2; i++) candidates.add(parts.slice(i).join("."));
	return [...candidates];
}

function copySidecar(srcDb: string, targetDb: string, suffix: string): void {
	const sidecar = `${srcDb}${suffix}`;
	if (!existsSync(sidecar)) return;
	try {
		copyFileSync(sidecar, `${targetDb}${suffix}`);
	} catch {}
}
