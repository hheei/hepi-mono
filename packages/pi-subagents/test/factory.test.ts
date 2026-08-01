import { expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createChildSessionFactory } from "../src/factory.js";
import type { ResolvedProfile } from "../src/profiles.js";

const model = { provider: "anthropic", id: "claude-haiku-4-5" } as Model<Api>;
const profile: ResolvedProfile = {
	name: "test",
	systemPrompt: "Only inspect.",
	tools: ["read", "grep"],
	thinking: "high",
	model,
	modelSelection: "explicit",
};

function registry(dynamic = false): Pick<ModelRegistry, "getRegisteredProviderIds"> {
	return { getRegisteredProviderIds: () => (dynamic ? [model.provider] : []) };
}

test("maps resolved policy to a public in-memory child session", async () => {
	let captured: Record<string, unknown> | undefined;
	const session = {
		abort: async () => undefined,
	} as AgentSession;
	const createSession = async (options: Record<string, unknown>) => {
		captured = options;
		return { session };
	};
	const controller = new AbortController();
	const factory = createChildSessionFactory(profile, {
		cwd: process.cwd(),
		modelRegistry: registry(),
		createSession:
			createSession as unknown as typeof import("@earendil-works/pi-coding-agent").createAgentSession,
		getChildAgentDir: () => "/agent-dir",
	});
	expect(await factory.create(controller.signal)).toBe(session);
	expect(captured).toMatchObject({
		cwd: process.cwd(),
		agentDir: "/agent-dir",
		model,
		thinkingLevel: "high",
		tools: ["read", "grep"],
	});
	expect(captured?.sessionManager).toBeDefined();
});

test("rejects a model sourced from a parent dynamic provider", async () => {
	const factory = createChildSessionFactory(profile, {
		cwd: process.cwd(),
		modelRegistry: registry(true),
	});
	await expect(factory.create(new AbortController().signal)).rejects.toThrow(
		"dynamically registered provider",
	);
});

test("rejects a default-profile fallback from a parent dynamic provider", async () => {
	const defaultProfile: ResolvedProfile = {
		name: "general-purpose",
		systemPrompt: "",
		tools: ["read"],
		modelSelection: "default",
	};
	const factory = createChildSessionFactory(defaultProfile, {
		cwd: process.cwd(),
		modelRegistry: registry(true),
		parentModel: model,
	});
	await expect(factory.create(new AbortController().signal)).rejects.toThrow(
		"dynamically registered provider",
	);
});
