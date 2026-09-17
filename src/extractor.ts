import { basename } from "node:path";
import { redact } from "./redact.js";
import type { RecordSlice } from "./scanner.js";

export type Source = "claude-code" | "codex";
export type EventKind = "user" | "agent" | "tool" | "tool_result" | "usage";
export type ToolStatus = "unknown" | "running" | "succeeded" | "failed" | "interrupted" | "canceled";

export interface SkeletonEvent {
  session_id: string;
  type: EventKind;
  role: "user" | "assistant" | null;
  created_at: string;
  local_day: string;
  tool_name: string | null;
  tool_status: ToolStatus;
  content_preview: string | null;
  session_title: string | null;
  project_name: string | null;
  model: string | null;
  source_call_id: string | null;
  tool_input_preview: string | null;
  tool_output_preview: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  token_input: number | null;
  token_output: number | null;
  token_cache_read: number | null;
  token_cache_write: number | null;
  token_thinking: number | null;
  usage_cumulative: boolean;
  truncated: boolean;
  source_bytes: number;
}

export interface ExtractedEvent { itemIndex: number; event: SkeletonEvent }
type Json = Record<string, any>;

function firstMatch(text: string, expressions: RegExp[]): string | null {
  for (const expression of expressions) {
    const match = expression.exec(text);
    if (match?.[1]) return match[1];
  }
  return null;
}

