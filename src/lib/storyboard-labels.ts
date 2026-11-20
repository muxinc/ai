import { Buffer } from "node:buffer";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StoryboardFrame } from "../primitives/storyboards.ts";

import { LABEL_FONT_BASE64, LABEL_FONT_FAMILY } from "./storyboard-label-font.ts";

const STRIP_HEIGHT = 34;
const PADDING = 4;
const FONT_SIZE = 26;
const JPEG_QUALITY = 85;

/** The label drawn on a frame: its 1-based position in reading order. */
export function storyboardFrameLabel(index: number): string {
  return `#${index + 1}`;
}

let fontFile: string | undefined;

// Serverless functions have no system fonts, so labels are drawn with a bundled one,
// written once per process to a directory only this process uses.
function labelFontFile(): string {
  if (!fontFile) {
    const file = join(mkdtempSync(join(tmpdir(), "mux-ai-")), "storyboard-label-font.ttf");
    writeFileSync(file, Buffer.from(LABEL_FONT_BASE64, "base64"));
    fontFile = file;
  }
  return fontFile;
}

/**
 * Adds a white strip below each row of the storyboard and writes each frame's
 * label (see {@link storyboardFrameLabel}) in black under its tile, then
 * returns the image re-encoded as a JPEG. The frames are in reading order, as
 * {@link getStoryboardFrames} returns them for the same image.
 */
export async function labelStoryboardFrames(jpegBytes: Uint8Array, frames: StoryboardFrame[]): Promise<Uint8Array> {
  // Imported here so a platform where sharp can't load falls back to an unlabeled storyboard.
  const { default: sharp } = await import("sharp");
  const { data, info } = await sharp(jpegBytes).raw().toBuffer({ resolveWithObject: true });
  const { width: tileWidth, height: tileHeight } = frames[0];
  const rows = frames[frames.length - 1].row + 1;
  const columns = Math.max(...frames.map(frame => frame.column)) + 1;
  if (info.height !== rows * tileHeight || info.width < columns * tileWidth) {
    throw new Error(`Storyboard is ${info.width}x${info.height}, which doesn't fit its ${tileWidth}x${tileHeight} frame grid`);
  }

  const source = { raw: { width: info.width, height: info.height, channels: info.channels } };
  const fontfile = labelFontFile();
  const layers = await Promise.all(frames.map(async (frame, index) => {
    const left = frame.column * tileWidth;
    const top = frame.row * (tileHeight + STRIP_HEIGHT);
    const [tile, label] = await Promise.all([
      sharp(data, source).extract({ left, top: frame.row * tileHeight, width: tileWidth, height: tileHeight }).png({ compressionLevel: 0 }).toBuffer(),
      sharp({ text: { text: storyboardFrameLabel(index), font: `${LABEL_FONT_FAMILY} ${FONT_SIZE}`, fontfile, dpi: 72, rgba: true } }).png().toBuffer(),
    ]);
    return [
      { input: tile, left, top },
      { input: label, left: left + PADDING, top: top + tileHeight + PADDING },
    ];
  }));

  const labeled = await sharp({ create: { width: info.width, height: rows * (tileHeight + STRIP_HEIGHT), channels: 3, background: "#ffffff" } })
    .composite(layers.flat())
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
  return new Uint8Array(labeled);
}
