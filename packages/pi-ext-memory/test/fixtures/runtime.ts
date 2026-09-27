import { Runtime } from "../../src/runtime.js";

/**
 * A runtime whose configuration has already loaded, which is the state every
 * worker test starts from: `Runtime` reads its config lazily on first use, so a
 * test that constructs one directly has to mark it loaded itself.
 */
export function newConfiguredRuntime(): Runtime {
	const runtime = new Runtime();
	runtime.configLoaded = true;
	return runtime;
}