function localDay(timestamp: string): string | null {
  const value = new Date(timestamp);
  if (Number.isNaN(value.getTime())) return null;
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function preview(value: unknown, limit = 4_000): string | null {
  if (value == null) return null;
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  if (!raw.trim()) return null;
  const clean = redact(raw.replace(/\0/g, "")).trim();
  const encoded = Buffer.from(clean);
  return encoded.length <= limit ? clean : `${encoded.subarray(0, limit - 16).toString("utf8")}\n[truncated]`;
}

function project(cwd: unknown): string | null {
  return typeof cwd === "string" && cwd ? basename(cwd) : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function eventBase(
  parsed: Json,
  source: Source,
  sourceFileId: string,
  record: RecordSlice,
  timestampFallback?: string,
): SkeletonEvent | null {
  const timestamp = typeof parsed.timestamp === "string" ? parsed.timestamp : timestampFallback;
  const day = timestamp ? localDay(timestamp) : null;
  if (!timestamp || !day) return null;
  const cwd = source === "codex" ? parsed.payload?.cwd : parsed.cwd;
  return {
    session_id: source === "codex" ? sourceFileId
      : typeof parsed.sessionId === "string" ? parsed.sessionId : sourceFileId,
    type: "usage",
    role: null,
    created_at: timestamp,
    local_day: day,
    tool_name: null,
    tool_status: "unknown",
    content_preview: null,
    session_title: null,
    project_name: project(cwd),
    model: typeof parsed.message?.model === "string" ? parsed.message.model
      : typeof parsed.payload?.model === "string" ? parsed.payload.model : null,
    source_call_id: null,
    tool_input_preview: null,
    tool_output_preview: null,
    exit_code: null,
    duration_ms: null,
    token_input: null,
    token_output: null,
    token_cache_read: null,
    token_cache_write: null,
    token_thinking: null,
    usage_cumulative: false,
    truncated: record.truncated,
    source_bytes: record.byteLength,
  };
}

function parseJson(record: RecordSlice): Json | null {
  if (!record.content) return null;
  try {
    const value = JSON.parse(record.content.toString("utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function claudeEvents(
  parsed: Json,
  sourceFileId: string,
  record: RecordSlice,
  timestampFallback?: string,
): ExtractedEvent[] {
  const base = eventBase(parsed, "claude-code", sourceFileId, record, timestampFallback);
  if (!base) return [];
  if (parsed.type === "ai-title" && typeof parsed.aiTitle === "string") {
    return [{ itemIndex: 20_000, event: { ...base, session_title: preview(parsed.aiTitle, 500) } }];
  }
  if (parsed.type === "system" && parsed.subtype === "api_error") {
    return [{ itemIndex: 0, event: {
      ...base, type: "tool", tool_name: "API", tool_status: "failed",
      content_preview: preview(parsed.error, 2_000),
    } }];
  }
  if (parsed.type !== "user" && parsed.type !== "assistant") return [];

  const role = parsed.message?.role;
  const rawContent = parsed.message?.content;
  const blocks = typeof rawContent === "string" ? [{ type: "text", text: rawContent }]
    : Array.isArray(rawContent) ? rawContent : [];
  const result: ExtractedEvent[] = [];
  blocks.forEach((block: Json, index: number) => {
    if (block?.type === "text" && (role === "user" || role === "assistant")) {
      const content = preview(block.text);
      if (content) result.push({ itemIndex: index, event: {
        ...base, type: role === "user" ? "user" : "agent", role, content_preview: content,
      } });
    } else if (block?.type === "tool_use") {
      result.push({ itemIndex: index, event: {
        ...base, type: "tool", tool_name: String(block.name || "unknown"),
        tool_status: "unknown", source_call_id: block.id ? String(block.id) : null,
        tool_input_preview: preview(block.input, 8_000),
      } });
    } else if (block?.type === "tool_result") {
      const interrupted = parsed.toolUseResult?.interrupted === true;
      result.push({ itemIndex: index, event: {
        ...base, type: "tool_result", source_call_id: String(block.tool_use_id || ""),
        tool_status: interrupted ? "interrupted" : block.is_error === true ? "failed" : "succeeded",
        tool_output_preview: preview(block.content, 8_000),
      } });
    }
  });
  const usage = parsed.message?.usage;
  if (usage && parsed.apiBlockIndex === 0) {
    result.push({ itemIndex: 10_000, event: {
      ...base, type: "usage", token_input: integer(usage.input_tokens),
      token_output: integer(usage.output_tokens), token_cache_read: integer(usage.cache_read_input_tokens),
      token_cache_write: integer(usage.cache_creation_input_tokens),
      token_thinking: integer(usage.output_tokens_details?.thinking_tokens),
    } });
  }
  return result;
}

function codexResult(output: unknown): { text: string | null; exitCode: number | null; status: ToolStatus } {
  const text = preview(output, 8_000);
  let exitCode: number | null = null;
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output);
      exitCode = integer(parsed?.metadata?.exit_code ?? parsed?.exit_code);
    } catch {
      // Most non-shell tool results are plain text.
    }
  }
  return { text, exitCode, status: exitCode != null && exitCode !== 0 ? "failed" : "succeeded" };
}

function codexEvents(parsed: Json, sourceFileId: string, record: RecordSlice): ExtractedEvent[] {
  const base = eventBase(parsed, "codex", sourceFileId, record);
  if (!base) return [];
  const payload = parsed.payload ?? {};
  if (parsed.type === "session_meta" || parsed.type === "turn_context") {
    return [{ itemIndex: 20_000, event: {
      ...base, project_name: project(payload.cwd),
      model: typeof payload.model === "string" ? payload.model : null,
    } }];
  }
  if (parsed.type === "event_msg" && payload.type === "user_message") {
    const content = preview(payload.message);
    return content ? [{ itemIndex: 0, event: { ...base, type: "user", role: "user", content_preview: content } }] : [];
  }
  if (parsed.type === "event_msg" && payload.type === "agent_message") {
    const content = preview(payload.message);
    return content ? [{ itemIndex: 0, event: { ...base, type: "agent", role: "assistant", content_preview: content } }] : [];
  }
  if (parsed.type === "response_item" && payload.type === "message"
      && (payload.role === "user" || payload.role === "assistant")) {
    const blockTypes = payload.role === "user" ? new Set(["input_text", "text"])
      : new Set(["output_text", "text"]);
    const text = Array.isArray(payload.content)
      ? payload.content
        .filter((block: Json) => blockTypes.has(block?.type) && typeof block.text === "string")
        .map((block: Json) => block.text)
        .join("\n")
      : null;
    const content = preview(text);
    return content ? [{ itemIndex: 0, event: {
      ...base,
      type: payload.role === "user" ? "user" : "agent",
      role: payload.role,
      content_preview: content,
    } }] : [];
  }
  if (parsed.type === "event_msg" && payload.type === "token_count" && payload.info?.total_token_usage) {
    const usage = payload.info.total_token_usage;
    return [{ itemIndex: 10_000, event: {
      ...base, type: "usage", usage_cumulative: true,
      token_input: integer(usage.input_tokens), token_output: integer(usage.output_tokens),
      token_cache_read: integer(usage.cached_input_tokens), token_cache_write: 0,
      token_thinking: integer(usage.reasoning_output_tokens),
    } }];
  }
  if (parsed.type !== "response_item") return [];
  if (["function_call", "custom_tool_call", "web_search_call"].includes(payload.type)) {
    return [{ itemIndex: 0, event: {
      ...base, type: "tool", tool_name: String(payload.name || (payload.type === "web_search_call" ? "WebSearch" : "unknown")),
      tool_status: payload.status === "in_progress" ? "running" : "unknown",
      source_call_id: payload.call_id ? String(payload.call_id) : null,
      tool_input_preview: preview(payload.arguments ?? payload.input ?? payload.action, 8_000),
    } }];
  }
  if (["function_call_output", "custom_tool_call_output"].includes(payload.type)) {
    const output = codexResult(payload.output);
    return [{ itemIndex: 0, event: {
      ...base, type: "tool_result", source_call_id: String(payload.call_id || ""),
      tool_status: output.status, tool_output_preview: output.text, exit_code: output.exitCode,
    } }];
  }
  return [];
}

export function extractEvents(
  source: Source,
  sourceFileId: string,
  record: RecordSlice,
  timestampFallback?: string,
): ExtractedEvent[] {
  const parsed = parseJson(record);
  if (parsed) {
    const structured = source === "claude-code"
      ? claudeEvents(parsed, sourceFileId, record, timestampFallback)
      : codexEvents(parsed, sourceFileId, record);
    if (structured.length > 0) return structured;
  }

  const prefix = record.prefix.toString("utf8");
  const retained = `${prefix}\n${record.suffix.toString("utf8")}`;
  const timestamp = firstMatch(prefix, [/"timestamp"\s*:\s*"([^"\\]+)"/, /"created_at"\s*:\s*"([^"\\]+)"/]);
  const day = timestamp ? localDay(timestamp) : null;
  if (!timestamp || !day) return [];
  const type = firstMatch(prefix, [/"type"\s*:\s*"([^"\\]+)"/]);
  const role = firstMatch(prefix, [/"role"\s*:\s*"([^"\\]+)"/]);
  const explicitTool = /"type"\s*:\s*"(?:tool_use|function_call)"|"tool_name"\s*:/i.test(retained);
  const toolName = explicitTool ? firstMatch(retained, [/"tool_name"\s*:\s*"([^"\\]+)"/, /"name"\s*:\s*"([^"\\]+)"/]) : null;
  let kind: "user" | "agent" | "tool" | null = null;
  if (explicitTool || type === "tool_use" || type === "function_call") kind = "tool";
  else if (role === "user" || type === "user" || type === "user_message") kind = "user";
  else if (role === "assistant" || type === "assistant" || type === "agent_message") kind = "agent";
  if (!kind) return [];
  let status: ToolStatus = "unknown";
  if (/"is_error"\s*:\s*true|"status"\s*:\s*"(?:failed|error)"/i.test(retained)) status = "failed";
  else if (/"interrupted"\s*:\s*true/i.test(retained)) status = "interrupted";
  else if (/"status"\s*:\s*"cancel(?:ed|led)"/i.test(retained)) status = "canceled";
  else if (/"status"\s*:\s*"(?:success|succeeded|completed)"/i.test(retained)) status = "succeeded";
  else if (/"status"\s*:\s*"(?:running|in_progress)"/i.test(retained)) status = "running";
  return [{ itemIndex: 0, event: {
    ...eventBase({ timestamp }, source, sourceFileId, record)!, type: kind,
    role: role === "user" ? "user" : role === "assistant" ? "assistant" : null,
    tool_name: kind === "tool" ? toolName : null,
    tool_status: kind === "tool" ? status : "unknown",
  } }];
}

export function extractSkeleton(source: Source, sourceFileId: string, record: RecordSlice): SkeletonEvent | null {
  return extractEvents(source, sourceFileId, record)[0]?.event ?? null;
}
