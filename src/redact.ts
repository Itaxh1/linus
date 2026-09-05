const RULES: ReadonlyArray<[string, RegExp]> = [
  ["aws_key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["github_token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g],
  ["provider_key", /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g],
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ["authorization", /\bAuthorization\s*:\s*(?:Bearer|Basic)\s+\S+/gi],
  ["env_secret", /^(?:[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)=.{8,}$/gm],
];

export function redact(value: string): string {
  let result = value;
  for (const [kind, expression] of RULES) {
    result = result.replace(expression, `«redacted:${kind}»`);
  }
  return result;
}
