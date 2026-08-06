/** Resolve an explicitly named, authenticated provider/model pair. */

export interface ModelEntry {
	id: string;
	name: string;
	provider: string;
}

export interface ModelRegistry<T extends ModelEntry = ModelEntry> {
	find(provider: string, modelId: string): T | undefined;
	getAll(): readonly T[];
	getAvailable?(): readonly T[];
}

/** Resolve a model string to an exact authenticated model instance. */
export function resolveModel<T extends ModelEntry>(
	input: string,
	registry: ModelRegistry<T>,
): T | string {
	if (!input.includes("/") || input.split("/").length !== 2) {
		return `Model must use provider/modelId: "${input}"`;
	}
	const [provider, modelId] = input.split("/");
	if (provider === undefined || modelId === undefined)
		return `Model must use provider/modelId: "${input}"`;
	const all = registry.getAvailable?.() ?? registry.getAll();
	const foundEntry = all.find((model) => model.provider === provider && model.id === modelId);
	const found = registry.find(provider, modelId);
	if (foundEntry !== undefined && found !== undefined) return found;
	const modelList = all
		.map((m) => `  ${m.provider}/${m.id}`)
		.sort()
		.join("\n");
	return `Model not found: "${input}".\n\nAvailable models:\n${modelList}`;
}
