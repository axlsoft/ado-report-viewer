import { mimeType } from "./mime";
import { normalizeArchivePath } from "./paths";

const EOCD_SIGNATURE = 0x0605_4b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x0201_4b50;
const LOCAL_FILE_SIGNATURE = 0x0403_4b50;
const MAX_EOCD_SCAN_BYTES = 65_557;

export const DEFAULT_ZIP_LIMITS = {
  maxEntries: 10_000,
  maxEntryBytes: 512 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
};

export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

interface ZipEntry {
  compressionMethod: number;
  compressedSize: number;
  localHeaderOffset: number;
  name: string;
  uncompressedSize: number;
}

export class ZipArchive {
  private readonly cache = new Map<string, Blob>();
  private readonly entries = new Map<string, ZipEntry>();

  private constructor(
    private readonly archive: Blob,
    private readonly limits: ZipLimits,
  ) {}

  static async open(archive: Blob, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Promise<ZipArchive> {
    const zip = new ZipArchive(archive, limits);
    await zip.readDirectory();
    return zip;
  }

  list(): readonly string[] {
    return [...this.entries.keys()];
  }

  has(path: string): boolean {
    return this.entries.has(normalizeArchivePath(path));
  }

  async read(path: string): Promise<Blob> {
    const normalizedPath = normalizeArchivePath(path);
    const cached = this.cache.get(normalizedPath);
    if (cached) {
      return cached;
    }

    const entry = this.entries.get(normalizedPath);
    if (!entry) {
      throw new Error(`Missing from report archive: ${normalizedPath}`);
    }

    const dataOffset = await this.localDataOffset(entry.localHeaderOffset, entry.compressedSize);
    const compressed = this.archive.slice(dataOffset, dataOffset + entry.compressedSize);
    let result: Blob;
    if (entry.compressionMethod === 0) {
      if (entry.compressedSize !== entry.uncompressedSize) {
        throw new Error(`Stored entry size mismatch: ${entry.name}`);
      }
      result = compressed.slice(0, entry.uncompressedSize, mimeType(entry.name));
    } else if (entry.compressionMethod === 8) {
      result = await inflate(compressed, entry, this.limits.maxEntryBytes);
    } else {
      throw new Error(`Unsupported ZIP compression method ${entry.compressionMethod} for ${entry.name}`);
    }

    this.cache.set(normalizedPath, result);
    return result;
  }

  private async readDirectory(): Promise<void> {
    const tailOffset = Math.max(0, this.archive.size - MAX_EOCD_SCAN_BYTES);
    const tail = new DataView(await this.archive.slice(tailOffset).arrayBuffer());
    const eocdOffset = findEocd(tail);
    const entryCount = tail.getUint16(eocdOffset + 10, true);
    const directorySize = tail.getUint32(eocdOffset + 12, true);
    const directoryOffset = tail.getUint32(eocdOffset + 16, true);

    if (entryCount === 0xffff || directorySize === 0xffff_ffff || directoryOffset === 0xffff_ffff) {
      throw new Error("Zip64 archives are not supported yet");
    }
    if (entryCount > this.limits.maxEntries) {
      throw new Error(`Archive has too many entries (${entryCount})`);
    }
    if (directoryOffset + directorySize > this.archive.size) {
      throw new Error("Central directory extends outside archive");
    }

    const directory = new DataView(await this.archive.slice(directoryOffset, directoryOffset + directorySize).arrayBuffer());
    let cursor = 0;
    let totalUncompressedBytes = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true });

    for (let index = 0; index < entryCount; index += 1) {
      if (cursor + 46 > directory.byteLength || directory.getUint32(cursor, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
        throw new Error("Invalid central directory entry");
      }

      const compressionMethod = directory.getUint16(cursor + 10, true);
      const compressedSize = directory.getUint32(cursor + 20, true);
      const uncompressedSize = directory.getUint32(cursor + 24, true);
      const nameLength = directory.getUint16(cursor + 28, true);
      const extraLength = directory.getUint16(cursor + 30, true);
      const commentLength = directory.getUint16(cursor + 32, true);
      const localHeaderOffset = directory.getUint32(cursor + 42, true);
      const entryEnd = cursor + 46 + nameLength + extraLength + commentLength;

      if (entryEnd > directory.byteLength || uncompressedSize > this.limits.maxEntryBytes) {
        throw new Error("Archive entry exceeds configured limits");
      }
      totalUncompressedBytes += uncompressedSize;
      if (totalUncompressedBytes > this.limits.maxTotalBytes) {
        throw new Error("Archive exceeds configured total size limit");
      }

      const nameBytes = new Uint8Array(directory.buffer, directory.byteOffset + cursor + 46, nameLength);
      const name = normalizeArchivePath(decoder.decode(nameBytes));
      if (name && !name.endsWith("/")) {
        this.entries.set(name, { compressionMethod, compressedSize, localHeaderOffset, name, uncompressedSize });
      }
      cursor = entryEnd;
    }
  }

  private async localDataOffset(localHeaderOffset: number, compressedSize: number): Promise<number> {
    if (localHeaderOffset + 30 > this.archive.size) {
      throw new Error("Local file header extends outside archive");
    }
    const header = new DataView(await this.archive.slice(localHeaderOffset, localHeaderOffset + 30).arrayBuffer());
    if (header.getUint32(0, true) !== LOCAL_FILE_SIGNATURE) {
      throw new Error("Invalid local file header");
    }
    const dataOffset = localHeaderOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
    if (dataOffset + compressedSize > this.archive.size) {
      throw new Error("Entry data extends outside archive");
    }
    return dataOffset;
  }
}

async function inflate(compressed: Blob, entry: ZipEntry, maxEntryBytes: number): Promise<Blob> {
  const stream = compressed.stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytesRead = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytesRead += value.byteLength;
      if (bytesRead > entry.uncompressedSize || bytesRead > maxEntryBytes) {
        await reader.cancel("Decompressed data exceeds ZIP metadata");
        throw new Error(`Inflated entry exceeds declared size: ${entry.name}`);
      }
      chunks.push(new Uint8Array(value));
    }
  } finally {
    reader.releaseLock();
  }

  if (bytesRead !== entry.uncompressedSize) {
    throw new Error(`Inflated entry size mismatch: ${entry.name}`);
  }
  return new Blob(chunks, { type: mimeType(entry.name) });
}

function findEocd(view: DataView): number {
  for (let offset = view.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
      const commentLength = view.getUint16(offset + 20, true);
      if (offset + 22 + commentLength === view.byteLength) {
        return offset;
      }
    }
  }
  throw new Error("End of central directory record not found");
}