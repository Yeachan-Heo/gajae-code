import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { extractVerdictFromLedger, synthesizeAutoresearchReport } from "../../src/autoresearch/report";
import { openMissionNotebook } from "../../src/autoresearch/session";
import {
	autoresearchIssueVerdict,
	autoresearchRead,
	autoresearchWrite,
} from "../../src/gjc-runtime/autoresearch-runtime";

const TEST_SESSION_ID = "report-test-session";
const tempRoots: string[] = [];
let previousGjcSessionId: string | undefined;

beforeAll(() => {
	previousGjcSessionId = process.env.GJC_SESSION_ID;
	process.env.GJC_SESSION_ID = TEST_SESSION_ID;
});

afterAll(() => {
	if (previousGjcSessionId === undefined) {
		delete process.env.GJC_SESSION_ID;
	} else {
		process.env.GJC_SESSION_ID = previousGjcSessionId;
	}
});

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-autoresearch-report-"));
	tempRoots.push(dir);
	return dir;
}

describe("autoresearch synthesized report", () => {
	it("extracts the latest verdict receipt from the runtime ledger", async () => {
		const root = await tempDir();
		await autoresearchWrite({
			cwd: root,
			objective: "Optimize the tokenizer hot path",
			mode: "data",
			slug: "tokenizer-mission",
		});
		const verdict = await autoresearchIssueVerdict({
			cwd: root,
			status: { verdict: "best_effort", confidence: 0.8 },
			evidence: ["benchmark improved 12%"],
			caveats: ["single machine only"],
			evaluator: "mission-agent",
			slug: "tokenizer-mission",
		});
		const secondVerdict = await autoresearchIssueVerdict({
			cwd: root,
			status: { verdict: "done", confidence: 0.9 },
			evidence: ["cold-start fixed"],
			caveats: [],
			evaluator: "mission-agent",
			slug: "tokenizer-mission",
		});

		const ledger = (await autoresearchRead(root, TEST_SESSION_ID)).ledger;
		const extracted = extractVerdictFromLedger(ledger);
		expect(extracted).not.toBeNull();
		expect(extracted!.receiptId).toBe(secondVerdict.receiptId);
		expect(extracted!.status).toEqual({ verdict: "done", confidence: 0.9 });
		expect(extracted!.evidence).toEqual(["cold-start fixed"]);
		void verdict;
	});

	it("returns null when the ledger has no verdict", async () => {
		const root = await tempDir();
		await autoresearchWrite({
			cwd: root,
			objective: "Objective",
			mode: "web",
			slug: "no-verdict-mission",
		});
		const ledger = (await autoresearchRead(root, TEST_SESSION_ID)).ledger;
		expect(extractVerdictFromLedger(ledger)).toBeNull();
	});

	it("synthesizes a report from notebook cells plus the summary and carries the verdict", async () => {
		const root = await tempDir();
		await autoresearchWrite({
			cwd: root,
			objective: "Optimize the tokenizer hot path",
			mode: "data",
			slug: "tokenizer-mission",
		});
		const verdict = await autoresearchIssueVerdict({
			cwd: root,
			status: { verdict: "best_effort", confidence: 0.8, terminal: false },
			evidence: ["benchmark improved 12%", "cold start down 30%"],
			caveats: ["single machine only"],
			evaluator: "mission-agent",
			criticReceipt: {
				criticId: "critic-1",
				status: { verdict: "OKAY", pass: true },
				evidence: ["critic re-read the notebook"],
				caveats: [],
				evaluator: "critic-agent-42",
				recordedAt: new Date().toISOString(),
			},
			slug: "tokenizer-mission",
		});

		const mission = (await autoresearchRead(root, TEST_SESSION_ID)).mission!;
		const { writer, paths } = await openMissionNotebook(root, mission);
		await writer.appendCode("latency = measure()", {
			output: "12.5ms\n",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			displayOutputs: [],
		});
		await writer.flush();

		const report = await synthesizeAutoresearchReport({
			paths,
			notebook: writer,
			mission,
			summary: "Vectorized the inner loop; latency dropped from 14ms to 12.5ms.",
			verdict,
		});

		expect(report).toContain("# Autoresearch report: Optimize the tokenizer hot path");
		expect(report).toContain("Vectorized the inner loop");
		expect(report).toContain("```python\nlatency = measure()");
		expect(report).toContain("12.5ms");
		// The verdict rides along with its full receipt.
		expect(report).toContain("## Verdict");
		expect(report).toContain('"verdict": "best_effort"');
		expect(report).toContain("- Evaluator: mission-agent");
		expect(report).toContain("benchmark improved 12%");
		expect(report).toContain("cold start down 30%");
		expect(report).toContain("single machine only");
		expect(report).toContain("## Critic review");
		expect(report).toContain("- Critic evaluator: critic-agent-42");

		// The report is persisted at the mission artifact report path.
		const persisted = await Bun.file(paths.reportPath).text();
		expect(persisted).toBe(report);

		// The extracted verdict from a re-read ledger matches what we embedded.
		const ledger = (await autoresearchRead(root, TEST_SESSION_ID)).ledger;
		expect(extractVerdictFromLedger(ledger)?.receiptId).toBe(verdict.receiptId);
	});

	it("synthesizes a notebook-only report when no verdict exists", async () => {
		const root = await tempDir();
		await autoresearchWrite({
			cwd: root,
			objective: "Measure cold start",
			mode: "mixed",
			slug: "cold-start-mission",
		});
		const mission = (await autoresearchRead(root, TEST_SESSION_ID)).mission!;
		const { writer, paths } = await openMissionNotebook(root, mission);
		await writer.appendCode("print('cold')", {
			output: "cold\n",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			displayOutputs: [],
		});
		await writer.flush();

		const report = await synthesizeAutoresearchReport({ paths, notebook: writer, mission, verdict: null });
		expect(report).toContain("# Autoresearch report: Measure cold start");
		expect(report).not.toContain("## Verdict");
	});
});
