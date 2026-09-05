import { createHash, type Hash } from "node:crypto";
import { open } from "node:fs/promises";

export const DEFAULT_CHUNK_SIZE = 1024 * 1024;
export const DEFAULT_PREFIX_LIMIT = 400;
export const DEFAULT_SUFFIX_LIMIT = 2 * 1024;
export const DEFAULT_CONTENT_LIMIT = 1024 * 1024;

export interface RecordSlice {
  prefix: Buffer;
  suffix: Buffer;
  content: Buffer | null;
  byteLength: number;
  hash: string;
  startOffset: number;
  endOffset: number;
  complete: boolean;
  truncated: boolean;
}

export interface ScanOptions {
  startOffset?: number;
  chunkSize?: number;
  prefixLimit?: number;
  suffixLimit?: number;
  contentLimit?: number;
}

function appendSuffix(current: Buffer, segment: Buffer, limit: number): Buffer {
  if (limit === 0 || segment.length === 0) return current;
  if (segment.length >= limit) return Buffer.from(segment.subarray(segment.length - limit));
  if (current.length + segment.length <= limit) return Buffer.concat([current, segment]);
  const keep = limit - segment.length;
  return Buffer.concat([current.subarray(current.length - keep), segment]);
}

export async function* scanJsonl(
  path: string,
  options: ScanOptions = {},
): AsyncGenerator<RecordSlice> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const prefixLimit = options.prefixLimit ?? DEFAULT_PREFIX_LIMIT;
  const suffixLimit = options.suffixLimit ?? DEFAULT_SUFFIX_LIMIT;
  const contentLimit = options.contentLimit ?? DEFAULT_CONTENT_LIMIT;
  const initialOffset = options.startOffset ?? 0;

  if (chunkSize < 1 || prefixLimit < 0 || suffixLimit < 0 || contentLimit < 0) {
    throw new RangeError("scan limits must be non-negative and chunkSize must be positive");
  }

  const handle = await open(path, "r");
  const input = Buffer.allocUnsafe(chunkSize);
  let fileOffset = initialOffset;
  let recordStart = initialOffset;
  let prefix: Buffer = Buffer.allocUnsafe(prefixLimit);
  let prefixLength = 0;
  let suffix: Buffer = Buffer.alloc(0);
  let byteLength = 0;
  let contentParts: Buffer[] | null = [];
  let hash: Hash = createHash("sha256");

  const reset = (nextOffset: number): void => {
    recordStart = nextOffset;
    prefix = Buffer.allocUnsafe(prefixLimit);
    prefixLength = 0;
    suffix = Buffer.alloc(0);
    byteLength = 0;
    contentParts = [];
    hash = createHash("sha256");
  };

  const addSegment = (segment: Buffer): void => {
    if (segment.length === 0) return;
    hash.update(segment);
    if (prefixLength < prefixLimit) {
      const take = Math.min(prefixLimit - prefixLength, segment.length);
      segment.copy(prefix, prefixLength, 0, take);
      prefixLength += take;
    }
    suffix = appendSuffix(suffix, segment, suffixLimit);
    byteLength += segment.length;
    if (contentParts !== null) {
      if (byteLength <= contentLimit) contentParts.push(Buffer.from(segment));
      else contentParts = null;
    }
  };

  try {
    while (true) {
      const { bytesRead } = await handle.read(input, 0, input.length, fileOffset);
      if (bytesRead === 0) break;

      let cursor = 0;
      while (cursor < bytesRead) {
        const newline = input.indexOf(0x0a, cursor);
        const end = newline === -1 || newline >= bytesRead ? bytesRead : newline;
        addSegment(input.subarray(cursor, end));
        fileOffset += end - cursor;

        if (newline === -1 || newline >= bytesRead) break;

        fileOffset += 1;
        yield {
          prefix: Buffer.from(prefix.subarray(0, prefixLength)),
          suffix,
          content: contentParts === null ? null : Buffer.concat(contentParts),
          byteLength,
          hash: hash.digest("hex"),
          startOffset: recordStart,
          endOffset: fileOffset,
          complete: true,
          truncated: contentParts === null,
        };
        reset(fileOffset);
        cursor = newline + 1;
      }
    }

    if (byteLength > 0) {
      yield {
        prefix: Buffer.from(prefix.subarray(0, prefixLength)),
        suffix,
        content: contentParts === null ? null : Buffer.concat(contentParts),
        byteLength,
        hash: hash.digest("hex"),
        startOffset: recordStart,
        endOffset: fileOffset,
        complete: false,
        truncated: contentParts === null,
      };
    }
  } finally {
    await handle.close();
  }
}
