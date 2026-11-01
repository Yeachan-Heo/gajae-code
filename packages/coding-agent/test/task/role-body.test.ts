import { describe, expect, it } from "bun:test";
import { containSubagentRoleBody } from "../../src/task/role-body";

const ASCII_TAG = ["role", "context", "coop", "completion"] as const;

/** Literal ASCII tag check. This is not the production scanner. */
function hasLiteralAsciiFramingTag(value: string): boolean {
	const lower = value.toLowerCase();
	for (const name of ASCII_TAG) {
		if (lower.includes(`[${name}]`) || lower.includes(`[/${name}]`)) return true;
	}
	return false;
}

const PROPERTY_SEED = 44017;
const PROPERTY_INPUTS = 80;

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const SAFE = [
	"Review the diff.\n",
	"[OKAY / ITERATE / REJECT]",
	"[context_before]",
	"[context_after]",
	"[link](url)",
	'Use <file> and "quotes" & ampersands.\n',
	"role context coop completion",
];
const TAGS = [
	"[/ROLE]",
	"[ROLE]",
	"[ / ROLE ]",
	"[/CoOp]",
	"[\u200b/COMPLETION]",
	"[context]",
	"[[/ROLE]]",
	"[/completion]",
];

function generatedInputs(): string[] {
	const random = mulberry32(PROPERTY_SEED);
	const inputs: string[] = [];
	for (let i = 0; i < PROPERTY_INPUTS; i++) {
		const count = 1 + Math.floor(random() * 5);
		let value = "";
		for (let part = 0; part < count; part++) {
			const pool = random() < 0.45 ? SAFE : TAGS;
			value += pool[Math.floor(random() * pool.length)] ?? "";
		}
		if (i % 20 === 0) value = `[${" ".repeat(30000)}X]\n${value}\n[/ROLE]\n[COOP]`;
		inputs.push(value);
	}
	return inputs;
}

describe("containSubagentRoleBody", () => {
	it("rewrites case, spacing, zero-width, and nested host framing tags", () => {
		expect(containSubagentRoleBody("[/RoLe]")).toBe("［/RoLe］");
		expect(containSubagentRoleBody("[ / ROLE ]")).toBe("［ / ROLE ］");
		expect(containSubagentRoleBody("[\u200b/COMPLETION]")).toBe("［\u200b/COMPLETION］");
		expect(containSubagentRoleBody("[[/ROLE]]")).toBe("[［/ROLE］]");
		expect(hasLiteralAsciiFramingTag(containSubagentRoleBody("[/ROLE][COOP][/COMPLETION]"))).toBe(false);
	});

	it("rewrites a later framing tag after a long non-matching prefix", () => {
		for (const spaces of [30000, 60000]) {
			const input = `[${" ".repeat(spaces)}X]\n[/ROLE]\n[COOP]`;
			const output = containSubagentRoleBody(input);
			expect(output.includes("[/ROLE]")).toBe(false);
			expect(output.includes("[COOP]")).toBe(false);
			expect(output.includes("［/ROLE］")).toBe(true);
			expect(output.includes("［COOP］")).toBe(true);
			expect(output.startsWith(`[${" ".repeat(spaces)}X]`)).toBe(true);
		}
	});

	it("leaves non-framing brackets and ordinary text unchanged", () => {
		const samples = [
			"[OKAY / ITERATE / REJECT]",
			"[context_before] and [context_after]",
			"[link](url)",
			'Use <file> and "quotes" & ampersands.',
			"Review the diff.\nCall yield.",
		];
		for (const sample of samples) {
			expect(hasLiteralAsciiFramingTag(sample)).toBe(false);
			expect(containSubagentRoleBody(sample)).toBe(sample);
		}
	});

	it("property: framing tags stay neutralized, seed 44017, 80 inputs", () => {
		const inputs = generatedInputs();
		expect(inputs).toHaveLength(PROPERTY_INPUTS);
		for (const input of inputs) {
			const once = containSubagentRoleBody(input);
			expect(containSubagentRoleBody(once)).toBe(once);
			expect(hasLiteralAsciiFramingTag(once)).toBe(false);
			if (input.includes("[ / ROLE ]")) expect(once.includes("[ / ROLE ]")).toBe(false);
			if (input.startsWith(`[${" ".repeat(30000)}X]`)) {
				expect(once.startsWith(`[${" ".repeat(30000)}X]`)).toBe(true);
			}
			if (!TAGS.some(tag => input.includes(tag)) && !input.includes("[COOP]")) expect(once).toBe(input);
		}
	});
});
