import { describe, expect, test } from "bun:test";
import { assertValidPreset, resolvePreset, sanitizeTask } from "../src/presets";
import { preset, presetMap } from "./helpers";

describe("sanitizeTask", () => {
	test("strips control characters and collapses whitespace", () => {
		expect(sanitizeTask("hello\u0000\u001b[31m\tworld\n\n")).toBe("hello [31m world");
		expect(sanitizeTask("  spaced   out  ")).toBe("spaced out");
	});
});

describe("resolvePreset", () => {
	const demo = preset({ id: "demo", taskTemplate: "Task: {{task}}", taskMaxLen: 20 });
	const presets = presetMap(demo);

	test("rejects an unknown preset id without leaking other presets", () => {
		const result = resolvePreset(presets, "nope", "x");
		expect(result).toEqual({ ok: false, reason: "unknown_preset" });
	});

	test("substitutes a sanitized task into the single slot", () => {
		const result = resolvePreset(presets, "demo", "fix the bug");
		expect(result).toEqual({ ok: true, preset: demo, prompt: "Task: fix the bug" });
	});

	test("enforces the task length cap", () => {
		const result = resolvePreset(presets, "demo", "x".repeat(21));
		expect(result).toEqual({ ok: false, reason: "task_too_long" });
	});

	test("ignores the task argument when the preset has no template", () => {
		const noTemplate = presetMap(preset({ id: "plain", taskTemplate: undefined }));
		const result = resolvePreset(noTemplate, "plain", "ignored task");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.prompt).toBeUndefined();
	});

	test("a task cannot inject a second template slot", () => {
		const result = resolvePreset(presets, "demo", "{{task}} again");
		// The replacement value is literal; the template still has exactly one expansion.
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.prompt).toBe("Task: {{task}} again");
	});

	test("workdir and command never come from chat input", () => {
		const result = resolvePreset(presets, "demo", "anything");
		if (result.ok) {
			expect(result.preset.workdir).toBe("/home/bot/src/project");
			expect(result.preset.sessionCommand).toBe("gjc --worktree");
		}
	});
});

describe("assertValidPreset", () => {
	test("accepts a well-formed preset", () => {
		expect(() => assertValidPreset(preset())).not.toThrow();
	});

	test("rejects relative workdir", () => {
		expect(() => assertValidPreset(preset({ workdir: "relative/path" }))).toThrow(/workdir_must_be_absolute/);
	});

	test("rejects a template with zero or multiple slots", () => {
		expect(() => assertValidPreset(preset({ taskTemplate: "no slot here" }))).toThrow(/needs_one_slot/);
		expect(() => assertValidPreset(preset({ taskTemplate: "{{task}} {{task}}" }))).toThrow(/needs_one_slot/);
	});

	test("rejects a non-positive task length cap", () => {
		expect(() => assertValidPreset(preset({ taskMaxLen: 0 }))).toThrow(/task_max_len_invalid/);
	});

	test("rejects an unsafe preset id", () => {
		expect(() => assertValidPreset(preset({ id: "../escape" }))).toThrow(/invalid_preset_id/);
	});
});
