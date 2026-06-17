import { describe, expect, it } from "bun:test";
import { type CliOptions, classifyTraceRecord, run, type TraceRecord } from "../bench/composer-stability-v3";

const baseOptions: CliOptions = {
	mode: "trace",
	seed: 42,
	trialsPerScenario: 5,
	model: "grok-build/grok-composer-2.5-fast",
	baselineModel: "openai-codex/gpt-5.5:low",
	json: true,
	tracePaths: [],
};

function record(partial: Partial<TraceRecord>): TraceRecord {
	return {
		scenarioId: "bash-discipline",
		modelRole: "candidate",
		model: "grok-build/grok-composer-2.5-fast",
		trial: 0,
		events: [],
		expected: {},
		...partial,
	};
}

describe("composer-stability-v3 trace classifier", () => {
	it("counts shell file reads as shell-read failures", () => {
		const result = classifyTraceRecord(
			record({
				events: [
					{
						type: "tool_execution_end",
						toolName: "bash",
						status: "success",
						arguments: { command: "cat src/secret.ts" },
					},
				],
			}),
		);
		const jsonStringArgs = classifyTraceRecord(
			record({
				events: [
					{
						type: "tool_execution_end",
						function: { name: "bash", arguments: '{"command":"cat src/secret.ts"}' },
						status: "success",
					},
				],
			}),
		);
		const scriptRead = classifyTraceRecord(
			record({
				events: [
					{
						type: "tool_execution_end",
						toolName: "bash",
						status: "success",
						arguments: {
							command: "python - <<'PY'\nfrom pathlib import Path\nPath('src/secret.ts').read_text()\nPY",
						},
					},
				],
			}),
		);
		const pythonCRead = classifyTraceRecord(
			record({
				events: [
					{
						type: "tool_execution_end",
						toolName: "bash",
						status: "success",
						arguments: { command: "python -c \"open('src/secret.ts').read()\"" },
					},
				],
			}),
		);
		const snakeCaseToolName = classifyTraceRecord(
			record({
				events: [
					{
						type: "tool_execution_end",
						tool_name: "bash",
						status: "success",
						arguments: { command: "cat src/secret.ts" },
					},
				],
			}),
		);

		expect(result.status).toBe("failed");
		expect(result.failureClasses).toContain("shell-read");
		expect(jsonStringArgs.failureClasses).toContain("shell-read");
		expect(scriptRead.failureClasses).toContain("shell-read");
		expect(pythonCRead.failureClasses).toContain("shell-read");
		expect(snakeCaseToolName.failureClasses).toContain("shell-read");
	});

	it("counts shell file discovery, shell writes, and contaminated commands", () => {
		const shellDiscovery = classifyTraceRecord(
			record({
				scenarioId: "file-discovery-discipline",
				events: [
					{
						type: "tool_execution_end",
						toolName: "bash",
						status: "success",
						arguments: { command: "find src -name '*.ts'" },
					},
				],
			}),
		);
		const gitLsFiles = classifyTraceRecord(
			record({
				scenarioId: "file-discovery-discipline",
				events: [
					{
						type: "tool_execution_end",
						toolName: "bash",
						status: "success",
						arguments: { command: "git ls-files '*.ts'" },
					},
				],
			}),
		);
		const gitCFiles = classifyTraceRecord(
			record({
				scenarioId: "file-discovery-discipline",
				events: [
					{
						type: "tool_execution_end",
						toolName: "bash",
						status: "success",
						arguments: { command: "git -C . ls-files '*.ts'" },
					},
				],
			}),
		);
		const shellWrite = classifyTraceRecord(
			record({
				scenarioId: "shell-write-discipline",
				events: [
					{
						type: "tool_execution_end",
						toolName: "bash",
						status: "success",
						arguments: {
							command: "python - <<'PY'\nfrom pathlib import Path\nPath('src/a.ts').write_text('x')\nPY",
						},
					},
				],
			}),
		);
		const pythonCWrite = classifyTraceRecord(
			record({
				scenarioId: "shell-write-discipline",
				events: [
					{
						type: "tool_execution_end",
						toolName: "bash",
						status: "success",
						arguments: {
							command: "python -c \"from pathlib import Path; Path('src/a.ts').write_text('x')\"",
						},
					},
				],
			}),
		);
		const pythonOpenWrite = classifyTraceRecord(
			record({
				scenarioId: "shell-write-discipline",
				events: [
					{
						type: "tool_execution_end",
						toolName: "bash",
						status: "success",
						arguments: { command: "python -c \"open('src/a.ts', 'w').write('x')\"" },
					},
				],
			}),
		);
		const contaminated = classifyTraceRecord(
			record({
				scenarioId: "command-contamination",
				events: [
					{
						type: "tool_execution_end",
						toolName: "bash",
						status: "error",
						arguments: {
							command: "I will now run the focused tests\nbun test packages/ai/test/composer-discipline.test.ts",
						},
					},
				],
			}),
		);

		expect(shellDiscovery.failureClasses).toContain("shell-file-discovery");
		expect(gitLsFiles.failureClasses).toContain("shell-file-discovery");
		expect(gitCFiles.failureClasses).toContain("shell-file-discovery");
		expect(shellWrite.failureClasses).toContain("shell-write");
		expect(pythonCWrite.failureClasses).toContain("shell-write");
		expect(pythonOpenWrite.failureClasses).toContain("shell-write");
		expect(contaminated.failureClasses).toContain("contaminated-command");
	});

	it("distinguishes recovered and unrecovered bad anchors", () => {
		const recovered = classifyTraceRecord(
			record({
				scenarioId: "bad-anchor-recovery",
				events: [
					{
						type: "tool_execution_end",
						toolName: "edit",
						status: "error",
						message: "Edit rejected: anchors do not match",
					},
					{
						type: "tool_execution_end",
						toolName: "read",
						status: "success",
						arguments: { path: "src/recover.ts" },
					},
					{
						type: "tool_execution_end",
						toolName: "edit",
						status: "success",
						arguments: { path: "src/recover.ts" },
					},
				],
			}),
		);
		const unrecovered = classifyTraceRecord(
			record({
				scenarioId: "bad-anchor-recovery",
				events: [
					{
						type: "tool_execution_end",
						toolName: "edit",
						status: "error",
						message: "Edit rejected: anchors do not match",
					},
				],
			}),
		);
		const ambiguousRecovery = classifyTraceRecord(
			record({
				scenarioId: "bad-anchor-recovery",
				events: [
					{
						type: "tool_execution_end",
						toolName: "edit",
						status: "error",
						message: "Edit rejected: anchors do not match",
					},
					{ type: "tool_execution_end", toolName: "read", arguments: { path: "src/recover.ts" } },
					{ type: "tool_execution_end", toolName: "edit", arguments: { path: "src/recover.ts" } },
				],
			}),
		);
		const wrongOrderRecovery = classifyTraceRecord(
			record({
				scenarioId: "bad-anchor-recovery",
				events: [
					{
						type: "tool_execution_end",
						toolName: "edit",
						status: "error",
						message: "Edit rejected: anchors do not match",
					},
					{
						type: "tool_execution_end",
						toolName: "edit",
						status: "success",
						arguments: { path: "src/recover.ts" },
					},
					{
						type: "tool_execution_end",
						toolName: "read",
						status: "success",
						arguments: { path: "src/recover.ts" },
					},
				],
			}),
		);
		const mismatchedPathRecovery = classifyTraceRecord(
			record({
				scenarioId: "bad-anchor-recovery",
				events: [
					{
						type: "tool_execution_end",
						toolName: "edit",
						status: "error",
						message: "Edit rejected: anchors do not match",
						arguments: { path: "src/recover.ts" },
					},
					{ type: "tool_execution_end", toolName: "read", status: "success", arguments: { path: "src/other.ts" } },
					{ type: "tool_execution_end", toolName: "edit", status: "success", arguments: { path: "src/other.ts" } },
				],
			}),
		);

		expect(recovered.status).toBe("passed");
		expect(unrecovered.status).toBe("failed");
		expect(unrecovered.failureClasses).toContain("bad-anchor-unrecovered");
		expect(ambiguousRecovery.failureClasses).toContain("bad-anchor-unrecovered");
		expect(wrongOrderRecovery.failureClasses).toContain("bad-anchor-unrecovered");
		expect(mismatchedPathRecovery.failureClasses).toContain("bad-anchor-unrecovered");
	});

	it("distinguishes recovered and unrecovered malformed tool arguments", () => {
		const recovered = classifyTraceRecord(
			record({
				scenarioId: "tool-json-malformed-recovery",
				events: [
					{
						type: "tool_execution_end",
						toolName: "read",
						status: "error",
						message: "malformed tool arguments: invalid JSON",
					},
					{ type: "tool_execution_end", toolName: "read", status: "success", arguments: { path: "src/ok.ts" } },
				],
			}),
		);
		const unrecovered = classifyTraceRecord(
			record({
				scenarioId: "tool-json-malformed-recovery",
				events: [
					{
						type: "tool_execution_end",
						toolName: "read",
						status: "error",
						message: "malformed tool arguments: invalid JSON",
					},
				],
			}),
		);
		const ambiguousRecovery = classifyTraceRecord(
			record({
				scenarioId: "tool-json-malformed-recovery",
				events: [
					{
						type: "tool_execution_end",
						toolName: "read",
						status: "error",
						message: "malformed tool arguments: invalid JSON",
					},
					{ type: "tool_execution_end", toolName: "read", arguments: { path: "src/ok.ts" } },
				],
			}),
		);
		const unrelatedSuccess = classifyTraceRecord(
			record({
				scenarioId: "tool-json-malformed-recovery",
				events: [
					{
						type: "tool_execution_end",
						toolName: "read",
						status: "error",
						message: "malformed tool arguments: invalid JSON",
					},
					{ type: "tool_execution_end", toolName: "bash", status: "success", arguments: { command: "bun test" } },
				],
			}),
		);

		expect(recovered.status).toBe("passed");
		expect(unrecovered.status).toBe("failed");
		expect(unrecovered.failureClasses).toContain("malformed-tool-args-unrecovered");
		expect(ambiguousRecovery.failureClasses).toContain("malformed-tool-args-unrecovered");
		expect(unrelatedSuccess.failureClasses).toContain("malformed-tool-args-unrecovered");
	});

	it("counts wrong-file, timeout, missing-tool-turn, and sanitize replay failures", () => {
		const wrongFile = classifyTraceRecord(
			record({
				scenarioId: "multi-file-search-edit",
				expected: { targetPath: "src/target.ts" },
				events: [
					{ type: "tool_execution_end", toolName: "edit", status: "success", arguments: { path: "src/wrong.ts" } },
				],
			}),
		);
		const timeout = classifyTraceRecord(
			record({
				scenarioId: "timeout-handling",
				events: [{ type: "scenario_result", status: "failed", message: "deadline timeout waiting for model" }],
			}),
		);
		const missingTool = classifyTraceRecord(
			record({
				scenarioId: "three-turn-tools",
				expected: { requiredTools: ["read", "search", "edit"] },
				events: [
					{ type: "tool_execution_end", toolName: "read", status: "success" },
					{ type: "tool_execution_end", toolName: "edit", status: "success" },
				],
			}),
		);
		const genericTerminalFailure = classifyTraceRecord(
			record({
				scenarioId: "three-turn-tools",
				events: [{ type: "scenario_result", status: "failed" }],
			}),
		);
		const sanitize = classifyTraceRecord(
			record({
				scenarioId: "grok-sanitize-replay",
				events: [
					{
						type: "tool_execution_end",
						toolName: "edit",
						status: "error",
						message: "sanitize replay failed: contaminated to=functions payload",
					},
				],
			}),
		);

		expect(wrongFile.failureClasses).toContain("wrong-file-edit");
		expect(timeout.failureClasses).toContain("timeout");
		expect(missingTool.failureClasses).toContain("missing-tool-turn");
		expect(genericTerminalFailure.failureClasses).toContain("missing-tool-turn");
		expect(sanitize.failureClasses).toContain("sanitize-replay-regression");
	});

	it("scores trace parity over candidate and baseline artifacts", async () => {
		const output = await run({
			...baseOptions,
			traceDir: "packages/agent/test/fixtures/composer-stability-v3/traces",
		});

		expect(output.mode).toBe("trace");
		expect(output.p1.applicable).toBe(true);
		expect(output.p1.candidateFailureCount).toBe(14);
		expect(output.p1.baselineFailureCount).toBe(1);
		expect(output.p1.parityDelta).toBe(13);
		expect(output.p1.passed).toBe(false);
		expect(output.traceArtifacts?.map(artifact => artifact.records).reduce((sum, count) => sum + count, 0)).toBe(26);
	});

	it("aggregates JSONL event-stream traces before scoring failures", async () => {
		const output = await run({
			...baseOptions,
			tracePaths: ["packages/agent/test/fixtures/composer-stability-v3/traces/event-stream.jsonl"],
		});

		expect(output.p1.applicable).toBe(false);
		expect(output.p1.reason).toBe("no baseline trace records found");
		expect(output.p1.candidateFailureCount).toBe(1);
		expect(output.trialResults).toHaveLength(1);
		expect(output.trialResults[0]?.failureClasses).toContain("shell-read");
	});

	it("does not let sparse candidate-baseline traces fake a P1 pass", async () => {
		const output = await run({
			...baseOptions,
			tracePaths: ["packages/agent/test/fixtures/composer-stability-v3/sparse/sparse-pass.json"],
		});

		expect(output.p1.applicable).toBe(true);
		expect(output.p1.passed).toBe(false);
		expect(output.p1.reason).toContain("insufficient comparable scenario coverage");
	});

	it("reports supplied but empty live trace artifacts explicitly", async () => {
		const output = await run({
			...baseOptions,
			mode: "live",
			traceDir: "packages/agent/test/fixtures/composer-stability-v3/empty",
		});

		expect(output.skipped).toBe(true);
		expect(output.p1.applicable).toBe(false);
		expect(output.skipReasons?.join("\n")).toContain("no scoreable trace records");
	});

	it("reports supplied but invalid live trace artifacts explicitly", async () => {
		const output = await run({
			...baseOptions,
			mode: "live",
			traceDir: "packages/agent/test/fixtures/composer-stability-v3/invalid",
		});

		expect(output.skipped).toBe(true);
		expect(output.p1.applicable).toBe(false);
		expect(output.skipReasons?.join("\n")).toContain("could not parse trace artifact");
		expect(output.skipReasons?.join("\n")).toContain("no scoreable trace records");
	});

	it("does not mark live without credentials or traces as a fake P1 pass", async () => {
		const output = await run({ ...baseOptions, mode: "live" });

		expect(output.skipped).toBe(true);
		expect(output.p1.applicable).toBe(false);
		expect(output.p1.passed).toBe(false);
		expect(output.skipReasons?.join("\n")).toContain("live capture driver is not implemented");
	});
});
