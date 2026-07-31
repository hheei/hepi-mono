import { expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { configureSubagentCoordinator, type ExtensionLifecycleContext } from "@hheei/pi-ext-core";
import { resolveMctxActivation } from "../src/activation.js";
import type { MctxConfiguration } from "../src/config.js";
import { createMctxFeature } from "../src/feature.js";

const model = { api: "test", provider: "anthropic", id: "claude-haiku" } as Model<Api>;

function configuration(
	pipeline: MctxConfiguration["pipeline"] = {
		kind: "enabled",
		settings: {
			historianModel: "anthropic/claude-haiku",
			failClosedBlocking: true,
			executeThresholdPercentage: { defaultValue: 65, byModel: {} },
		},
	},
): MctxConfiguration {
	return {
		global: {},
		project: {},
		merged: {},
		sourceOf: () => undefined,
		pipeline,
		warnings: [],
	};
}

function runtime(options: { readonly found?: boolean; readonly authenticated?: boolean } = {}) {
	const controller = new AbortController();
	const cleanups: Array<() => void | Promise<void>> = [];
	const notifications: Array<{ readonly message: string; readonly level: string }> = [];
	const pi = { events: {} } as unknown as ExtensionAPI;
	const extension = {
		cwd: "/project",
		sessionManager: { getSessionId: () => "session-1" },
		modelRegistry: {
			find: () => (options.found === false ? undefined : model),
			hasConfiguredAuth: () => options.authenticated !== false,
		},
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
		},
	} as unknown as ExtensionContext;
	return {
		context: {
			pi,
			extension,
			signal: controller.signal,
			resources: {
				add: (_id: string, cleanup: () => void | Promise<void>) => cleanups.push(cleanup),
				cleanup: async () => [],
			},
		} as ExtensionLifecycleContext,
		controller,
		cleanups,
		notifications,
	};
}

test("leaves disabled and invalid configuration inactive", (): void => {
	const { context } = runtime();
	expect(resolveMctxActivation(context, configuration({ kind: "disabled" }))).toEqual({
		kind: "inactive",
		reason: "disabled",
	});
	expect(
		resolveMctxActivation(
			context,
			configuration({ kind: "invalid", reason: "historian.model must be exact provider/model" }),
		),
	).toEqual({
		kind: "inactive",
		reason: "invalid",
		diagnostic: "pi-mctx configuration is invalid: historian.model must be exact provider/model",
	});
});

test("requires an available authenticated historian", (): void => {
	expect(resolveMctxActivation(runtime({ found: false }).context, configuration())).toMatchObject({
		kind: "inactive",
		reason: "unavailable",
	});
	expect(
		resolveMctxActivation(runtime({ authenticated: false }).context, configuration()),
	).toMatchObject({
		kind: "inactive",
		reason: "unavailable",
	});
});

test("does not replace a conflicting completion coordinator", (): void => {
	const { context } = runtime();
	configureSubagentCoordinator(context, { maxActiveTurns: 1 });
	expect(resolveMctxActivation(context, configuration())).toMatchObject({
		kind: "inactive",
		reason: "collision",
	});
});

test("resolves historian and joins the shared completion coordinator", (): void => {
	const { context } = runtime();
	expect(resolveMctxActivation(context, configuration())).toEqual({
		kind: "active",
		runtime: {
			sessionId: "session-1",
			historian: model,
			settings: {
				historianModel: "anthropic/claude-haiku",
				failClosedBlocking: true,
				executeThresholdPercentage: { defaultValue: 65, byModel: {} },
			},
		},
	});
	expect(resolveMctxActivation(context, configuration()).kind).toBe("active");
});

test("feature owns the active runtime for the session lifecycle", async (): Promise<void> => {
	const fixture = runtime();
	let closed = 0;
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		resolveProjectIdentity: async () => `git:${"a".repeat(40)}`,
		openStore: () => ({
			path: "/store",
			getOrCreatePartition: () => ({
				projectIdentity: `git:${"a".repeat(40)}`,
				sessionId: "session-1",
				revision: 0,
			}),
			advancePartitionRevision: () => undefined,
			acquireHistorianLease: () => undefined,
			renewHistorianLease: () => undefined,
			releaseHistorianLease: () => undefined,
			close: () => void closed++,
		}),
	});
	await feature.start(fixture.context);
	expect(feature.active()?.sessionId).toBe("session-1");
	expect(feature.active()?.partition).toEqual({
		projectIdentity: `git:${"a".repeat(40)}`,
		sessionId: "session-1",
		revision: 0,
	});
	const cleanup = fixture.cleanups[0];
	if (!cleanup) throw new Error("Expected active MCTX runtime cleanup");
	await cleanup();
	expect(feature.active()).toBeUndefined();
	expect(closed).toBe(1);

	const inactiveFixture = runtime();
	const inactiveFeature = createMctxFeature({
		loadConfiguration: async () => configuration({ kind: "invalid", reason: "broken historian" }),
	});
	await inactiveFeature.start(inactiveFixture.context);
	expect(inactiveFeature.active()).toBeUndefined();
	expect(inactiveFixture.cleanups).toEqual([]);
	expect(inactiveFixture.notifications).toEqual([
		{ message: "pi-mctx configuration is invalid: broken historian", level: "warning" },
	]);

	const failedFixture = runtime();
	const failedFeature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		openStore: () => {
			throw new Error("database is locked");
		},
	});
	await expect(failedFeature.start(failedFixture.context)).rejects.toThrow("database is locked");
	expect(failedFeature.active()).toBeUndefined();
	expect(failedFixture.notifications).toEqual([
		{ message: "pi-mctx context store unavailable: database is locked", level: "error" },
	]);

	const partitionFixture = runtime();
	let partitionStoreClosed = 0;
	const partitionFeature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		resolveProjectIdentity: async () => {
			throw new Error("project permission denied");
		},
		openStore: () => ({
			path: "/store",
			getOrCreatePartition: () => {
				throw new Error("must not create partition");
			},
			advancePartitionRevision: () => undefined,
			acquireHistorianLease: () => undefined,
			renewHistorianLease: () => undefined,
			releaseHistorianLease: () => undefined,
			close: () => void partitionStoreClosed++,
		}),
	});
	await expect(partitionFeature.start(partitionFixture.context)).rejects.toThrow(
		"project permission denied",
	);
	expect(partitionFeature.active()).toBeUndefined();
	expect(partitionStoreClosed).toBe(1);
	expect(partitionFixture.notifications).toEqual([
		{ message: "pi-mctx context partition unavailable: project permission denied", level: "error" },
	]);
});
