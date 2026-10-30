import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ZipArchive } from "../../src/zip";

interface FixtureEntry {
  compressed?: boolean;
  declaredSize?: number;
  name: string;
  text: string;
}

class TrackingBlob extends Blob {
  sliceCount = 0;

  override slice(start?: number, end?: number, contentType?: string): Blob {
    this.sliceCount += 1;
    return super.slice(start, end, contentType);
  }
}

describe("ZipArchive", () => {
  it("reads stored and deflated nested entries with UTF-8 names", async () => {
    const archive = await ZipArchive.open(
      createZip([
        { name: "index.html", text: "<h1>Report</h1>" },
        { compressed: true, name: "assets/r\u00e9sum\u00e9.json", text: '{"passed":true}' },
        { name: "empty.txt", text: "" },
      ]),
    );

    expect(archive.list()).toEqual(["index.html", "assets/r\u00e9sum\u00e9.json", "empty.txt"]);
    await expect(archive.read("index.html").then((entry) => entry.text())).resolves.toBe("<h1>Report</h1>");
    await expect(archive.read("assets/r\u00e9sum\u00e9.json").then((entry) => entry.text())).resolves.toBe('{"passed":true}');
    await expect(archive.read("empty.txt").then((entry) => entry.text())).resolves.toBe("");
  });

  it("defers entry data slices until read and caches decoded blobs", async () => {
    const bytes = await createZip([{ compressed: true, name: "report.json", text: '{"ok":true}' }]).arrayBuffer();
    const source = new TrackingBlob([bytes]);
    const archive = await ZipArchive.open(source);
    const slicesAfterDirectory = source.sliceCount;

    const first = await archive.read("report.json");
    expect(source.sliceCount).toBeGreaterThan(slicesAfterDirectory);
    expect(await archive.read("report.json")).toBe(first);
  });

  it("rejects unsafe names and configured archive limits", async () => {
    await expect(ZipArchive.open(createZip([{ name: "../outside.html", text: "nope" }]))).rejects.toThrow("escapes the report root");
    await expect(
      ZipArchive.open(
        createZip([
          { name: "one.txt", text: "1" },
          { name: "two.txt", text: "2" },
        ]),
        { maxEntries: 1, maxEntryBytes: 1024, maxTotalBytes: 1024 },
      ),
    ).rejects.toThrow("too many entries");
  });

  it("rejects decompressed data that exceeds its central-directory declaration", async () => {
    const archive = await ZipArchive.open(
      createZip([{ compressed: true, declaredSize: 1, name: "oversized.txt", text: "actual content" }]),
    );

    await expect(archive.read("oversized.txt")).rejects.toThrow("Inflated entry exceeds declared size");
  });
});

function createZip(entries: FixtureEntry[]): Blob {
  const encoder = new TextEncoder();
  const localRecords: Uint8Array[] = [];
  const centralRecords: Uint8Array[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = encoder.encode(entry.text);
    const compressed = entry.compressed ? new Uint8Array(deflateRawSync(data)) : data;
    const method = entry.compressed ? 8 : 0;
    const declaredSize = entry.declaredSize ?? data.byteLength;
    const local = new Uint8Array(30 + name.byteLength + compressed.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x0403_4b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(8, method, true);
    localView.setUint32(18, compressed.byteLength, true);
    localView.setUint32(22, declaredSize, true);
    localView.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    local.set(compressed, 30 + name.byteLength);
    localRecords.push(local);

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x0201_4b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(20, compressed.byteLength, true);
    centralView.setUint32(24, declaredSize, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(42, localOffset, true);
    central.set(name, 46);
    centralRecords.push(central);
    localOffset += local.byteLength;
  }

  const directorySize = centralRecords.reduce((total, record) => total + record.byteLength, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x0605_4b50, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, directorySize, true);
  eocdView.setUint32(16, localOffset, true);

  const records = [...localRecords, ...centralRecords, eocd];
  const archive = new Uint8Array(records.reduce((total, record) => total + record.byteLength, 0));
  let offset = 0;
  for (const record of records) {
    archive.set(record, offset);
    offset += record.byteLength;
  }
  return new Blob([archive], { type: "application/zip" });
}