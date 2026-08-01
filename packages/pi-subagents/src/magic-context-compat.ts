const MAGIC_CONTEXT_PI_SUBAGENT_ENV = "MAGIC_CONTEXT_PI_SUBAGENT";
const STATE_KEY = "__hheeiPiSubagentsMagicContextState";

type State = {
	depth: number;
	previousEnv: string | undefined;
};

function isState(value: unknown): value is State {
	if (typeof value !== "object" || value === null) return false;
	const depth = Reflect.get(value, "depth");
	const previousEnv = Reflect.get(value, "previousEnv");
	return (
		typeof depth === "number" &&
		Number.isInteger(depth) &&
		depth >= 0 &&
		(typeof previousEnv === "string" || previousEnv === undefined)
	);
}

function getState(): State {
	const existing = Reflect.get(globalThis, STATE_KEY);
	if (isState(existing)) return existing;

	const state: State = { depth: 0, previousEnv: undefined };
	Reflect.set(globalThis, STATE_KEY, state);
	return state;
}

export async function withMagicContextSubagentLoad<T>(operation: () => Promise<T>): Promise<T> {
	const state = getState();
	if (state.depth === 0) state.previousEnv = process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];
	state.depth += 1;
	process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV] = "1";

	try {
		return await operation();
	} finally {
		state.depth -= 1;
		if (state.depth === 0) {
			if (state.previousEnv === undefined) delete process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV];
			else process.env[MAGIC_CONTEXT_PI_SUBAGENT_ENV] = state.previousEnv;
			state.previousEnv = undefined;
		}
	}
}
