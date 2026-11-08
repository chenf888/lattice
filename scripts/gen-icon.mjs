// scripts/gen-icon.mjs
// 生成 Lattice 应用图标源图（1024×1024 RGBA PNG，超采样抗锯齿）；
// 随后由 `pnpm tauri icon` 派生全套尺寸。运行：node scripts/gen-icon.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SIZE = 1024;
const SS = 2; // 超采样倍数
const N = SIZE * SS;
const S = (v) => v * SS;

// 几何（1024 基准）：圆角底板 + 表格母题（accent 表头 + 网格线）
const BG = { l: S(100), t: S(100), r: S(924), b: S(924), rad: S(185) };
const TABLE = { l: S(302), t: S(322), r: S(722), b: S(702), rad: S(28) };
const HEADER_B = S(402);
const MID_ROW = S(552);
const MID_COL = S(512);
const LINE_W = S(9);

const COL_BG = [22, 24, 29];
const COL_BODY = [28, 32, 40];
const COL_ACCENT = [79, 140, 255];
const COL_LINE = [63, 70, 84];

function sdRoundRect(x, y, r) {
  const cx = (r.l + r.r) / 2;
  const cy = (r.t + r.b) / 2;
  const hw = (r.r - r.l) / 2;
  const hh = (r.b - r.t) / 2;
  const qx = Math.abs(x - cx) - (hw - r.rad);
  const qy = Math.abs(y - cy) - (hh - r.rad);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(ax, ay) - r.rad;
}

function sample(x, y) {
  if (sdRoundRect(x, y, BG) > 0) return [0, 0, 0, 0];
  const st = sdRoundRect(x, y, TABLE);
  let r;
  let g;
  let b;
  if (st <= 0) {
    [r, g, b] = y < HEADER_B ? COL_ACCENT : COL_BODY;
  } else {
    [r, g, b] = COL_BG;
  }
  if (Math.abs(st) <= LINE_W / 2) {
    [r, g, b] = COL_LINE;
  } else if (
    Math.abs(y - MID_ROW) <= LINE_W / 2 &&
    x > TABLE.l + LINE_W &&
    x < TABLE.r - LINE_W
  ) {
    [r, g, b] = COL_LINE;
  } else if (
    Math.abs(x - MID_COL) <= LINE_W / 2 &&
    y > HEADER_B + LINE_W / 2 &&
    y < TABLE.b - LINE_W / 2 &&
    st <= 0
  ) {
    [r, g, b] = COL_LINE;
  }
  return [r, g, b, 255];
}

const acc = new Float64Array(SIZE * SIZE * 4);
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const [r, g, b, a] = sample(x + 0.5, y + 0.5);
    const i = (((y / SS) | 0) * SIZE + ((x / SS) | 0)) * 4;
    const w = 1 / (SS * SS);
    acc[i] += r * w;
    acc[i + 1] += g * w;
    acc[i + 2] += b * w;
    acc[i + 3] += a * w;
  }
}

const stride = SIZE * 4 + 1;
const raw = Buffer.alloc(SIZE * stride);
for (let y = 0; y < SIZE; y++) {
  raw[y * stride] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;
    const o = y * stride + 1 + x * 4;
    raw[o] = Math.round(acc[i]);
    raw[o + 1] = Math.round(acc[i + 1]);
    raw[o + 2] = Math.round(acc[i + 2]);
    raw[o + 3] = Math.round(acc[i + 3]);
  }
}

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const outDir = path.join(root, "scripts");
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "icon-source.png"), png);
process.stdout.write(`icon-source.png written (${png.length} bytes)\n`);
