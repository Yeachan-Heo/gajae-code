import { describe, expect, test } from "bun:test";
import { moveNavigation, recentPaths, selectedNavigationPath } from "./path-navigation.js";

describe("Stream Deck recent path navigation", () => {
  test("deduplicates paths by most recent session", () => {
    expect(recentPaths([
      { path: "/Workspace/A", updatedAt: 10 },
      { path: "/Workspace/B", updatedAt: 30 },
      { path: "/Workspace/A", updatedAt: 20 },
    ])).toEqual(["/Workspace/B", "/Workspace/A"]);
  });

  test("wraps navigation in both directions", () => {
    const paths = ["A", "B", "C"];
    expect(moveNavigation(paths, 0, -1)).toEqual({ index: 2, path: "C" });
    expect(moveNavigation(paths, 2, 1)).toEqual({ index: 0, path: "A" });
  });

  test("returns null for an empty history", () => {
    expect(selectedNavigationPath([], 0)).toBeNull();
    expect(moveNavigation([], 0, 1)).toEqual({ index: 0, path: null });
  });
});
