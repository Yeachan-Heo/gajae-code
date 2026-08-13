import { describe, expect, test } from "bun:test";
import { moveOption, selectedOption } from "./option-selector.js";
import { PROMPT_OPTIONS } from "./prompt-options.js";

describe("frequent prompt selector", () => {
  test("contains twenty unique general and lifecycle presets", () => {
    expect(PROMPT_OPTIONS).toHaveLength(20);
    expect(new Set(PROMPT_OPTIONS.map(option => option.id)).size).toBe(20);
    expect(PROMPT_OPTIONS.every(option => option.label.length > 0 && option.prompt.length > 20)).toBe(true);
  });

  test("keeps labels readable on a five-by-three Stream Deck", () => {
    for (const option of PROMPT_OPTIONS) {
      const lines = option.label.split("\n");
      expect(lines.length).toBeLessThanOrEqual(2);
      expect(Math.max(...lines.map(line => line.length))).toBeLessThanOrEqual(11);
    }
  });

  test("cycles through all presets with wraparound", () => {
    expect(moveOption(PROMPT_OPTIONS, 19, 1)).toEqual({ index: 0, option: PROMPT_OPTIONS[0] });
    expect(moveOption(PROMPT_OPTIONS, 0, -1)).toEqual({ index: 19, option: PROMPT_OPTIONS[19] });
  });

  test("includes execution, delivery, and workflow follow-up phases", () => {
    const ids = new Set(PROMPT_OPTIONS.map(option => option.id));
    for (const id of ["root-cause", "red-team", "commit-push-pr", "review-merge", "follow-deep", "follow-ralplan", "execute-plan", "handoff"]) {
      expect(ids.has(id)).toBe(true);
    }
    expect(selectedOption(PROMPT_OPTIONS, 16)?.prompt).toContain("deep-interview");
    expect(selectedOption(PROMPT_OPTIONS, 17)?.prompt).toContain("ralplan");
  });
});
