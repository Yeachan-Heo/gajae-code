import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
	ACP_CORE_V1_CASE_IDS,
	ACPX_GIT_HEAD,
	ACPX_VERSION,
	runAcpConformance,
	type UpstreamReport,
} from "../scripts/run-acp-conformance";

const successfulReport = (): UpstreamReport => ({
	profileId: "acp-core-v1",
	results: ACP_CORE_V1_CASE_IDS.map(id => ({ id, passed: true })),
});

function options(report: unknown): Parameters<typeof runAcpConformance>[0] {
	return {
		agentCommand: "bun agent.ts",
		reportPath: "/tmp/report.json",
		fetchMetadata: async () => ({ version: ACPX_VERSION, gitHead: ACPX_GIT_HEAD }),
		checkout: async () => ({ root: "/tmp/acpx", head: ACPX_GIT_HEAD }),
		runRunner: async () => {},
		readReport: async () => report,
		writeReport: async () => {},
	};
}

describe("runAcpConformance", () => {
	test("rejects a wrong acpx version", async () => {
		await expect(
			runAcpConformance({
				...options(successfulReport()),
				fetchMetadata: async () => ({ version: "0.0.0", gitHead: ACPX_GIT_HEAD }),
			}),
		).rejects.toThrow("acpx@0.13.0");
	});
	test("rejects a wrong acpx gitHead", async () => {
		await expect(
			runAcpConformance({
				...options(successfulReport()),
				fetchMetadata: async () => ({ version: ACPX_VERSION, gitHead: "wrong" }),
			}),
		).rejects.toThrow("gitHead");
	});
	test("rejects a source checkout at the wrong commit", async () => {
		await expect(
			runAcpConformance({
				...options(successfulReport()),
				checkout: async () => ({ root: "/tmp/acpx", head: "wrong" }),
			}),
		).rejects.toThrow("source checkout HEAD");
	});
	test("surfaces source checkout failures", async () => {
		await expect(
			runAcpConformance({
				...options(successfulReport()),
				checkout: async () => {
					throw new Error("checkout failed");
				},
			}),
		).rejects.toThrow("checkout failed");
	});
	test("rejects a malformed or missing report", async () => {
		await expect(runAcpConformance(options(undefined))).rejects.toThrow("missing or malformed");
	});
	test("rejects a missing required case ID", async () => {
		const report = successfulReport();
		report.results.pop();
		await expect(runAcpConformance(options(report))).rejects.toThrow("missing required case ID");
	});
	test("rejects duplicate case IDs", async () => {
		const report = successfulReport();
		report.results.push({ ...report.results[0]! });
		await expect(runAcpConformance(options(report))).rejects.toThrow("duplicate case ID");
	});
	test("rejects extra case IDs", async () => {
		const report = successfulReport();
		report.results.push({ id: "unexpected", passed: true });
		await expect(runAcpConformance(options(report))).rejects.toThrow("unexpected case ID");
	});
	test("rejects a failed case", async () => {
		const report = successfulReport();
		report.results[0] = { ...report.results[0]!, passed: false };
		await expect(runAcpConformance(options(report))).rejects.toThrow("Conformance case failed");
	});
	test("writes the successful machine-readable report", async () => {
		let written: unknown;
		const result = await runAcpConformance({
			...options(successfulReport()),
			cwd: "/workspace",
			writeReport: async (_path, report) => {
				written = report;
			},
		});
		expect(result).toEqual(
			expect.objectContaining({
				profile: "acp-core-v1",
				cwd: "/workspace",
				agentCommand: `bun ${path.resolve("agent.ts")}`,
				acpx: { version: ACPX_VERSION, gitHead: ACPX_GIT_HEAD },
				totals: { cases: ACP_CORE_V1_CASE_IDS.length, passed: ACP_CORE_V1_CASE_IDS.length, failed: 0 },
			}),
		);
		expect(written).toEqual(result);
	});
});
