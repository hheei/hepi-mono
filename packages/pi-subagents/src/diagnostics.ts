/**
 * Runner-side shared diagnostics.
 *
 * The runner process owns the Pi child stdio: Pi stdout carries RPC JSON lines
 * only, so every runner diagnostic goes to the runner process stderr.
 */

export function writeDiagnostic(scope: string, message: string): void {
	process.stderr.write(`pi-subagents ${scope}: ${message}\n`);
}

export function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

export function errorMessage(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

export function abortError(): Error {
	const error = new Error("Operation aborted");
	error.name = "AbortError";
	return error;
}
