/**
 * The result shape `@ff-labs/fff-node` already returns, reused here so this layer
 * carries typed errors without a second Result implementation on top of it.
 */
export type AppResult<T, E> = { ok: true; value: T } | { ok: false; error: E };

export function okResult<T>(value: T): AppResult<T, never> {
	return { ok: true, value };
}

export function errResult<T, E>(error: E): AppResult<T, E> {
	return { ok: false, error };
}

export function okVoid<E = never>(): AppResult<void, E> {
	return { ok: true, value: undefined };
}

/** Drops a success value while keeping the error channel. */
export function toVoid<T, E>(result: AppResult<T, E>): AppResult<void, E> {
	return result.ok ? okVoid() : result;
}

/** Runs a boundary call and turns a thrown cause into one typed error. */
export function attempt<T, E>(run: () => T, onCause: (cause: unknown) => E): AppResult<T, E> {
	try {
		return okResult(run());
	} catch (cause) {
		return errResult(onCause(cause));
	}
}

/** Promise form of {@link attempt}. */
export async function attemptAsync<T, E>(
	run: () => Promise<T>,
	onCause: (cause: unknown) => E,
): Promise<AppResult<T, E>> {
	try {
		return okResult(await run());
	} catch (cause) {
		return errResult(onCause(cause));
	}
}
