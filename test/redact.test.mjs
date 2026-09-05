import assert from "node:assert/strict";
import test from "node:test";
import { redact } from "../dist/redact.js";

test("redactor removes representative secrets", () => {
  const source = [
    "AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF",
    "API_TOKEN=super-secret-value",
    "Authorization: Bearer eyJabc.eyJdef.signature",
  ].join("\n");
  const result = redact(source);
  assert.doesNotMatch(result, /AKIA1234567890ABCDEF/);
  assert.doesNotMatch(result, /super-secret-value/);
  assert.doesNotMatch(result, /eyJabc\.eyJdef\.signature/);
  assert.match(result, /«redacted:/);
});
