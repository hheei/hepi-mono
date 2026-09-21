import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ResolvedConfig } from "../types.js";

function stringValue(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return fallback;
}

function toolName(message: Record<string, unknown>, part?: Record<string, unknown>): string {
  return stringValue(part?.name ?? message.toolName ?? message.name, "unknown");
}

function toolAllowed(name: string, filter: { include?: string[]; exclude?: string[] }): boolean {
  if (filter.include && !filter.include.includes(name)) return false;
  return !filter.exclude?.includes(name);
}

/** Keys tried, in order, for a compact tool-action target (coding-agents write-back discipline). */
const TOOL_TARGET_KEYS = [
  "file_path",
  "path",
  "notebook_path",
  "command",
  "pattern",
  "query",
  "url",
  "name",
  "id",
] as const;

const ACTION_TARGET_CAP = 100;

/**
 * Compact tool input to a primary target string (file path, command, pattern, …).
 * Full args/outputs bury decisions in mechanical noise; retain only WHAT was touched.
 */
export function toolActionTarget(input: unknown): string {
  let target = "";
  if (input && typeof input === "object") {
    const rec = input as Record<string, unknown>;
    for (const key of TOOL_TARGET_KEYS) {
      const value = rec[key];
      if (typeof value === "string" && value.trim()) {
        target = value.trim().split("\n")[0] ?? "";
        break;
      }
    }
  } else if (typeof input === "string") {
    target = input.trim().split("\n")[0] ?? "";
  }
  if (target.length > ACTION_TARGET_CAP) target = `${target.slice(0, ACTION_TARGET_CAP)}…`;
  return target;
}

function compactToolCallPart(name: string, args: unknown): Record<string, unknown> {
  const target = toolActionTarget(args);
  return {
    type: "toolCall",
    name,
    // Compact form: name + primary target only (no full argument object / no outputs).
    arguments: target ? { target } : {},
  };
}

