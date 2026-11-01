import { describe, expect, it } from "bun:test";
import {
	composeRecallQuery,
	formatCurrentTime,
	formatMemories,
	type HindsightMessage,
	prepareRetentionTranscript,
	sliceLastTurnsByUserBoundary,
	stripMemoryTags,
	truncateRecallQuery,
} from "@gajae-code/coding-agent/hindsight/content";

const MEMORY_TAG_NAMES = ["memories", "hindsight_memories", "relevant_memories", "mental_models"] as const;
const MEMORY_TAG_EXPRESSION = /<\s*\/?\s*(?:memories|hindsight_memories|relevant_memories|mental_models)\s*>/i;
const MEMORY_TAG_VARIANTS = MEMORY_TAG_NAMES.flatMap(name => [
	`<${name}>`,
	`</${name}>`,
	`<${name.toUpperCase()}>`,
	`</${name.toUpperCase()}>`,
	`< ${name} >`,
	`</ ${name} >`,
	`<\t${name.toUpperCase()}\n>`,
	`</\n${name}\t>`,
]);

function generatedMemoryDelimiterInputs(): string[] {
	let state = 0x6822cafe;
	const random = () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
	const fragments = [
		"fact",
		"notes",
		" ",
		"\n",
		"<",
		"</",
		"/",
		">",
		"mem",
		"ories",
		"hindsight_",
		"relevant_",
		"mental_",
		"models",
		...MEMORY_TAG_VARIANTS,
	];
	const separators = ["", " ", "\n", "\t"];
	const inputs = [
		"<<memories>/memories>",
		"<memories><hindsight_memories></MEMORIES></hindsight_memories>",
		...MEMORY_TAG_VARIANTS,
	];
	for (let sample = 0; sample < 256; sample++) {
		const fragmentCount = 1 + Math.floor(random() * 48);
		let text = "";
		for (let index = 0; index < fragmentCount; index++) {
			const fragment = fragments[Math.floor(random() * fragments.length)];
			const separator = separators[Math.floor(random() * separators.length)];
			text += `${separator}${fragment}`;
		}
		inputs.push(text);
	}
	return inputs;
}

function generatedUntaggedProse(): string[] {
	let state = 0x306f1d;
	const random = () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 0x1_0000_0000;
	};
	const fragments = [
		"Ordinary memories stay in my notes.",
		"hindsight_memories is a field name.",
		"relevant_memories and mental_models are identifiers.",
		"a < b comparison",
		"paths may contain /memories/",
		"the model remembers preferences",
	];
	const inputs: string[] = [];
	for (let sample = 0; sample < 64; sample++) {
		const count = 1 + Math.floor(random() * 8);
		const selected: string[] = [];
		for (let index = 0; index < count; index++) {
			selected.push(fragments[Math.floor(random() * fragments.length)] ?? "");
		}
		inputs.push(selected.join(" | "));
	}
	return inputs;
}

describe("generated memory delimiter inputs", () => {
	it("keeps formatted facts delimiter-free and both normalizers idempotent", () => {
		for (const input of generatedMemoryDelimiterInputs()) {
			const formatted = formatMemories([{ text: input }]);
			const factText = formatted.slice(2);
			expect(factText).not.toMatch(MEMORY_TAG_EXPRESSION);
			expect(formatMemories([{ text: factText }])).toBe(formatted);

			const stripped = stripMemoryTags(input);
			expect(stripped).not.toMatch(MEMORY_TAG_EXPRESSION);
			expect(stripMemoryTags(stripped)).toBe(stripped);
		}
	});

	it("preserves generated prose without recognized delimiters", () => {
		for (const prose of generatedUntaggedProse()) {
			expect(formatMemories([{ text: prose }])).toBe(`- ${prose}`);
			expect(stripMemoryTags(prose)).toBe(prose);
		}
	});
});

describe("stripMemoryTags", () => {
	it("removes both <memories> and legacy memory blocks", () => {
		const text = [
			"hello",
			"<memories>",
			"- some recalled fact",
			"</memories>",
			"middle",
			"<hindsight_memories>",
			"old recalled fact",
			"</hindsight_memories>",
			"<relevant_memories>",
			"more facts",
			"</relevant_memories>",
			"end",
		].join("\n");
		const stripped = stripMemoryTags(text);
		expect(stripped).not.toContain("<memories>");
		expect(stripped).not.toContain("</memories>");
		expect(stripped).not.toContain("<hindsight_memories>");
		expect(stripped).not.toContain("</hindsight_memories>");
		expect(stripped).not.toContain("<relevant_memories>");
		expect(stripped).not.toContain("</relevant_memories>");
		expect(stripped).toContain("hello");
		expect(stripped).toContain("middle");
		expect(stripped).toContain("end");
	});

	it("strips multiple sequential blocks", () => {
		const text = "<memories>a</memories><memories>b</memories>tail";
		expect(stripMemoryTags(text)).toBe("tail");
	});

	it("is a no-op when no tags are present", () => {
		expect(stripMemoryTags("plain content")).toBe("plain content");
	});

	it("strips <mental_models> blocks so curated context cannot leak back into retention", () => {
		const text = ["alpha", "<mental_models>", "# User Preferences", "prefers tabs", "</mental_models>", "beta"].join(
			"\n",
		);
		const stripped = stripMemoryTags(text);
		expect(stripped).not.toContain("<mental_models>");
		expect(stripped).not.toContain("</mental_models>");
		expect(stripped).not.toContain("# User Preferences");
		expect(stripped).toContain("alpha");
		expect(stripped).toContain("beta");
	});
});

