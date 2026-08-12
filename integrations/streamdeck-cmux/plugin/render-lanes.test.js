import { describe, expect, test } from "bun:test";
import { contextEntriesForActions, contextEntriesForControls } from "./render-lanes.js";

const contexts = new Map([
  ["session", { action: "dev.gajae.streamdeck.session", settings: { slot: 0 } }],
  ["status", { action: "dev.gajae.streamdeck.focused-status", settings: {} }],
  ["answer", { action: "dev.gajae.streamdeck.control", settings: { answerSlot: 0 } }],
  ["project", { action: "dev.gajae.streamdeck.control", settings: { type: "frequentProject", slot: 0 } }],
  ["command", { action: "dev.gajae.streamdeck.control", settings: { type: "command" } }],
]);

describe("Stream Deck render lanes", () => {
  test("selects only actions affected by focus changes", () => {
    const entries = contextEntriesForActions(contexts, new Set([
      "dev.gajae.streamdeck.session",
      "dev.gajae.streamdeck.focused-status",
    ]));
    expect(entries.map(([context]) => context)).toEqual(["session", "status"]);
  });

  test("selects only ask controls for ask events", () => {
    const entries = contextEntriesForControls(contexts, settings => settings.answerSlot !== undefined);
    expect(entries.map(([context]) => context)).toEqual(["answer"]);
  });

  test("selects only frequent-project controls for project refresh", () => {
    const entries = contextEntriesForControls(contexts, settings => settings.type === "frequentProject");
    expect(entries.map(([context]) => context)).toEqual(["project"]);
  });
});
