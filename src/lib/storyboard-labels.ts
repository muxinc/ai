import { decode, encode } from "jpeg-js";

import type { StoryboardFrame } from "../primitives/storyboards.ts";

const glyph = (art: string) => art.trim().split("\n").map(row => row.trim());

// 5x7 glyphs for the characters a frame label uses, with # for ink.
const GLYPHS: Record<string, string[]> = {
  "#": glyph(`
    .#.#.
    .#.#.
    #####
    .#.#.
    #####
    .#.#.
    .#.#.
  `),
  "0": glyph(`
    .###.
    #...#
    #..##
    #.#.#
    ##..#
    #...#
    .###.
  `),
  "1": glyph(`
    ..#..
    .##..
    ..#..
    ..#..
    ..#..
    ..#..
    .###.
  `),
  "2": glyph(`
    .###.
    #...#
    ....#
    ...#.
    ..#..
    .#...
    #####
  `),
  "3": glyph(`
    ####.
    ....#
    ....#
    .###.
    ....#
    ....#
    ####.
  `),
  "4": glyph(`
    ...#.
    ..##.
    .#.#.
    #..#.
    #####
    ...#.
    ...#.
  `),
  "5": glyph(`
    #####
    #....
    ####.
    ....#
    ....#
    #...#
    .###.
  `),
  "6": glyph(`
    ..##.
    .#...
    #....
    ####.
    #...#
    #...#
    .###.
  `),
  "7": glyph(`
    #####
    ....#
    ...#.
    ..#..
    .#...
    .#...
    .#...
  `),
  "8": glyph(`
    .###.
    #...#
    #...#
    .###.
    #...#
    #...#
    .###.
  `),
  "9": glyph(`
    .###.
    #...#
    #...#
    .####
    ....#
    ...#.
    .##..
  `),
};

const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;
const SCALE = 2;
const PADDING = 4;
const JPEG_QUALITY = 85;

/** The label drawn on a frame: its 1-based position in reading order. */
export function storyboardFrameLabel(index: number): string {
  return `#${index + 1}`;
}

/**
 * Adds a white strip below each row of the storyboard and writes each frame's
 * label (see {@link storyboardFrameLabel}) in black under its tile, then
 * returns the image re-encoded as a JPEG. The frames are in reading order, as
 * {@link getStoryboardFrames} returns them for the same image.
 */
export function labelStoryboardFrames(jpegBytes: Uint8Array, frames: StoryboardFrame[]): Uint8Array {
  const source = decode(jpegBytes, { useTArray: true, formatAsRGBA: true });
  const { width: tileWidth, height: tileHeight } = frames[0];
  const rowOf = (frame: StoryboardFrame) => Math.round(frame.y / tileHeight);
  const rows = Math.max(...frames.map(rowOf)) + 1;
  const gridWidth = Math.max(...frames.map(frame => frame.x)) + tileWidth;
  if (source.height !== rows * tileHeight || source.width < gridWidth) {
    throw new Error(`Storyboard is ${source.width}x${source.height}, which doesn't fit its ${tileWidth}x${tileHeight} frame grid`);
  }
  const stripHeight = PADDING * 2 + GLYPH_HEIGHT * SCALE;
  const width = source.width;
  const height = rows * (tileHeight + stripHeight);
  const data = new Uint8Array(width * height * 4).fill(255);

  const rowBytes = width * 4;
  for (let row = 0; row < rows; row++) {
    const from = row * tileHeight * rowBytes;
    data.set(source.data.subarray(from, from + tileHeight * rowBytes), row * (tileHeight + stripHeight) * rowBytes);
  }

  const ink = (x: number, y: number) => {
    if (x >= width || y >= height)
      return;
    const i = (y * width + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 0;
  };

  const drawChar = (char: string, left: number, top: number) => {
    GLYPHS[char].forEach((glyphRow, glyphY) => [...glyphRow].forEach((bit, glyphX) => {
      if (bit !== "#")
        return;
      for (let dy = 0; dy < SCALE; dy++) {
        for (let dx = 0; dx < SCALE; dx++)
          ink(left + glyphX * SCALE + dx, top + glyphY * SCALE + dy);
      }
    }));
  };

  frames.forEach((frame, index) => {
    const left = frame.x + PADDING;
    const top = rowOf(frame) * (tileHeight + stripHeight) + tileHeight + PADDING;
    [...storyboardFrameLabel(index)].forEach((char, charIndex) =>
      drawChar(char, left + charIndex * (GLYPH_WIDTH + 1) * SCALE, top));
  });

  return new Uint8Array(encode({ width, height, data }, JPEG_QUALITY).data);
}
