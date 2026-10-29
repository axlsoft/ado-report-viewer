import { gzipSync } from "node:zlib";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_TAB_GZIP_BYTES = 50 * 1024;
const MAX_FRAME_GZIP_BYTES = 150 * 1024;
const dist = "dist/assets";
const files = await readdir(dist);
const sizes = await Promise.all(
  files.filter((file) => file.endsWith(".js")).map(async (file) => ({ file, bytes: gzipSync(await readFile(join(dist, file))).byteLength })),
);

for (const { file, bytes } of sizes) {
  console.log(`${file}: ${bytes} bytes gzip`);
}

const tabBytes = sumFor(sizes, "tab");
const frameBytes = sumFor(sizes, "frame");
if (tabBytes > MAX_TAB_GZIP_BYTES || frameBytes > MAX_FRAME_GZIP_BYTES) {
  throw new Error(`Bundle budget exceeded: tab=${tabBytes}/${MAX_TAB_GZIP_BYTES}, frame=${frameBytes}/${MAX_FRAME_GZIP_BYTES}`);
}

function sumFor(sizes: readonly { file: string; bytes: number }[], entry: string): number {
  const matching = sizes.filter(({ file }) => file.includes(entry));
  return matching.reduce((total, { bytes }) => total + bytes, 0);
}