describe("composeRecallQuery", () => {
	const messages: HindsightMessage[] = [
		{ role: "user", content: "What's the cwd?" },
		{ role: "assistant", content: "It's /tmp/foo" },
		{ role: "user", content: "Run the tests" },
		{ role: "assistant", content: "Done" },
		{ role: "user", content: "Latest question" },
	];

	it("returns the trimmed latest query when context turns is 0 or 1", () => {
		expect(composeRecallQuery("  Latest question  ", messages, 0)).toBe("Latest question");
		expect(composeRecallQuery("Latest question", messages, 1)).toBe("Latest question");
	});

	it("prepends prior context for context turns > 1", () => {
		const out = composeRecallQuery("Latest question", messages, 2);
		expect(out.startsWith("Prior context:")).toBe(true);
		expect(out.endsWith("Latest question")).toBe(true);
		// last user message must not be duplicated inside the context block
		const contextSection = out.slice("Prior context:\n\n".length, out.lastIndexOf("\n\nLatest question"));
		expect(contextSection.split("\n").every(line => !line.endsWith("Latest question"))).toBe(true);
	});

	it("strips memory tags from prior context turns", () => {
		const tagged: HindsightMessage[] = [
			{ role: "user", content: "before" },
			{ role: "assistant", content: "<memories>secret</memories>visible" },
			{ role: "user", content: "Latest" },
		];
		const out = composeRecallQuery("Latest", tagged, 5);
		expect(out).not.toContain("secret");
		expect(out).toContain("visible");
	});
});

describe("truncateRecallQuery", () => {
	it("returns the query untouched when under the budget", () => {
		expect(truncateRecallQuery("short", "short", 100)).toBe("short");
	});

	it("falls back to the latest query alone when no prior context block exists", () => {
		const long = "x".repeat(200);
		expect(truncateRecallQuery(long, long, 50)).toBe(long.slice(0, 50));
	});

	it("drops oldest context lines first", () => {
		const latest = "ZZ";
		const composed = `Prior context:\n\nuser: AAAA\nuser: BBBB\nuser: CCCC\n\n${latest}`;
		const out = truncateRecallQuery(composed, latest, "Prior context:\n\nuser: CCCC\n\nZZ".length);
		expect(out.endsWith(latest)).toBe(true);
		expect(out).toContain("CCCC");
		expect(out).not.toContain("AAAA");
	});
});

describe("sliceLastTurnsByUserBoundary", () => {
	const messages: HindsightMessage[] = [
		{ role: "user", content: "u1" },
		{ role: "assistant", content: "a1" },
		{ role: "user", content: "u2" },
		{ role: "assistant", content: "a2" },
		{ role: "user", content: "u3" },
	];

	it("returns the last N user-bounded turns", () => {
		expect(sliceLastTurnsByUserBoundary(messages, 1)).toEqual([{ role: "user", content: "u3" }]);
		expect(sliceLastTurnsByUserBoundary(messages, 2)).toEqual(messages.slice(2));
	});

	it("returns the full list when N exceeds the number of user turns", () => {
		expect(sliceLastTurnsByUserBoundary(messages, 99)).toEqual(messages);
	});

	it("returns an empty list for empty input or non-positive turns", () => {
		expect(sliceLastTurnsByUserBoundary([], 1)).toEqual([]);
		expect(sliceLastTurnsByUserBoundary(messages, 0)).toEqual([]);
	});
});

