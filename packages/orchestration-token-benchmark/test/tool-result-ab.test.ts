import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@gajae-code/coding-agent";
import {
	compareArms,
	measureToolResults,
	renderToolResultAbMarkdown,
	summarizeArm,
	type TaskRun,
	TOOL_RESULT_AB_SCHEMA_VERSION,
	transcriptError,
} from "../src/tool-result-ab";
import { AB_TASKS, answerMatches, writeAbCorpus } from "../src/tool-result-ab-corpus";
import { assertArmsDiffer, assertKnownSettings, parseLiveAbArgs } from "../src/tool-result-ab-live";

function run(arm: string, taskId: string, chars: number, success: boolean): TaskRun {
	return {
		taskId,
		arm,
		repeat: 0,
		success,
		toolResultChars: chars,
		byTool: { read: { calls: 1, chars } },
		totalTokens: chars / 4,
	};
}

describe("measureToolResults", () => {
	it("counts only tool-result text, grouped by tool", () => {
		const measured = measureToolResults([
			{ role: "user", content: [{ type: "text", text: "ignored user text" }] },
			{ role: "assistant", content: [{ type: "text", text: "ignored assistant text" }] },
			{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "abcd" }] },
			{
				role: "toolResult",
				toolName: "read",
				content: [
					{ type: "text", text: "ef" },
					{ type: "image", data: "AAAA", mimeType: "image/png" },
				],
			},
			{ role: "toolResult", toolName: "search", content: [{ type: "text", text: "xyz" }] },
		]);
		expect(measured).toEqual({
			chars: 9,
			byTool: { read: { calls: 2, chars: 6 }, search: { calls: 1, chars: 3 } },
		});
	});
});

describe("transcriptError", () => {
	it("surfaces the first errored assistant turn and ignores clean transcripts", () => {
		expect(
			transcriptError([
				{ role: "assistant", stopReason: "toolUse" },
				{ role: "assistant", stopReason: "error", errorMessage: "400 unknown provider" },
			]),
		).toBe("400 unknown provider");
		expect(transcriptError([{ role: "assistant", stopReason: "stop" }])).toBeUndefined();
	});
});

describe("compareArms", () => {
	it("reports a candidate win only when chars drop and success holds", () => {
		const runs = [run("baseline", "a", 1000, true), run("candidate", "a", 400, true)];
		const verdict = compareArms(summarizeArm("baseline", runs), summarizeArm("candidate", runs));
		expect(verdict.outcome).toBe("candidate-wins");
		expect(verdict.charsPerTaskReduction).toBeCloseTo(0.6);
	});

	it("rejects a candidate that saves chars by failing tasks", () => {
		const runs = [
			run("baseline", "a", 1000, true),
			run("baseline", "b", 1000, true),
			run("candidate", "a", 100, true),
			run("candidate", "b", 100, false),
		];
		const verdict = compareArms(summarizeArm("baseline", runs), summarizeArm("candidate", runs));
		expect(verdict.outcome).toBe("success-regressed");
		expect(verdict.reasons[0]).toContain("1/2");
	});

	it("reports no improvement when chars are unchanged", () => {
		const runs = [run("baseline", "a", 500, true), run("candidate", "a", 500, true)];
		expect(compareArms(summarizeArm("baseline", runs), summarizeArm("candidate", runs)).outcome).toBe(
			"no-improvement",
		);
	});

	it("treats provider-errored runs as inconclusive instead of a zero-char win", () => {
		const errored = { ...run("candidate", "a", 0, false), error: "400 unknown provider" };
		const runs = [run("baseline", "a", 1000, true), errored];
		const candidate = summarizeArm("candidate", runs);
		expect(candidate.errored).toBe(1);
		const verdict = compareArms(summarizeArm("baseline", runs), candidate);
		expect(verdict.outcome).toBe("inconclusive");
		expect(verdict.reasons[0]).toContain("candidate 1/1");
	});

	it("refuses to summarize an arm with no runs", () => {
		expect(() => summarizeArm("candidate", [run("baseline", "a", 1, true)])).toThrow("No runs recorded");
	});
});

