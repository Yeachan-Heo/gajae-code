import { describe, expect, test } from "bun:test";
import { classifyRiskClasses, MAX_CANARY_TESTS, RISK_CLASSES, selectCanaryTests, selectCanaryTestsFrom, type RiskClass, type RiskClassId } from "./ci-risk-canary-manifest";

const representativePaths: readonly (readonly [RiskClassId, string])[] = [
	["process-lifecycle", "crates/pi-shell/src/process.rs"],
	["filesystem-migration", "packages/coding-agent/src/gc/gc-runtime.ts"],
	["global-env-config", "packages/coding-agent/src/paths.ts"],
	["session-sdk-notifications", "packages/coding-agent/src/session/session-manager.ts"],
	["test-fixture-helper", "packages/coding-agent/src/test-helpers.ts"],
	["ci-planner-manifest", "scripts/ci-dev-affected.ts"],
];

describe("risk canary manifest", () => {
	test("classifies each representative path", () => {
		for (const [id, changedPath] of representativePaths) {
			expect(classifyRiskClasses([changedPath])).toEqual([id]);
		}
	});

	test("classification is independent of changed-path order", () => {
		const paths = representativePaths.map(([, changedPath]) => changedPath);
		const reversed = [...paths].reverse();
		expect(classifyRiskClasses(paths)).toEqual(classifyRiskClasses(reversed));
		expect(classifyRiskClasses(paths)).toEqual(representativePaths.map(([id]) => id));
	});

	test("canary selection is independent of changed-path order", () => {
		const paths = representativePaths.map(([, changedPath]) => changedPath);
		expect(selectCanaryTests(paths)).toEqual(selectCanaryTests([...paths].reverse()));
	});

	test("session, runtime, TUI, and SDK paths select the live-stream canary", () => {
		const selected = selectCanaryTests([
			"packages/coding-agent/src/session/session-manager.ts",
			"packages/coding-agent/src/sdk/broker/host.ts",
			"packages/coding-agent/src/tui/app.tsx",
		]);
		expect(selected).toContain("packages/coding-agent/test/notifications-live-stream.test.ts");
	});

	test("records the session notification promotion source", () => {
		const riskClass = RISK_CLASSES.find(riskClass => riskClass.id === "session-sdk-notifications");
		expect(riskClass?.promotedFrom).toBe("dev-ci run 30309767471");
	});

	test("selects virtual integration coverage for CI planner changes", () => {
		expect(selectCanaryTests(["scripts/ci-virtual-integration.ts"])).toEqual(["scripts/ci-virtual-integration.test.ts"]);
	});

	test("keeps selected canaries within the bounded cost", () => {
		const selected = selectCanaryTests(representativePaths.map(([, changedPath]) => changedPath));
		const declared = new Set(RISK_CLASSES.flatMap(riskClass => riskClass.canaries));
		expect(selected.length).toBeLessThanOrEqual(MAX_CANARY_TESTS);
		expect(declared.size).toBeLessThanOrEqual(MAX_CANARY_TESTS);
	});

	test("fails closed when synthetic canaries exceed MAX_CANARY_TESTS", () => {
		const syntheticRiskClasses: RiskClass[] = Array.from({ length: MAX_CANARY_TESTS + 1 }, (_, index): RiskClass => ({
			id: "ci-planner-manifest",
			description: "synthetic over-cap risk class",
			match: { exact: ["synthetic.ts"] },
			canaries: [`synthetic-${index}.test.ts`],
		}));
		expect(() => selectCanaryTestsFrom(["synthetic.ts"], syntheticRiskClasses)).toThrow(/MAX_CANARY_TESTS/);
	});

	test("does not over-match orchestration-token benchmark fixtures", () => {
		const changedPath = "packages/orchestration-token-benchmark/src/fixtures.ts";
		expect(classifyRiskClasses([changedPath])).toEqual([]);
		expect(selectCanaryTests([changedPath])).toEqual([]);
	});

	test("does not classify unrelated coding-agent tools as fixture helpers", () => {
		const changedPath = "packages/coding-agent/src/tools/write.ts";
		expect(classifyRiskClasses([changedPath])).toEqual([]);
		expect(selectCanaryTests([changedPath])).toEqual([]);
	});

	test("does not match a bare process prefix near-miss", () => {
		const changedPath = "crates/pi-shell/src/process_helper.rs";
		expect(classifyRiskClasses([changedPath])).toEqual([]);
		expect(selectCanaryTests([changedPath])).toEqual([]);
	});

	test("declared canaries exist on disk", async () => {
		for (const riskClass of RISK_CLASSES) {
			for (const canary of riskClass.canaries) {
				expect(await Bun.file(canary).exists()).toBe(true);
			}
		}
	});

	test("ignores unrelated paths", () => {
		const paths = ["docs/readme.md", "packages/example/src/index.ts"];
		expect(classifyRiskClasses(paths)).toEqual([]);
		expect(selectCanaryTests(paths)).toEqual([]);
	});
});
