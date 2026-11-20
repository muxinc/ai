import { decode, encode } from "jpeg-js";
import { describe, expect, it } from "vitest";

import { labelStoryboardFrames } from "../../src/lib/storyboard-labels";

const TILE_WIDTH = 100;
const TILE_HEIGHT = 60;
const STRIP_HEIGHT = 22;
const GRAY = 128;

// A grid of gray tiles, two wide.
function storyboard(rows = 2): Uint8Array {
  const width = TILE_WIDTH * 2;
  const height = TILE_HEIGHT * rows;
  return new Uint8Array(encode({ width, height, data: new Uint8Array(width * height * 4).fill(GRAY) }, 95).data);
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
    x: (column - 1) * TILE_WIDTH,
    y: (row - 1) * TILE_HEIGHT,
    width: TILE_WIDTH,
    height: TILE_HEIGHT,
  }));

  it("adds a strip below each row of tiles and leaves the tiles uncovered", () => {
    const labeled = decode(labelStoryboardFrames(storyboard(), frames), { useTArray: true });

    expect(labeled.width).toBe(TILE_WIDTH * 2);
    expect(labeled.height).toBe((TILE_HEIGHT + STRIP_HEIGHT) * 2);
    for (const [row, column] of cells) {
      const top = (row - 1) * (TILE_HEIGHT + STRIP_HEIGHT);
      const left = (column - 1) * TILE_WIDTH;
      expect(luma(labeled, left + 2, top + TILE_HEIGHT - 3)).toBeCloseTo(GRAY, -1);
      expect(luma(labeled, left + TILE_WIDTH / 2, top + TILE_HEIGHT / 2)).toBeCloseTo(GRAY, -1);
    }
  });

  it("writes each frame's label in the strip under its tile", () => {
    const labeled = decode(labelStoryboardFrames(storyboard(), frames), { useTArray: true });

    for (const [row, column] of cells)
      expect(darkestInStrip(labeled, row, column)).toBeLessThan(40);
  });

  it("places labels by tile size when the grid is wider than its frames", () => {
    const labeled = decode(labelStoryboardFrames(storyboard(1), [frames[0]]), { useTArray: true });

    expect(darkestInStrip(labeled, 1, 1)).toBeLessThan(40);
    expect(darkestInStrip(labeled, 1, 2)).toBeGreaterThan(220);
  });

  it("throws when the image doesn't fit the frame grid", () => {
    expect(() => labelStoryboardFrames(storyboard(), frames.map(frame => ({ ...frame, y: frame.y / TILE_HEIGHT * 40, height: 40 })))).toThrow("doesn't fit");
  });

  it("leaves the strip blank under a grid cell without a frame", () => {
    const labeled = decode(labelStoryboardFrames(storyboard(), frames), { useTArray: true });

    expect(darkestInStrip(labeled, 2, 2)).toBeGreaterThan(220);
  });
});