describe("prepareRetentionTranscript", () => {
	it("uses only the last turn when retainFullWindow is false", () => {
		const messages: HindsightMessage[] = [
			{ role: "user", content: "earlier" },
			{ role: "assistant", content: "earlier reply" },
			{ role: "user", content: "latest user message" },
			{ role: "assistant", content: "latest assistant reply" },
		];
		const { transcript, messageCount } = prepareRetentionTranscript(messages);
		expect(messageCount).toBe(2);
		expect(transcript).toContain("[role: user]\nlatest user message\n[user:end]");
		expect(transcript).not.toContain("earlier reply");
	});

	it("uses every message when retainFullWindow is true", () => {
		const messages: HindsightMessage[] = [
			{ role: "user", content: "u1 with enough text" },
			{ role: "assistant", content: "a1 with more text" },
		];
		const { transcript, messageCount } = prepareRetentionTranscript(messages, true);
		expect(messageCount).toBe(2);
		expect(transcript).toContain("u1");
		expect(transcript).toContain("a1");
	});

	it("strips recalled memory blocks before retaining (no feedback loop)", () => {
		const messages: HindsightMessage[] = [
			{
				role: "user",
				content: "<memories>\n- recalled fact about user\n</memories>\nuser-real-question-here",
			},
			{ role: "assistant", content: "answer about question" },
		];
		const { transcript } = prepareRetentionTranscript(messages, true);
		expect(transcript).not.toContain("<memories>");
		expect(transcript).not.toContain("recalled fact about user");
		expect(transcript).toContain("user-real-question-here");
	});

	it("returns null when nothing meaningful remains", () => {
		const empty = prepareRetentionTranscript([{ role: "user", content: "<memories>x</memories>" }], true);
		expect(empty.transcript).toBeNull();
	});

	it("strips an early memory closer so the escaped instruction is not retained", () => {
		const { transcript } = prepareRetentionTranscript(
			[
				{
					role: "user",
					content: [
						"keep-before-text",
						"<memories>",
						"recalled fact",
						"</memories>",
						"PERSIST-INJECT",
						"</memories>",
						"keep-after-note-ok",
					].join("\n"),
				},
			],
			true,
		);
		const retained = transcript ?? "";
		expect(retained).toContain("keep-before-text");
		expect(retained).toContain("keep-after-note-ok");
		expect(retained).not.toContain("PERSIST-INJECT");
		expect(retained.toLowerCase()).not.toContain("memories");
	});

	it("strips case-variant memory tags before retention", () => {
		const { transcript } = prepareRetentionTranscript(
			[
				{
					role: "user",
					content: "visible-question-about-work\n<MEMORIES>\ncase-secret-payload\n</MEMORIES>",
				},
			],
			true,
		);
		const retained = transcript ?? "";
		expect(retained).toContain("visible-question-about-work");
		expect(retained).not.toContain("case-secret-payload");
		expect(retained.toLowerCase()).not.toContain("memories");
	});

	it("strips spaced case-variant memory closers before retention", () => {
		const { transcript } = prepareRetentionTranscript(
			[{ role: "user", content: "visible-spaced-note </ MEMORIES > still-visible-text" }],
			true,
		);
		const retained = transcript ?? "";
		expect(retained).toContain("visible-spaced-note");
		expect(retained).toContain("still-visible-text");
		expect(retained.toLowerCase()).not.toContain("memories");
	});

	it("keeps legitimate prose that mentions memories without tags", () => {
		const text = "user prefers memories of tabs and a < b comparison in notes";
		const { transcript } = prepareRetentionTranscript([{ role: "user", content: text }], true);
		expect(transcript).toContain("user prefers memories of tabs");
		expect(transcript).toContain("a < b comparison");
	});

	it("keeps prose between two balanced memory blocks", () => {
		const content = [
			"<memories>",
			"alpha-fact",
			"</memories>",
			"middle-user-note",
			"<memories>",
			"beta-fact",
			"</memories>",
			"trailing-question-text",
		].join("\n");
		const { transcript } = prepareRetentionTranscript([{ role: "user", content }], true);
		const retained = transcript ?? "";
		expect(retained).toContain("middle-user-note");
		expect(retained).toContain("trailing-question-text");
		expect(retained).not.toContain("alpha-fact");
		expect(retained).not.toContain("beta-fact");
	});

	it("keeps prose around an orphan memory closer", () => {
		const { transcript } = prepareRetentionTranscript(
			[{ role: "user", content: "hello-user-note </MEMORIES> world-still-here" }],
			true,
		);
		expect(transcript).toContain("hello-user-note");
		expect(transcript).toContain("world-still-here");
	});
});

describe("formatMemories", () => {
	it("renders results with type and date suffixes when present", () => {
		const out = formatMemories([
			{ text: "fact one", type: "world", mentioned_at: "2024-01-01" },
			{ text: "fact two" },
		]);
		expect(out).toContain("- fact one [world] (2024-01-01)");
		expect(out).toContain("- fact two");
	});

	it("returns an empty string for no results", () => {
		expect(formatMemories([])).toBe("");
	});

	it("strips memory tag tokens but keeps the recalled fact text", () => {
		const out = formatMemories([{ text: "prefers tabs </memories> and <MEMORIES> dark mode" }]);
		expect(out).toContain("prefers tabs");
		expect(out).toContain("dark mode");
		expect(out.toLowerCase()).not.toContain("<");
	});

	it("keeps ordinary recalled fact text", () => {
		expect(formatMemories([{ text: "fact one stays", type: "world" }])).toContain("fact one stays");
	});
});

describe("formatCurrentTime", () => {
	it("emits a UTC YYYY-MM-DD HH:MM stamp", () => {
		const stamp = formatCurrentTime(new Date(Date.UTC(2024, 5, 7, 9, 5)));
		expect(stamp).toBe("2024-06-07 09:05");
	});
});
