import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Pi package entry. Context-pipeline resources are registered only when the
 * enabled feature exists; the skeleton intentionally leaves Pi unchanged.
 */
export default function piMctxExtension(_pi: ExtensionAPI): void {}
