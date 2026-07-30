/** Stores lazy runtime registries across separately evaluated core bundles. */
export function getGlobalState<T>(name: string, create: () => T): T {
	const key = Symbol.for(`@hheei/pi-ext-core/${name}`);
	const current: unknown = Reflect.get(globalThis, key);
	if (current !== undefined) return current as T;
	const created = create();
	Reflect.set(globalThis, key, created);
	return created;
}
