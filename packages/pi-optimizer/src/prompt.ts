/**
 * Deterministic optimizer system-prompt composition.
 *
 * Caveman and Ponytail fragments are derived from hheei/oh-my-pi
 * packages/hepi/omp-optimizer at 5d30ef8e55d54788afa3f316bf67348f6920987d (MIT).
 */

import { buildCavemanPrompt } from "./caveman.js";
import { buildPonytailPrompt } from "./ponytail.js";
import type { OptimizerSettings } from "./settings.js";

/** Prompt section Pi keeps and diffs per turn; renamed only with the extension. */
export const OPTIMIZER_PROMPT_SECTION = "pi-optimizer";

const RTK_PROMPT = `# RTK — token-optimized command wrapper

For an eligible local, foreground bash command, RTK may safely optimize supported commands (for example, \`rtk git status\`). Do not prefix every command unconditionally: leave unsupported commands and commands outside that local foreground bash scope raw. The runtime determines eligibility and applies the configured executable path safely.

When you intentionally use RTK for a supported command chain, prefix every supported segment, not just the first:
\`rtk git add . && rtk git commit -m "msg" && rtk git push\`

RTK also has filtering subcommands the auto-rewriter does not add by default — reach for these yourself when useful: \`rtk err <cmd>\` (errors only), \`rtk summary <cmd>\`, \`rtk log <file>\` (dedup), \`rtk json <file>\` (structure), \`rtk test <cmd>\` (failures only), \`rtk gain\` (savings stats).`;

/** Builds only this extension's enabled prompt fragments; the host owns the base prompt. */
export function buildOptimizerPrompt(settings: OptimizerSettings): string {
	const fragments = [
		buildCavemanPrompt(settings.caveman.level),
		buildPonytailPrompt(settings.ponytail.level),
		settings.rtk.enabled ? RTK_PROMPT : "",
	].filter((fragment) => fragment.length > 0);
	return fragments.join("\n\n");
}
