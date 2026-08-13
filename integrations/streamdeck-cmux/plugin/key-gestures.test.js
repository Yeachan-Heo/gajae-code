import { describe, expect, test } from "bun:test";
import { DOUBLE_TAP_MS, isDoubleTap, pressGesture, supportsDoubleTap } from "./key-gestures.js";

describe("Stream Deck key gestures", () => {
  test("classifies holds without delaying normal taps", () => {
    expect(pressGesture(599)).toBe("tap");
    expect(pressGesture(600)).toBe("hold");
  });

  test("recognizes only taps inside the double window", () => {
    expect(isDoubleTap(1000, 1000 + DOUBLE_TAP_MS)).toBe(true);
    expect(isDoubleTap(1000, 1001 + DOUBLE_TAP_MS)).toBe(false);
    expect(isDoubleTap(undefined, 1100)).toBe(false);
  });

  test("limits delayed double-tap handling to useful controls", () => {
    expect(supportsDoubleTap({ type: "promptSubmit" })).toBe(true);
    expect(supportsDoubleTap({ type: "themeCycle" })).toBe(true);
    expect(supportsDoubleTap({ type: "command", name: "clear" })).toBe(true);
    expect(supportsDoubleTap({ type: "optionSelector" })).toBe(false);
  });
});
