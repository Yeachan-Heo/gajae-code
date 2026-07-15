import { describe, expect, it } from "bun:test";
import {
	type DetectorResult,
	evaluateGate,
	evaluateSuiteGate,
	parseProbe,
	renderReport,
} from "../../src/tools/browser/benchmark/detector-report";

function result(detector: string, signals: Array<[string, boolean]>, trust: number | null = null): DetectorResult {
	return {
		detector,
		signals: signals.map(([id, pass]) => ({ id, label: id, status: pass ? "pass" : "fail" })),
		automatedVerdict: signals.every(([, p]) => p) ? "human" : "bot",
		trustScore: trust,
	};
}

describe("detector-report parseProbe", () => {
	it("normalizes a raw browser probe into a DetectorResult", () => {
		const parsed = parseProbe({
			detector: "sannysoft-offline",
			signals: [
				{ id: "webdriver", label: "navigator.webdriver undefined", pass: true, detail: "undefined" },
				{ id: "plugins", label: "plugins non-empty", pass: false, detail: "count=0" },
			],
			automatedVerdict: "bot",
			trustScore: 0.4,
		});
		expect(parsed.detector).toBe("sannysoft-offline");
		expect(parsed.signals[0]).toEqual({
			id: "webdriver",
			label: "navigator.webdriver undefined",
			status: "pass",
			detail: "undefined",
		});
		expect(parsed.signals[1]?.status).toBe("fail");
		expect(parsed.automatedVerdict).toBe("bot");
		expect(parsed.trustScore).toBe(0.4);
	});

	it("rejects malformed payloads", () => {
		// deno-lint-ignore no-explicit-any
		expect(() => parseProbe({} as never)).toThrow("invalid stealth probe payload");
	});
});

describe("detector-report evaluateGate", () => {
	it("passes when a baseline-failing signal is fixed and nothing regresses", () => {
		const baseline = result("d", [
			["webdriver", false],
			["plugins", true],
		]);
		const current = result("d", [
			["webdriver", true],
			["plugins", true],
		]);
		expect(evaluateGate(baseline, current).pass).toBe(true);
	});

	it("fails when a signal still leaks automation", () => {
		const baseline = result("d", [["webdriver", false]]);
		const current = result("d", [["webdriver", false]]);
		const out = evaluateGate(baseline, current);
		expect(out.pass).toBe(false);
		expect(out.reasons.join(" ")).toContain("leak automation");
	});

	it("fails on pass-count regression", () => {
		const baseline = result("d", [
			["a", true],
			["b", true],
		]);
		const current = result("d", [
			["a", true],
			["b", false],
		]);
		const out = evaluateGate(baseline, current);
		expect(out.pass).toBe(false);
	});

	it("empty-gap lock: passes when baseline was already all-green and stays green", () => {
		const baseline = result("d", [
			["a", true],
			["b", true],
		]);
		const current = result("d", [
			["a", true],
			["b", true],
		]);
		expect(evaluateGate(baseline, current).pass).toBe(true);
	});

	it("requires improvement when baseline had failing signals", () => {
		const baseline = result("d", [
			["a", false],
			["b", true],
		]);
		const current = result("d", [
			["a", false],
			["b", true],
		]);
		const out = evaluateGate(baseline, current);
		expect(out.pass).toBe(false);
		expect(out.reasons.join(" ")).toContain("still leak");
	});

	it("ignores absolute trust score in the gate", () => {
		const baseline = result("d", [["a", true]], 0.1);
		const current = result("d", [["a", true]], 0.9);
		expect(evaluateGate(baseline, current).pass).toBe(true);
	});
});

describe("detector-report evaluateSuiteGate + renderReport", () => {
	it("aggregates across detectors and flags a missing detector", () => {
		const baseline = [result("a", [["x", true]]), result("b", [["y", true]])];
		const current = [result("a", [["x", true]])];
		const out = evaluateSuiteGate(baseline, current);
		expect(out.pass).toBe(false);
		expect(out.reasons.join(" ")).toContain("missing from current run");
	});

	it("renders a deterministic before/after report with a gate line", () => {
		const baseline = [result("a", [["x", false]])];
		const current = [result("a", [["x", true]])];
		const report = renderReport(baseline, current);
		expect(report).toContain("# Stealth Benchmark Report");
		expect(report).toContain("Gate: PASS");
		expect(report).toContain("| x | fail | pass |");
	});
});
