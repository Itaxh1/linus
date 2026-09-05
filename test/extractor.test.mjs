import assert from "node:assert/strict";
import test from "node:test";
import { extractEvents, extractSkeleton } from "../dist/extractor.js";

function record(text) {
  const body = Buffer.from(text);
  return {
    prefix: body.subarray(0, 400),
    suffix: body.subarray(-2048),
    content: body,
    byteLength: body.length,
    hash: "a".repeat(64),
    startOffset: 0,
    endOffset: body.length + 1,
    complete: true,
    truncated: false,
  };
}

test("generic name fields do not become tool calls", () => {
  const event = extractSkeleton(
    "codex",
    "f".repeat(64),
    record('{"timestamp":"2026-09-04T12:00:00Z","type":"assistant","role":"assistant","name":"model-name"}'),
  );
  assert.equal(event.type, "agent");
  assert.equal(event.tool_name, null);
});

test("explicit tool calls retain unknown status when no result marker is visible", () => {
  const event = extractSkeleton(
    "claude-code",
    "f".repeat(64),
    record('{"timestamp":"2026-09-04T12:00:00Z","type":"tool_use","name":"Bash"}'),
  );
  assert.equal(event.type, "tool");
  assert.equal(event.tool_name, "Bash");
  assert.equal(event.tool_status, "unknown");
});

test("Claude messages emit separate agent, tool, and usage records", () => {
  const events = extractEvents("claude-code", "f".repeat(64), record(JSON.stringify({
    timestamp: "2026-09-04T12:00:00Z",
    type: "assistant",
    sessionId: "session-1",
    apiBlockIndex: 0,
    cwd: "/work/rexy",
    message: {
      role: "assistant",
      model: "claude-test",
      content: [
        { type: "text", text: "Implemented the endpoint." },
        { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "npm test" } },
      ],
      usage: {
        input_tokens: 2,
        output_tokens: 50,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 20,
        output_tokens_details: { thinking_tokens: 10 },
      },
    },
  })));
  assert.deepEqual(events.map(item => item.event.type), ["agent", "tool", "usage"]);
  assert.equal(events[1].event.source_call_id, "tool-1");
  assert.equal(events[2].event.token_thinking, 10);
});

test("Codex output revises the matching invocation and retains exit status", () => {
  const call = extractEvents("codex", "f".repeat(64), record(JSON.stringify({
    timestamp: "2026-09-04T12:00:00Z",
    type: "response_item",
    payload: { type: "function_call", name: "shell", call_id: "call-1", arguments: "{}" },
  })))[0].event;
  const result = extractEvents("codex", "f".repeat(64), record(JSON.stringify({
    timestamp: "2026-09-04T12:00:01Z",
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: "call-1",
      output: JSON.stringify({ output: "failed", metadata: { exit_code: 2 } }),
    },
  })))[0].event;
  assert.equal(call.type, "tool");
  assert.equal(result.type, "tool_result");
  assert.equal(result.source_call_id, call.source_call_id);
  assert.equal(result.tool_status, "failed");
  assert.equal(result.exit_code, 2);
});

test("current Codex response_item messages become user and agent strokes", () => {
  const user = record(JSON.stringify({
    timestamp: "2026-09-04T12:00:00Z",
    type: "response_item",
    payload: {
      type: "message", role: "user",
      content: [{ type: "input_text", text: "Show the live session." }],
    },
  }));
  const agent = record(JSON.stringify({
    timestamp: "2026-09-04T12:00:01Z",
    type: "response_item",
    payload: {
      type: "message", role: "assistant",
      content: [{ type: "output_text", text: "The live session is visible." }],
    },
  }));

  assert.deepEqual(extractEvents("codex", "f".repeat(64), user).map(x => [x.event.type, x.event.content_preview]), [
    ["user", "Show the live session."],
  ]);
  assert.deepEqual(extractEvents("codex", "f".repeat(64), agent).map(x => [x.event.type, x.event.content_preview]), [
    ["agent", "The live session is visible."],
  ]);
});
