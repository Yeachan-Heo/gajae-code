import { describe, expect, test } from "bun:test";
import { focusedStatusAction } from "./focused-status.js";

describe("focused status action", () => {
  test("launches GJC in a normal terminal tab", () => {
    expect(focusedStatusAction({ type: "terminal", rawTitle: "zsh" })).toBe("launch");
  });

  test("proceeds in an existing GJC tab", () => {
    expect(focusedStatusAction({ type: "terminal", rawTitle: "GJC: repo" })).toBe("proceed");
  });

  test("rejects browser and missing surfaces", () => {
    expect(focusedStatusAction({ type: "browser", rawTitle: "Docs" })).toBe("unavailable");
    expect(focusedStatusAction(null)).toBe("unavailable");
  });
});
