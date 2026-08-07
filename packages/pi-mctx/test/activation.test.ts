import { expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	configureSubagentCoordinator,
	DEFAULT_SUBAGENT_COORDINATOR_BUDGET,
	type ExtensionLifecycleContext,
} from "@hheei/pi-ext-core";
import { resolveMctxActivation } from "../src/activation.js";
import type { MctxConfiguration } from "../src/config.js";
import { createMctxFeature } from "../src/feature.js";

const model = { api: "test", provider: "anthropic", id: "claude-haiku" } as Model<Api>;

function configuration(
	pipeline: MctxConfiguration["pipeline"] = {
		kind: "enabled",
		settings: {
			historian: { kind: "enabled", model: "anthropic/claude-haiku" },
			knowledgePersistence: "persistent",
			failClosedBlocking: true,
			smartDrops: false,
			executeThresholdPercentage: { defaultValue: 65, byModel: {} },
			protectedTags: 20,
			clearReasoningAge: 3,
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
			artifacts: {} as ExtensionLifecycleContext["artifacts"],
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

test("keeps the runtime active when historian is unavailable", (): void => {
	expect(resolveMctxActivation(runtime({ found: false }).context, configuration())).toMatchObject({
		kind: "active",
		runtime: { historian: { kind: "unavailable" } },
	});
	expect(
		resolveMctxActivation(runtime({ authenticated: false }).context, configuration()),
	).toMatchObject({
		kind: "active",
		runtime: { historian: { kind: "unavailable" } },
	});
});

test("starts the runtime but not historian cleanup when admission is unavailable", async (): Promise<void> => {
	const fixture = runtime({ found: false });
	const feature = createMctxFeature({
		loadConfiguration: async () => configuration(),
		resolveProjectIdentity: async () => `git:${"a".repeat(40)}`,
		openStore: () =>
			({
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
				listCompartments: () => [],
				publishCompartment: () => undefined,
				replaceCompartmentsFrom: () => undefined,
				close: () => undefined,
			}) as unknown as import("../src/store.js").MctxStore,
	});
	await feature.start(fixture.context);
	expect(feature.active()?.historian).toMatchObject({ kind: "unavailable" });
	expect(fixture.cleanups).toHaveLength(2);
	expect(fixture.notifications).toEqual([
		{
			message: "pi-mctx historian model is unavailable: anthropic/claude-haiku",
			level: "warning",
		},
	]);
});

test("keeps an existing completion coordinator budget", (): void => {
	const { context } = runtime();
	configureSubagentCoordinator(context, {
		...DEFAULT_SUBAGENT_COORDINATOR_BUDGET,
		maxActiveTurns: 1,
	});
	expect(resolveMctxActivation(context, configuration())).toMatchObject({
		kind: "active",
		runtime: { sessionId: "session-1" },
	});
});

test("resolves historian and joins the shared completion coordinator", (): void => {
	const { context } = runtime();
	expect(resolveMctxActivation(context, configuration())).toEqual({
		kind: "active",
		runtime: {
			cwd: "/project",
			sessionId: "session-1",
			historian: { kind: "active", model },
			settings: {
				historian: { kind: "enabled", model: "anthropic/claude-haiku" },
				knowledgePersistence: "persistent",
				failClosedBlocking: true,
				smartDrops: false,
				executeThresholdPercentage: { defaultValue: 65, byModel: {} },
				protectedTags: 20,
				clearReasoningAge: 3,
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
		openStore: () =>
			({
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
				listCompartments: () => [],
				publishCompartment: () => undefined,
				close: () => void closed++,
			}) as unknown as import("../src/store.js").MctxStore,
	});
	await feature.start(fixture.context);
	expect(feature.active()?.sessionId).toBe("session-1");
	expect(feature.active()?.partition).toEqual({
		projectIdentity: `git:${"a".repeat(40)}`,
		sessionId: "session-1",
		revision: 0,
	});
	const cleanup = fixture.cleanups[1];
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
		openStore: () =>
			({
				path: "/store",
				getOrCreatePartition: () => {
					throw new Error("must not create partition");
				},
				advancePartitionRevision: () => undefined,
				acquireHistorianLease: () => undefined,
				renewHistorianLease: () => undefined,
				releaseHistorianLease: () => undefined,
				listCompartments: () => [],
				publishCompartment: () => undefined,
				close: () => void partitionStoreClosed++,
			}) as unknown as import("../src/store.js").MctxStore,
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
