import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Credentials {
  apiBase: string;
  deviceId: string;
  deviceToken: string;
  installationId: string;
}

export function defaultDataDirectory(): string {
  return process.env.LINUS_DATA_DIR || join(homedir(), ".linus");
}

export function validateApiBase(value: string): string {
  const url = new URL(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("API URL must use HTTPS (HTTP is allowed only for loopback development)");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export async function loadCredentials(dataDirectory = defaultDataDirectory()): Promise<Credentials | null> {
  try {
    const raw = await readFile(join(dataDirectory, "credentials.json"), "utf8");
    return JSON.parse(raw) as Credentials;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function saveCredentials(
  values: Omit<Credentials, "installationId"> & { installationId?: string },
  dataDirectory = defaultDataDirectory(),
): Promise<Credentials> {
  const credentials: Credentials = {
    ...values,
    apiBase: validateApiBase(values.apiBase),
    installationId: values.installationId ?? randomUUID(),
  };
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(dataDirectory, "credentials.json"),
    `${JSON.stringify(credentials, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return credentials;
}
