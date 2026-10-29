import { describe, expect, test } from "bun:test";
import { matchesSlashFilter } from "../src/App";

// The command-search box is also where users type slash commands, so the filter
// must accept the exact "/name" form the command input accepts.
describe("command palette slash filter", () => {
	test("matches a typed leading slash", () => {
		expect(matchesSlashFilter("model", "Show current model selection", "/model")).toBe(true);
		expect(matchesSlashFilter("effort", "Show or set model reasoning effort", "/effort")).toBe(true);
	});

	test("matches the bare name and description text", () => {
		expect(matchesSlashFilter("model", "Show current model selection", "model")).toBe(true);
		expect(matchesSlashFilter("model", "Show current model selection", "SELECTION")).toBe(true);
	});

	test("a lone slash lists every slash command", () => {
		expect(matchesSlashFilter("model", "Show current model selection", "/")).toBe(true);
		expect(matchesSlashFilter("anything", "", "  /  ")).toBe(true);
	});

	test("rejects unrelated queries", () => {
		expect(matchesSlashFilter("model", "Show current model selection", "/effort")).toBe(false);
		expect(matchesSlashFilter("model", "Show current model selection", "notify")).toBe(false);
	});
});
