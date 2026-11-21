import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createDeflateRaw } from "node:zlib";
import { DEFAULT_ZIP_LIMITS, type ZipLimits } from "../../src/zip";

const LOCAL_FILE_SIGNATURE = 0x0403_4b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x0807_4b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x0201_4b50;
const EOCD_SIGNATURE = 0x0605_4b50;
/** Bit 3: sizes and CRC follow the data. Bit 11: names are UTF-8. */
const FLAGS = 0x0008 | 0x0800;
const VERSION = 20;
const MAX_UINT32 = 0xffff_ffff;
const MAX_UINT16 = 0xffff;

/** Formats that are already compressed are stored as is. */
const STORED_EXTENSIONS = new Set([
  ".7z", ".avif", ".br", ".gif", ".gz", ".jpeg", ".jpg", ".m4a", ".mp3", ".mp4", ".ogg", ".png",
  ".webm", ".webp", ".woff", ".woff2", ".zip",
]);

export interface ReportFile {
  /** Path inside the archive, with `/` separators. */
  name: string;
  path: string;
  size: number;
  modified: Date;
}

export interface ArchiveSummary {
  entries: number;
  uncompressedBytes: number;
  compressedBytes: number;
}

interface CentralEntry {
  name: Buffer;
  method: number;
  dosTime: number;
  dosDate: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  offset: number;
}

/** Regular files under `root` (symbolic links to files included), sorted by archive path. */
export async function listReportFiles(root: string): Promise<ReportFile[]> {
  const files: ReportFile[] = [];
  // Symbolic links to folders are not followed, so link cycles can't recurse forever.
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        const info = await stat(path).catch(() => undefined);
        if (info?.isFile()) {
          files.push({ name: relative(root, path).split(sep).join("/"), path, size: info.size, modified: info.mtime });
        }
      }
    }
  };
  await walk(root);
  return files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Rejects reports the Reports tab can't open, before spending time compressing them. */
export function checkLimits(files: readonly ReportFile[], limits: ZipLimits = DEFAULT_ZIP_LIMITS): void {
  if (files.length > limits.maxEntries) {
    throw new Error(`The report has ${files.length} files; the Reports tab opens at most ${limits.maxEntries}.`);
  }
  const tooLarge = files.find((file) => file.size > limits.maxEntryBytes);
  if (tooLarge) {
    throw new Error(`${tooLarge.name} is ${formatBytes(tooLarge.size)}; the Reports tab opens files up to ${formatBytes(limits.maxEntryBytes)}.`);
  }
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > limits.maxTotalBytes) {
    throw new Error(`The report is ${formatBytes(total)}; the Reports tab opens reports up to ${formatBytes(limits.maxTotalBytes)}.`);
  }
}

/**
 * Writes a ZIP (no Zip64) that the Reports tab reads: deflated or stored entries, UTF-8 names, and
 * data descriptors so each file is streamed once.
 */
export async function writeZip(destination: string, files: readonly ReportFile[]): Promise<ArchiveSummary> {
  const output = await open(destination, "w");
  const central: CentralEntry[] = [];
  let offset = 0;
  let uncompressedBytes = 0;

  const write = async (buffer: Buffer): Promise<void> => {
    await output.write(buffer);
    offset += buffer.byteLength;
    if (offset > MAX_UINT32) {
      throw new Error("The report archive is larger than 4 GB, which needs Zip64; the Reports tab doesn't support Zip64.");
    }
  };

  try {
    for (const file of files) {
      const name = Buffer.from(file.name, "utf8");
      if (name.byteLength > MAX_UINT16) {
        throw new Error(`File path is too long for a ZIP archive: ${file.name}`);
      }
      const method = STORED_EXTENSIONS.has(extname(file.name).toLowerCase()) ? 0 : 8;
      const { dosDate, dosTime } = toDosDateTime(file.modified);
      const entry: CentralEntry = { name, method, dosTime, dosDate, crc: 0, compressedSize: 0, uncompressedSize: 0, offset };

      const header = Buffer.alloc(30);
      header.writeUInt32LE(LOCAL_FILE_SIGNATURE, 0);
      header.writeUInt16LE(VERSION, 4);
      header.writeUInt16LE(FLAGS, 6);
      header.writeUInt16LE(method, 8);
      header.writeUInt16LE(dosTime, 10);
      header.writeUInt16LE(dosDate, 12);
      // CRC and sizes (14-25) are zero; the data descriptor carries them.
      header.writeUInt16LE(name.byteLength, 26);
      await write(Buffer.concat([header, name]));

      let crc = 0;
      const measure = async function* (source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
        for await (const chunk of source) {
          crc = crc32(chunk, crc);
          entry.uncompressedSize += chunk.byteLength;
          yield chunk;
        }
      };
      const sink = async (source: AsyncIterable<Buffer>): Promise<void> => {
        for await (const chunk of source) {
          await write(chunk);
          entry.compressedSize += chunk.byteLength;
        }
      };
      if (method === 8) {
        await pipeline(createReadStream(file.path), measure, createDeflateRaw({ level: 6 }), sink);
      } else {
        await pipeline(createReadStream(file.path), measure, sink);
      }
      if (entry.uncompressedSize > MAX_UINT32) {
        throw new Error(`${file.name} is larger than 4 GB, which needs Zip64; the Reports tab doesn't support Zip64.`);
      }
      entry.crc = crc;
      uncompressedBytes += entry.uncompressedSize;

      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(DATA_DESCRIPTOR_SIGNATURE, 0);
      descriptor.writeUInt32LE(entry.crc, 4);
      descriptor.writeUInt32LE(entry.compressedSize, 8);
      descriptor.writeUInt32LE(entry.uncompressedSize, 12);
      await write(descriptor);
      central.push(entry);
    }

    const directoryOffset = offset;
    for (const entry of central) {
      const record = Buffer.alloc(46);
      record.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0);
      record.writeUInt16LE(VERSION, 4); // made by (MS-DOS attributes)
      record.writeUInt16LE(VERSION, 6);
      record.writeUInt16LE(FLAGS, 8);
      record.writeUInt16LE(entry.method, 10);
      record.writeUInt16LE(entry.dosTime, 12);
      record.writeUInt16LE(entry.dosDate, 14);
      record.writeUInt32LE(entry.crc, 16);
      record.writeUInt32LE(entry.compressedSize, 20);
      record.writeUInt32LE(entry.uncompressedSize, 24);
      record.writeUInt16LE(entry.name.byteLength, 28);
      record.writeUInt32LE(entry.offset, 42);
      await write(Buffer.concat([record, entry.name]));
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(EOCD_SIGNATURE, 0);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - directoryOffset, 12);
    end.writeUInt32LE(directoryOffset, 16);
    await write(end);

    return { entries: central.length, uncompressedBytes, compressedBytes: offset };
  } finally {
    await output.close();
  }
}

export function formatBytes(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} bytes` : `${value.toFixed(1)} ${units[unit]}`;
}

function toDosDateTime(date: Date): { dosDate: number; dosTime: number } {
  // DOS dates start in 1980; clamp anything earlier (such as a zero mtime from a reproducible build).
  const year = Math.max(date.getFullYear(), 1980);
  const clamped = year === date.getFullYear();
  return {
    dosDate: ((year - 1980) << 9) | ((clamped ? date.getMonth() + 1 : 1) << 5) | (clamped ? date.getDate() : 1),
    dosTime: clamped ? (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1) : 0,
  };
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

export function crc32(bytes: Uint8Array, previous = 0): number {
  let crc = ~previous >>> 0;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return ~crc >>> 0;
}
