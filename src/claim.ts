import { hostname, platform } from "node:os";
import { saveCredentials, validateApiBase, type Credentials } from "./config.js";

export async function exchangeClaim(
  apiValue: string,
  claimToken: string,
  dataDirectory?: string,
): Promise<Credentials> {
  const apiBase = validateApiBase(apiValue);
  const response = await fetch(`${apiBase}/v1/devices/exchange-claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
    body: JSON.stringify({
      claim_token: claimToken,
      device_name: hostname(),
      platform: platform(),
    }),
  });
  if (!response.ok) {
    throw new Error(`claim exchange failed with HTTP ${response.status}. Generate a fresh install command in Rexy; claims expire after ten minutes and can only be used once.`);
  }
  const result = await response.json() as { device_id: string; device_token: string };
  return saveCredentials(
    { apiBase, deviceId: result.device_id, deviceToken: result.device_token },
    dataDirectory,
  );
}
