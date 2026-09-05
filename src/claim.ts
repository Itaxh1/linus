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
    body: JSON.stringify({
      claim_token: claimToken,
      device_name: hostname(),
      platform: platform(),
    }),
  });
  if (!response.ok) {
    throw new Error(`claim exchange failed with HTTP ${response.status}`);
  }
  const result = await response.json() as { device_id: string; device_token: string };
  return saveCredentials(
    { apiBase, deviceId: result.device_id, deviceToken: result.device_token },
    dataDirectory,
  );
}
