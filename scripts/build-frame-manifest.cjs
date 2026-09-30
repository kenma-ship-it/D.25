#!/usr/bin/env node
/**
 * Builds public/frames/manifest.json — the single source of truth the
 * cinematic intro (public/js/cinematic/) reads to know which frames exist,
 * in which order, and how they group into the five story sequences.
 *
 * Run with: npm run frames:manifest
 *
 * The supplied frames live in two export folders (seq1, seq2). The film is
 * five sequences, so the logical split below maps frame ranges inside those
 * folders onto sequences 1–5. The ranges were determined by inspecting the
 * frames themselves (scene content at each boundary):
 *
 *   1  seq1 001–037  shop entrance → interior → DE.25 wall
 *   2  seq2 001–029  DE.25 wall → blueberry cheesecake
 *   3  seq2 030–069  cheesecake → boxed dessert
 *   4  seq2 070–109  boxed dessert → Korean bun
 *   5  seq2 110–148  Korean bun → chocolate shake (final frame of the film)
 *
 * Ranges are expressed as positions in the naturally-sorted file list, not
 * as filenames, so a re-export with different names or padding still works
 * as long as the frame count per folder is unchanged. The script validates
 * that (and everything else it can check without an image library): JPEG
 * dimensions from the SOF header, numbering gaps, byte-identical duplicates,
 * and stray non-image files. It never modifies a frame.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const FRAMES_DIR = path.join(__dirname, "..", "public", "frames");
const OUT_FILE = path.join(FRAMES_DIR, "manifest.json");
const PUBLIC_BASE = "/frames";
const IMAGE_EXT = /\.(jpe?g|png|webp|avif)$/i;

/** Logical sequences, in the order they must play. `from`/`to` are 1-based, inclusive. */
const SEQUENCES = [
  { id: 1, slug: "shop", label: "The shop", folder: "seq1", from: 1, to: 37 },
  { id: 2, slug: "cheesecake", label: "Blueberry cheesecake", folder: "seq2", from: 1, to: 29 },
  { id: 3, slug: "boxed", label: "Boxed to take home", folder: "seq2", from: 30, to: 69 },
  { id: 4, slug: "bun", label: "Korean bun", folder: "seq2", from: 70, to: 109 },
  { id: 5, slug: "shake", label: "Chocolate shake", folder: "seq2", from: 110, to: 148 },
];

/** Natural sort: "frame-2" before "frame-10", regardless of zero padding. */
function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** Last run of digits in a filename, or null. */
function frameNumber(name) {
  const m = name.match(/(\d+)(?!.*\d)/);
  return m ? Number(m[1]) : null;
}

/** Reads width/height from a JPEG's SOFn marker, or PNG's IHDR. */
function readDimensions(file) {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    const isSOF = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSOF) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

function inspectFolder(folder) {
  const dir = path.join(FRAMES_DIR, folder);
  if (!fs.existsSync(dir)) throw new Error(`Missing frame folder: ${dir}`);
  const all = fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isFile());
  const files = all.filter((n) => IMAGE_EXT.test(n)).sort(naturalCompare);
  const warnings = [];

  const stray = all.filter((n) => !IMAGE_EXT.test(n));
  if (stray.length) warnings.push(`${folder}: ignoring non-image files: ${stray.join(", ")}`);

  const numbers = files.map(frameNumber);
  for (let k = 1; k < numbers.length; k++) {
    if (numbers[k] != null && numbers[k - 1] != null && numbers[k] - numbers[k - 1] !== 1) {
      warnings.push(`${folder}: numbering jumps ${numbers[k - 1]} → ${numbers[k]} (missing frames?)`);
    }
  }

  const seen = new Map();
  const dims = new Map();
  let bytes = 0;
  for (const name of files) {
    const full = path.join(dir, name);
    const data = fs.readFileSync(full);
    bytes += data.length;
    const hash = crypto.createHash("sha1").update(data).digest("hex");
    if (seen.has(hash)) warnings.push(`${folder}: ${name} is byte-identical to ${seen.get(hash)}`);
    else seen.set(hash, name);
    const d = readDimensions(full);
    const key = d ? `${d.width}x${d.height}` : "unknown";
    dims.set(key, (dims.get(key) || 0) + 1);
  }
  if (dims.size > 1) warnings.push(`${folder}: inconsistent dimensions ${JSON.stringify(Object.fromEntries(dims))}`);

  const [dominant] = [...dims.entries()].sort((a, b) => b[1] - a[1])[0] || ["unknown"];
  const [width, height] = dominant.split("x").map(Number);
  return { files, width, height, bytes, warnings };
}

function build() {
  const folders = new Map();
  for (const seq of SEQUENCES) {
    if (!folders.has(seq.folder)) folders.set(seq.folder, inspectFolder(seq.folder));
  }

  const warnings = [...folders.values()].flatMap((f) => f.warnings);
  let startIndex = 0;
  const sequences = SEQUENCES.map((seq) => {
    const info = folders.get(seq.folder);
    if (seq.to > info.files.length) {
      throw new Error(`Sequence ${seq.id} expects ${seq.folder} frames ${seq.from}–${seq.to}, but only ${info.files.length} exist.`);
    }
    const frames = info.files.slice(seq.from - 1, seq.to).map((n) => `${PUBLIC_BASE}/${seq.folder}/${n}`);
    const entry = {
      sequence: seq.id,
      slug: seq.slug,
      label: seq.label,
      frameCount: frames.length,
      startIndex,
      width: info.width,
      height: info.height,
      frames,
    };
    startIndex += frames.length;
    return entry;
  });

  // Every file in every folder must belong to exactly one sequence.
  for (const [folder, info] of folders) {
    const used = SEQUENCES.filter((s) => s.folder === folder).reduce((n, s) => n + (s.to - s.from + 1), 0);
    if (used !== info.files.length) warnings.push(`${folder}: ${info.files.length} frames on disk but sequences use ${used}.`);
  }

  const manifest = {
    version: 1,
    totalFrames: startIndex,
    width: sequences[0].width,
    height: sequences[0].height,
    totalBytes: [...folders.values()].reduce((n, f) => n + f.bytes, 0),
    sequences,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(manifest, null, 2) + "\n");

  console.log(`Wrote ${path.relative(process.cwd(), OUT_FILE)} — ${manifest.totalFrames} frames, ${(manifest.totalBytes / 1048576).toFixed(1)} MB`);
  for (const s of sequences) console.log(`  ${s.sequence}. ${s.label.padEnd(22)} ${String(s.frameCount).padStart(3)} frames  ${s.width}x${s.height}`);
  warnings.forEach((w) => console.warn(`  ! ${w}`));
}

build();