describe("renderToolResultAbMarkdown", () => {
	it("renders success, per-task chars, and the verdict", () => {
		const runs = [run("baseline", "a", 2000, true), run("candidate", "a", 500, true)];
		const baseline = summarizeArm("baseline", runs);
		const candidate = summarizeArm("candidate", runs);
		const markdown = renderToolResultAbMarkdown({
			schemaVersion: TOOL_RESULT_AB_SCHEMA_VERSION,
			model: "test/model",
			repeats: 1,
			arms: { baseline: {}, candidate: { "search.contextAfter": 1 } },
			baseline,
			candidate,
			verdict: compareArms(baseline, candidate),
			runs,
		});
		expect(markdown).toContain("| Task success | 1/1 | 1/1 |");
		expect(markdown).toContain("| Errored runs | 0 | 0 |");
		expect(markdown).toContain("| Tool-result chars / task | 2,000 | 500 |");
		expect(markdown).toContain("Verdict: **candidate-wins** (chars/task reduction 75.0%");
	});
});

describe("A/B corpus", () => {
	it("plants every task answer in the generated workspace", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-ab-corpus-"));
		try {
			await writeAbCorpus(root);
			const files = ["src/ledger.ts", "src/shipping.ts", "src/payments.ts", "config/gateway.toml"];
			const corpus = (await Promise.all(files.map(file => Bun.file(path.join(root, file)).text()))).join("\n");
			expect(corpus).toContain(`LEDGER_RETRY_CEILING = ${AB_TASKS[0]!.expect};`);
			expect(corpus).toContain(`SHIPPING_OWNER = "${AB_TASKS[1]!.expect}"`);
			expect(corpus).toContain(`circuit_breaker_cooldown_ms = ${AB_TASKS[2]!.expect}`);
			const sources = await fs.readdir(path.join(root, "src"));
			expect(String(sources.length)).toBe(AB_TASKS[3]!.expect);
			// Bare-path reads must exceed the default 10 KiB receipt budget to exercise the issue's traffic shape.
			expect((await fs.stat(path.join(root, "src/payments.ts"))).size).toBeGreaterThan(20 * 1024);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("matches answers as standalone tokens only", () => {
		expect(answerMatches("The value is 1111.", "1111")).toBe(true);
		expect(answerMatches("11112", "1111")).toBe(false);
		expect(answerMatches("team-shipping-80", "team-shipping-8")).toBe(false);
		expect(answerMatches(undefined, "8")).toBe(false);
	});
});

describe("live A/B arguments", () => {
	it("parses arms, repeats, and task filters", () => {
		const args = ["--model", "test/model", "--candidate", '{"search.contextAfter":1}', "--repeats", "3"];
		const options = parseLiveAbArgs([...args, "--tasks", "owner", "--out", "/tmp/out"]);
		expect(options).toMatchObject({
			model: "test/model",
			baseline: {},
			candidate: { "search.contextAfter": 1 },
			repeats: 3,
			outputDir: "/tmp/out",
		});
		expect(options.tasks.map(task => task.id)).toEqual(["owner"]);
	});

	it("rejects runs that cannot measure a difference", () => {
		expect(() => parseLiveAbArgs(["--model", "m"])).toThrow("--candidate must override at least one setting");
		expect(() => parseLiveAbArgs(["--model", "m", "--candidate", "[1]"])).toThrow("JSON object");
		expect(() => parseLiveAbArgs(["--model", "m", "--candidate", '{"a":1}', "--repeats", "0"])).toThrow("--repeats");
		expect(() => parseLiveAbArgs(["--model", "m", "--candidate", '{"a":1}', "--tasks", "nope"])).toThrow(
			"matched no corpus task",
		);
	});

	it("rejects arms that resolve to identical effective settings", () => {
		const candidate = { "tools.maxInlineResultBytes": 12 };
		expect(() => assertArmsDiffer(candidate, candidate)).toThrow("identical settings");
		// An omitted baseline resolves to the schema default, whatever it currently is.
		const defaults = Settings.isolated();
		const defaultArm = { "tools.maxInlineResultBytes": defaults.get("tools.maxInlineResultBytes") };
		expect(() => assertArmsDiffer({}, defaultArm)).toThrow("identical settings");
		assertArmsDiffer({ "tools.maxInlineResultBytes": 0 }, candidate);
	});

	it("rejects unknown setting overrides before any live run", () => {
		assertKnownSettings({ "search.contextAfter": 1, "tools.maxInlineResultBytes": 20 });
		expect(() => assertKnownSettings({ "search.contxtAfter": 1 })).toThrow(
			"Unknown setting override: search.contxtAfter",
		);
	});
});
