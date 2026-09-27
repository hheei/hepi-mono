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
