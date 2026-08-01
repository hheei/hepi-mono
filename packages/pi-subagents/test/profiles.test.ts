import { expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { resolveProfile } from "../src/profiles.js";

const model = { provider: "anthropic", id: "claude-haiku-4-5" } as Model<Api>;

function registry(
	options: { readonly authenticated?: boolean; readonly dynamic?: boolean } = {},
): Pick<ModelRegistry, "find" | "hasConfiguredAuth" | "getRegisteredProviderIds"> {
	return {
		find: (provider, id) => (provider === model.provider && id === model.id ? model : undefined),
		hasConfiguredAuth: () => options.authenticated ?? true,
		getRegisteredProviderIds: () => (options.dynamic ? [model.provider] : []),
	};
}

test("resolves exact built-in profiles and only uses Explore's historical model when usable", async () => {
	const general = await resolveProfile({
		cwd: "/workspace",
		name: "general-purpose",
		modelRegistry: registry(),
	});
	expect(general).toEqual({
		name: "general-purpose",
		systemPrompt: "",
		tools: ["read", "bash", "edit", "write"],
		modelSelection: "default",
	});

	const explore = await resolveProfile({
		cwd: "/workspace",
		name: "Explore",
		modelRegistry: registry(),
	});
	expect(explore.model).toBe(model);
	expect(explore.modelSelection).toBe("explicit");

	const fallback = await resolveProfile({
		cwd: "/workspace",
		name: "Explore",
		modelRegistry: registry({ authenticated: false }),
	});
	expect(fallback.model).toBeUndefined();
	expect(fallback.modelSelection).toBe("historical-fallback");
});

test("a project filename overrides built-ins and validates its small frontmatter shape", async () => {
	const overridden = await resolveProfile({
		cwd: "/workspace",
		name: "Explore",
		modelRegistry: registry(),
		readProjectFile: async () =>
			"---\nthinking: high\ntools: [read, grep]\n---\nInspect only the API boundary.",
	});
	expect(overridden).toEqual({
		name: "Explore",
		systemPrompt: "Inspect only the API boundary.",
		tools: ["read", "grep"],
		thinking: "high",
		modelSelection: "default",
	});

	await expect(
		resolveProfile({
			cwd: "/workspace",
			name: "Explore",
			modelRegistry: registry(),
			readProjectFile: async () => "---\nextensions: true\n---\nNope",
		}),
	).rejects.toThrow("unknown frontmatter field");
	await expect(
		resolveProfile({
			cwd: "/workspace",
			name: "Explore",
			modelRegistry: registry(),
			readProjectFile: async () => "---\ntools: [agent]\n---\nNope",
		}),
	).rejects.toThrow("supported built-in tool names");
	await expect(
		resolveProfile({
			cwd: "/workspace",
			name: "Explore",
			modelRegistry: registry(),
			readProjectFile: async () => "---\nthinking: high\n",
		}),
	).rejects.toThrow("unterminated frontmatter");
});

test("rejects unknown and unsafe profile names", async () => {
	await expect(
		resolveProfile({ cwd: "/workspace", name: "explore", modelRegistry: registry() }),
	).rejects.toThrow("Unknown agent profile");
	await expect(
		resolveProfile({ cwd: "/workspace", name: "../Explore", modelRegistry: registry() }),
	).rejects.toThrow("invalid");
});
