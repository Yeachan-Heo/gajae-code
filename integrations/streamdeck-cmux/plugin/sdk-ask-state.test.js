import { describe, expect, test } from "bun:test";
import {
  optionIndexForSlot,
  pageAction,
  pageCount,
  pendingAsk,
  sdkMessages,
  usesPagedLayout,
} from "./sdk-ask-state.js";

function ask(options, extra = {}) {
  return pendingAsk({ type: "action_needed", kind: "ask", id: "ask-1", question: "Choose", options, ...extra });
}

describe("Stream Deck SDK ask compatibility", () => {
  test("unwraps current SDK event-ring replay envelopes", () => {
    const messages = sdkMessages(
      {
        type: "event_replay_result",
        id: "replay",
        events: [
          {
            type: "event",
            seq: 7,
            kind: "action_needed",
            payload: { type: "action_needed", kind: "ask", id: "ask-1", options: ["A"] },
          },
        ],
      },
      "replay",
    );
    expect(messages).toEqual([{ type: "action_needed", kind: "ask", id: "ask-1", options: ["A"] }]);
  });

  test("keeps five-option asks on the direct five-key layout", () => {
    const pending = ask(["A", "B", "C", "D", "Other"]);
    expect(usesPagedLayout(pending)).toBe(false);
    expect(optionIndexForSlot(pending, 4)).toBe(4);
  });

  test("pages a current six-option deep-interview ask without hiding it", () => {
    const pending = ask(["A", "B", "C", "D", "Other", "Clarify"], { transitionCount: 2 });
    expect(usesPagedLayout(pending)).toBe(true);
    expect(pageCount(pending)).toBe(2);
    expect([0, 1, 2, 3].map(slot => optionIndexForSlot(pending, slot))).toEqual([0, 1, 2, 3]);
    expect(pageAction(pending)).toEqual({ kind: "page", page: 1 });
    pending.page = 1;
    expect([0, 1, 2, 3].map(slot => optionIndexForSlot(pending, slot))).toEqual([4, 5, null, null]);
    expect(pageAction(pending)).toEqual({ kind: "page", page: 0 });
  });

  test("uses the fifth key for Done after the final multi-select page", () => {
    const pending = ask(["A", "B", "C", "D", "E"], {
      selectedOptionIndices: [1],
      controls: [{ id: "navigation_forward", kind: "navigation", label: "Done", enabled: true }],
    });
    pending.page = 1;
    expect(pageAction(pending)).toEqual({
      kind: "control",
      control: { id: "navigation_forward", kind: "navigation", label: "Done", enabled: true },
    });
  });

  test("long press on the fifth key moves to the previous page", () => {
    const pending = ask(["A", "B", "C", "D", "E", "F"]);
    pending.page = 1;
    expect(pageAction(pending, 700)).toEqual({ kind: "page", page: 0 });
  });
});
