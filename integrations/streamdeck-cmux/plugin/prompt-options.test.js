import { describe, expect, test } from "bun:test";
import { moveOption, selectedOption } from "./option-selector.js";

const prompts = [
  { id: "continue", prompt: "continue" },
  { id: "pr-dev", prompt: "make a PR targeting dev and make it LGTM" },
  { id: "review-merge", prompt: "review and make it LGTM and merge" },
];

describe("frequent prompt selector", () => {
  test("cycles through recurring prompts with wraparound", () => {
    expect(moveOption(prompts, 2, 1)).toEqual({ index: 0, option: prompts[0] });
    expect(moveOption(prompts, 0, -1)).toEqual({ index: 2, option: prompts[2] });
  });

  test("preserves the exact submitted prompt", () => {
    expect(selectedOption(prompts, 1)?.prompt).toBe("make a PR targeting dev and make it LGTM");
    expect(selectedOption(prompts, 2)?.prompt).toBe("review and make it LGTM and merge");
  });
});
