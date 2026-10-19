import { expect, test } from "bun:test";
import { selectAppendSystemPromptFile } from "../src/cli/append-system-prompt";

const PROPERTY_SEED = 444;
const PROPERTY_COUNT = 64;
const LEVELS = ["user", "project"] as const;

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

test("selectAppendSystemPromptFile keeps the first user path across seeded inputs", () => {
	const rng = mulberry32(PROPERTY_SEED);
	for (let i = 0; i < PROPERTY_COUNT; i++) {
		const count = 1 + Math.floor(rng() * 6);
		const candidates = Array.from({ length: count }, (_, index) => ({
			level: LEVELS[Math.floor(rng() * LEVELS.length)] ?? "project",
			path: `/cfg/${i}/${index}.md`,
		}));
		const selected = selectAppendSystemPromptFile(candidates);
		const again = selectAppendSystemPromptFile(candidates);
		const expected = candidates.find(candidate => candidate.level === "user")?.path;
		expect(selected).toBe(expected);
		expect(again).toBe(selected);
		if (selected !== undefined) {
			expect(candidates.find(candidate => candidate.path === selected)?.level).toBe("user");
		}
	}
	expect(selectAppendSystemPromptFile([{ level: "project", path: "/repo/.gjc/APPEND_SYSTEM.md" }])).toBeUndefined();
	expect(
		selectAppendSystemPromptFile([
			{ level: "project", path: "/repo/.gemini/APPEND_SYSTEM.md" },
			{ level: "user", path: "/home/APPEND_SYSTEM.md" },
			{ level: "user", path: "/home/later.md" },
		]),
	).toBe("/home/APPEND_SYSTEM.md");
});
