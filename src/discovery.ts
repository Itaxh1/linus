import { createHash } from "node:crypto";
import { open, opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Source } from "./extractor.js";

export interface SourceFile {
  path: string;
  source: Source;
  identityId: string;
  size: number;
  modifiedAt: number;
}

async function* walkJsonl(root: string): AsyncGenerator<string> {
  let directory;
  try {
    directory = await opendir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for await (const entry of directory) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* walkJsonl(path);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield path;
  }
}

async function stableHeadHash(path: string): Promise<string | null> {
  const handle = await open(path, "r");
  const buffer = Buffer.allocUnsafe(4096);
  try {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const retained = buffer.subarray(0, bytesRead);
    const newline = retained.indexOf(0x0a);
    if (newline >= 0) {
      return createHash("sha256").update(retained.subarray(0, newline)).digest("hex");
    }
    if (bytesRead >= 400) {
      return createHash("sha256").update(retained.subarray(0, 400)).digest("hex");
    }
    return null;
  } finally {
    await handle.close();
  }
}

function identityId(
  installationId: string,
  source: Source,
  path: string,
  identity: { dev: number; ino: number | bigint; birthtimeMs: number; headHash: string },
): string {
  return createHash("sha256")
    .update(installationId)
    .update("\0")
    .update(source)
    .update("\0")
    .update(resolve(path))
    .update("\0")
    .update(`${identity.dev}:${identity.ino}:${identity.birthtimeMs}:${identity.headHash}`)
    .digest("hex");
}

export async function discoverTranscripts(
  installationId: string,
  home = homedir(),
): Promise<SourceFile[]> {
  const roots: Array<[Source, string]> = [
    ["claude-code", join(home, ".claude", "projects")],
    ["codex", join(home, ".codex", "sessions")],
  ];
  const files: SourceFile[] = [];
  for (const [source, root] of roots) {
    for await (const path of walkJsonl(root)) {
      const metadata = await stat(path, { bigint: true });
      const headHash = await stableHeadHash(path);
      if (headHash === null) continue;
      files.push({
        path,
        source,
        identityId: identityId(installationId, source, path, {
          dev: Number(metadata.dev),
          ino: metadata.ino,
          birthtimeMs: Number(metadata.birthtimeMs),
          headHash,
        }),
        size: Number(metadata.size),
        modifiedAt: Number(metadata.mtimeMs),
      });
    }
  }
  return files.sort((left, right) =>
    right.modifiedAt - left.modifiedAt || left.path.localeCompare(right.path)
  );
}
