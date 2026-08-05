import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig } from "../types.js";
import {
  buildConfigEditingTabs,
  readConfigLayers,
  type ConfigEditingTab,
} from "../config/config-editing-model.js";
import type { MemoryOperationsDeps } from "../operations/memory-operation-service.js";
import { listRetainReceipts } from "../lifecycle/retain-receipts.js";
import { collectStatusHealthFacts } from "../utils/status-health.js";
import { buildRetainReceiptStatusFacts } from "./setup-tui-render.js";
import { RECEIPT_FACT_LIMIT, type SetupUiState } from "./setup-tui-types.js";

export async function buildSetupTabs(args: {
  ctx: ExtensionCommandContext;
  config: ResolvedConfig;
  projectBankId: string;
  deps: MemoryOperationsDeps;
  state: SetupUiState;
}): Promise<ConfigEditingTab[]> {
  const statusFacts = await collectStatusHealthFacts({
    client: args.deps.getClient(),
    config: args.config,
    projectBankId: args.projectBankId,
  });
  const receiptFacts = buildRetainReceiptStatusFacts(
    await listRetainReceipts(args.ctx.cwd, RECEIPT_FACT_LIMIT),
  );
  return buildConfigEditingTabs(
    args.config,
    args.projectBankId,
    readConfigLayers(args.ctx.cwd),
    [...buildInitHealthFacts(args.deps.getInitHealth?.()), ...statusFacts, ...receiptFacts],
    { showAdvanced: Boolean(args.state.showAdvanced) },
  );
}

export function buildInitHealthFacts(
  initHealth: ReturnType<NonNullable<MemoryOperationsDeps["getInitHealth"]>>,
): Array<[string, string]> {
  if (!initHealth) return [];
  if (initHealth.failures.length === 0) return [["Startup", `ok (${initHealth.checkedAt})`]];
  return initHealth.failures.map((failure) => [
    `Startup ${failure.subsystem}`,
    `failed: ${failure.error}`,
  ]);
}
