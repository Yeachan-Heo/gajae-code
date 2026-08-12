import { describe, expect, test } from "bun:test";
import { nextSelectedSessionId } from "./focus-state.js";

const key = session => session.sessionId ?? `cmux:${session.surface.surface}`;

describe("Stream Deck focus state", () => {
  test("selects the SDK session whose tty is focused", () => {
    const sessions = [
      { sessionId: "first", tty: "ttys001" },
      { sessionId: "focused", tty: "ttys002" },
    ];
    expect(nextSelectedSessionId(sessions, "ttys002", "first", key)).toBe("focused");
  });

  test("retains the prior session when focus is not a mapped GJC tty", () => {
    const sessions = [{ sessionId: "first", tty: "ttys001" }];
    expect(nextSelectedSessionId(sessions, "ttys999", "first", key)).toBe("first");
  });

  test("falls back to the first session when the prior selection disappeared", () => {
    const sessions = [{ sessionId: "first", tty: "ttys001" }];
    expect(nextSelectedSessionId(sessions, null, "gone", key)).toBe("first");
  });
});