function textFromContent(
  content: unknown,
  options: {
    includeText: boolean;
    includeThinking: boolean;
    includeToolCall: boolean;
    includeUnknownJson?: boolean;
    toolCallFilter?: { include?: string[]; exclude?: string[] };
    /** When true (default), tool calls become name+target only. */
    compactToolCalls?: boolean;
  },
): string {
  if (typeof content === "string") return options.includeText ? content : "";
  if (!Array.isArray(content)) return options.includeText ? JSON.stringify(content ?? "") : "";
  return content
    .map((part) => {
      if (part && typeof part === "object" && "type" in part) {
        const p = part as Record<string, unknown>;
        if (p.type === "text") return options.includeText ? stringValue(p.text) : "";
        if (p.type === "thinking")
          return options.includeThinking ? stringValue(p.thinking ?? p.text) : "";
        if (p.type === "toolCall") {
          if (!options.includeToolCall) return "";
          const name = stringValue(p.name, "unknown");
          if (options.toolCallFilter && !toolAllowed(name, options.toolCallFilter)) return "";
          if (options.compactToolCalls !== false) {
            const target = toolActionTarget(p.arguments);
            return target ? `[action ${name} ${target}]` : `[action ${name}]`;
          }
          return `[toolCall ${name}] ${JSON.stringify(p.arguments ?? {})}`;
        }
        if (p.type === "image") return options.includeText ? "[image omitted]" : "";
      }
      return options.includeText && options.includeUnknownJson !== false
        ? JSON.stringify(part)
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

function projectContent(
  content: unknown,
  options: {
    includeText: boolean;
    includeThinking: boolean;
    includeToolCall: boolean;
    toolCallFilter?: { include?: string[]; exclude?: string[] };
    compactToolCalls?: boolean;
  },
): unknown {
  if (typeof content === "string") return options.includeText ? content : "";
  if (!Array.isArray(content)) return options.includeText ? (content ?? "") : "";
  const projected = content
    .map((part) => {
      if (part && typeof part === "object" && "type" in part) {
        const p = part as Record<string, unknown>;
        if (p.type === "text") return options.includeText ? part : undefined;
        if (p.type === "thinking") return options.includeThinking ? part : undefined;
        if (p.type === "toolCall") {
          if (!options.includeToolCall) return undefined;
          const name = stringValue(p.name, "unknown");
          if (options.toolCallFilter && !toolAllowed(name, options.toolCallFilter))
            return undefined;
          if (options.compactToolCalls !== false) {
            return compactToolCallPart(name, p.arguments);
          }
          return part;
        }
        if (p.type === "image") return options.includeText ? part : undefined;
      }
      return options.includeText ? part : undefined;
    })
    .filter((part): part is unknown => part !== undefined);
  return projected.length ? projected : "";
}

function stripFields(record: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out = { ...record };
  fields.forEach((field) => delete out[field]);
  return out;
}

function messageTimestamp(message: Record<string, unknown>): string {
  return new Date(
    typeof message.timestamp === "number" ? message.timestamp : Date.now(),
  ).toISOString();
}

export function projectMessage(
  message: AgentMessage,
  config?: ResolvedConfig,
): Record<string, unknown> {
  const m = message as unknown as Record<string, unknown>;
  const role = stringValue(m.role, "unknown");
  const retain = config?.retain;
  const isAssistant = role === "assistant";
  const includeAssistantText = retain?.content.assistant.includes("text") ?? true;
  const includeThinking = retain?.content.assistant.includes("thinking") ?? false;
  const includeToolCall = retain?.content.assistant.includes("toolCall") ?? true;
  const compactToolCalls = retain?.compactToolCalls !== false;
  const base: Record<string, unknown> = {
    role,
    timestamp: messageTimestamp(m),
    content: projectContent(m.content, {
      includeText: !isAssistant || includeAssistantText,
      includeThinking: isAssistant && includeThinking,
      includeToolCall: isAssistant && includeToolCall,
      compactToolCalls,
      ...(retain ? { toolCallFilter: retain.toolFilter.toolCall } : {}),
    }),
  };
  if (role === "toolResult") {
    base.toolName = m.toolName;
    base.isError = m.isError;
  }
  if (role === "assistant") {
    base.model = m.model;
    base.stopReason = m.stopReason;
  }
  return stripFields(base, retain?.strip.message ?? []);
}

export function projectMessageText(
  message: AgentMessage,
  config?: ResolvedConfig,
): Record<string, unknown> {
  const m = message as unknown as Record<string, unknown>;
  const role = stringValue(m.role, "unknown");
  const retain = config?.retain;
  const isAssistant = role === "assistant";
  const includeAssistantText = retain?.content.assistant.includes("text") ?? true;
  const includeThinking = retain?.content.assistant.includes("thinking") ?? false;
  const includeToolCall = retain?.content.assistant.includes("toolCall") ?? true;
  const compactToolCalls = retain?.compactToolCalls !== false;
  const base: Record<string, unknown> = {
    role,
    timestamp: messageTimestamp(m),
    content: textFromContent(m.content, {
      includeText: !isAssistant || includeAssistantText,
      includeThinking: isAssistant && includeThinking,
      includeToolCall: isAssistant && includeToolCall,
      includeUnknownJson: false,
      compactToolCalls,
      ...(retain ? { toolCallFilter: retain.toolFilter.toolCall } : {}),
    }),
  };
  if (role === "toolResult") {
    base.toolName = m.toolName;
    base.isError = m.isError;
  }
  if (role === "assistant") {
    base.model = m.model;
    base.stopReason = m.stopReason;
  }
  return stripFields(base, retain?.strip.message ?? []);
}

export function isInjectedHindsightMemory(message: unknown): boolean {
  const record = message as { content?: unknown; customType?: unknown; type?: unknown };
  if (
    record.customType === "hindsight-recall" ||
    record.type === "hindsight-recall" ||
    record.customType === "hindsight-mental-models" ||
    record.type === "hindsight-mental-models"
  ) {
    return true;
  }
  const text = textFromContent(record.content, {
    includeText: true,
    includeThinking: false,
    includeToolCall: true,
  }).trim();
  // Only prefix matches: substring contains would drop legitimate discussion of these tags.
  return (
    text.startsWith("<hindsight-memory>") ||
    text.startsWith("<hindsight_memories>") ||
    text.startsWith("<hindsight-mental-models>") ||
    text.startsWith("<mental_models>")
  );
}

function toolResultContent(
  message: Record<string, unknown>,
  mode: "error" | "summary" | "content",
): string {
  const text = textFromContent(message.content, {
    includeText: true,
    includeThinking: false,
    includeToolCall: false,
  });
  if (mode === "summary") return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  return text;
}

function projectToolResult(
  message: AgentMessage,
  config: ResolvedConfig,
): Record<string, unknown> | undefined {
  const m = message as unknown as Record<string, unknown>;
  const name = toolName(m);
  if (!toolAllowed(name, config.retain.toolFilter.toolResult)) return undefined;
  const modes = config.retain.content.toolResult;
  if (m.isError) {
    if (!modes.includes("error")) return undefined;
    return stripFields(
      {
        role: "toolResult",
        timestamp: messageTimestamp(m),
        toolName: name,
        isError: true,
        content: toolResultContent(m, "error"),
      },
      config.retain.strip.message,
    );
  }
  if (modes.includes("content")) return projectMessage(message, config);
  if (modes.includes("summary")) {
    return stripFields(
      {
        role: "toolResult",
        timestamp: messageTimestamp(m),
        toolName: name,
        isError: false,
        content: toolResultContent(m, "summary"),
      },
      config.retain.strip.message,
    );
  }
  return undefined;
}

function hasAssistantContentToRetain(message: AgentMessage, config: ResolvedConfig): boolean {
  return Boolean(projectMessage(message, config).content);
}

export function projectMessages(
  messages: AgentMessage[],
  config: ResolvedConfig,
): Record<string, unknown>[] {
  return messages
    .filter((message) => !isInjectedHindsightMemory(message))
    .map((message) => {
      const role = (message as unknown as { role?: string }).role;
      if (role === "user")
        return config.retain.content.user.includes("text")
          ? projectMessage(message, config)
          : undefined;
      if (role === "assistant") {
        if (!hasAssistantContentToRetain(message, config)) return undefined;
        return projectMessage(message, config);
      }
      if (role === "toolResult") return projectToolResult(message, config);
      return projectMessage(message, config);
    })
    .filter((message): message is Record<string, unknown> => Boolean(message))
    .map((message) => stripFields(message, config.retain.strip.topLevel));
}
