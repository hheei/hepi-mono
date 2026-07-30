import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHerdrAgentState } from "./herdr-agent-state.js";
import { registerOrcaAgentStatus } from "./orca-agent-status.js";
import { registerOrcaPrefill } from "./orca-prefill.js";
import { registerOrcaTitlebarSpinner } from "./orca-titlebar-spinner.js";

/** Optional adapters for host applications that launch Pi. */
export default function piHepiIntegrationsExtension(pi: ExtensionAPI): void {
	registerHerdrAgentState(pi);
	registerOrcaAgentStatus(pi);
	registerOrcaPrefill(pi);
	registerOrcaTitlebarSpinner(pi);
}
