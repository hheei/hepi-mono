/** Validates the provider/model reference stored at MCTX model-selection boundaries. */
export function validModelRef(value: string): boolean {
	const parts = value.trim().split("/");
	return parts.length === 2 && parts[0] !== "" && parts[1] !== "" && !value.includes("\\");
}
