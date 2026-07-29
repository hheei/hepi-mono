import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type HepiExtension = (pi: ExtensionAPI) => void;
export declare const hepiExtensions: readonly HepiExtension[];
export default function extension(pi: ExtensionAPI): void;
