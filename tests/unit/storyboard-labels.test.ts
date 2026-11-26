import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { labelStoryboardFrames } from "../../src/lib/storyboard-labels";

const TILE_WIDTH = 100;
const TILE_HEIGHT = 60;
const STRIP_HEIGHT = 34;
const GRAY = 128;

// A grid of gray tiles, two wide.
async function storyboard(rows = 2): Promise<Uint8Array> {
  const background = { r: GRAY, g: GRAY, b: GRAY };
  return sharp({ create: { width: TILE_WIDTH * 2, height: TILE_HEIGHT * rows, channels: 3, background } }).jpeg({ quality: 95 }).toBuffer();
}

async function decode(jpeg: Uint8Array): Promise<{ width: number; data: Uint8Array }> {
  const { data, info } = await sharp(jpeg).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, data };
}

function luma(image: { width: number; data: Uint8Array }, x: number, y: number): number {
  return image.data[(y * image.width + x) * 4];
}

// The darkest pixel along a line through the middle of a tile's strip, where its label is written.
function darkestInStrip(image: { width: number; data: Uint8Array }, row: number, column: number): number {
  const y = row * (TILE_HEIGHT + STRIP_HEIGHT) - STRIP_HEIGHT / 2;
  return Math.min(...Array.from({ length: 30 }, (_, dx) => luma(image, (column - 1) * TILE_WIDTH + 4 + dx, y)));
}

describe("labelStoryboardFrames", () => {
  const cells = [[1, 1], [1, 2], [2, 1]];
  const frames = cells.map(([row, column], index) => ({
    startTime: index,
    row: row - 1,
    column: column - 1,
    width: TILE_WIDTH,
    height: TILE_HEIGHT,
  }));

  it("adds a strip below each row of tiles and leaves the tiles uncovered", async () => {
    const jpeg = await labelStoryboardFrames(await storyboard(), frames);
    const labeled = await decode(jpeg);

    expect(await sharp(jpeg).metadata()).toMatchObject({ width: TILE_WIDTH * 2, height: (TILE_HEIGHT + STRIP_HEIGHT) * 2 });
    for (const [row, column] of cells) {
      const top = (row - 1) * (TILE_HEIGHT + STRIP_HEIGHT);
      const left = (column - 1) * TILE_WIDTH;
      expect(luma(labeled, left + 2, top + TILE_HEIGHT - 3)).toBeCloseTo(GRAY, -1);
      expect(luma(labeled, left + TILE_WIDTH / 2, top + TILE_HEIGHT / 2)).toBeCloseTo(GRAY, -1);
    }
  });

  it("writes each frame's label in the strip under its tile", async () => {
    const labeled = await decode(await labelStoryboardFrames(await storyboard(), frames));

    for (const [row, column] of cells)
      expect(darkestInStrip(labeled, row, column)).toBeLessThan(40);
  });

  it("places labels by tile size when the grid is wider than its frames", async () => {
    const labeled = await decode(await labelStoryboardFrames(await storyboard(1), [frames[0]]));

    expect(darkestInStrip(labeled, 1, 1)).toBeLessThan(40);
    expect(darkestInStrip(labeled, 1, 2)).toBeGreaterThan(220);
  });

  it("throws when the image doesn't fit the frame grid", async () => {
    await expect(labelStoryboardFrames(await storyboard(), frames.map(frame => ({ ...frame, height: 40 })))).rejects.toThrow("doesn't fit");
  });

  it("leaves the strip blank under a grid cell without a frame", async () => {
    const labeled = await decode(await labelStoryboardFrames(await storyboard(), frames));

    expect(darkestInStrip(labeled, 2, 2)).toBeGreaterThan(220);
  });
});
