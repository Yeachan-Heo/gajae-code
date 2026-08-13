import { describe, expect, test } from "bun:test";
import { moveOption, selectedOption } from "./option-selector.js";

describe("Stream Deck option selectors", () => {
  const options = [{ id: "a" }, { id: "b" }, { id: "c" }];

  test("selects and wraps an option index", () => {
    expect(selectedOption(options, 0)).toEqual({ id: "a" });
    expect(selectedOption(options, 3)).toEqual({ id: "a" });
    expect(selectedOption(options, -1)).toEqual({ id: "c" });
  });

  test("moves forward and backward with wraparound", () => {
    expect(moveOption(options, 2, 1)).toEqual({ index: 0, option: { id: "a" } });
    expect(moveOption(options, 0, -1)).toEqual({ index: 2, option: { id: "c" } });
  });

  test("handles empty selectors", () => {
    expect(selectedOption([], 0)).toBeNull();
    expect(moveOption([], 0, 1)).toEqual({ index: 0, option: null });
  });
});
