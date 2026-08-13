import { describe, expect, test } from "bun:test";
import { BROWSER_TARGETS, SSH_TARGETS, USAGE_TARGETS } from "./daily-selectors.js";
import { moveOption } from "./option-selector.js";

describe("daily page selectors", () => {
  test("cycles Chrome and Safari", () => {
    expect(BROWSER_TARGETS.map(target => target.id)).toEqual(["chrome", "safari"]);
    expect(moveOption(BROWSER_TARGETS, 1, 1).option.id).toBe("chrome");
  });

  test("cycles the three established SSH hosts", () => {
    expect(SSH_TARGETS.map(target => target.port)).toEqual([22, 24, 25]);
    expect(new Set(SSH_TARGETS.map(target => target.image)).size).toBe(3);
  });

  test("uses Keeper instead of a second management page", () => {
    expect(USAGE_TARGETS.map(target => target.id)).toEqual(["usage", "keeper"]);
    expect(USAGE_TARGETS[0].url).toBe("https://api.layofflabs.com/management.html#/usage");
    expect(USAGE_TARGETS[1].url).toBe("https://api.layofflabs.com/keeper/");
    expect(USAGE_TARGETS[1].match).toContain("/keeper");
  });
});
