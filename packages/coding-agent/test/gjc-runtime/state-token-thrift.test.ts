import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readWorkflowStateJson, runNativeStateCommand } from "@gajae-code/coding-agent/gjc-runtime/state-runtime";

const tempRoots: string[] = [];

async function tempDir(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-state-token-thrift-"));
	tempRoots.push(root);
	return root;
}

afterEach(async () => {
	for (const root of tempRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("GJC state token thrift", () => {
	it("elides large arrays in default read while --json and readWorkflowStateJson stay full", async () => {
		const root = await tempDir();
		const payload = {
			current_phase: "interviewing",
			rounds: [
				{ n: 1, transcript: "full" },
				{ n: 2, transcript: "full" },
			],
			ontology_snapshots: [{ id: "o1" }],
			architect_findings: [{ finding: "large" }],
			new_requirements: [{ text: "keep" }],
			ci_gates: [{ name: "gate" }],
			research_findings: [{ source: "paper" }],
		};
		await runNativeStateCommand(
			["write", "--mode", "deep-interview", "--session-id", "", "--input", JSON.stringify(payload)],
			root,
		);

		const markdown = await runNativeStateCommand(["read", "--mode", "deep-interview", "--session-id", ""], root);
		expect(markdown.status).toBe(0);
		expect(markdown.stdout).toContain("rounds: 2 entries (--json for full)");
		expect(markdown.stdout).toContain("ontology_snapshots: 1 entries (--json for full)");
		expect(markdown.stdout).not.toContain("transcript");

		const json = await runNativeStateCommand(
			["read", "--mode", "deep-interview", "--session-id", "", "--json"],
			root,
		);
		expect(json.status).toBe(0);
		const parsed = JSON.parse(json.stdout ?? "{}");
		const raw = await readWorkflowStateJson(root, "deep-interview");
		expect(parsed.state).toEqual(raw);
		expect(parsed.state.rounds).toEqual(payload.rounds);
	});

	it("projects requested fields in requested order", async () => {
		const root = await tempDir();
		await runNativeStateCommand(
			["write", "--mode", "ralplan", "--input", JSON.stringify({ current_phase: "approval", run_id: "r1" })],
			root,
		);

		const result = await runNativeStateCommand(
			["read", "--mode", "ralplan", "--fields", "phase,next,run_id", "--json"],
			root,
		);
		expect(result.status).toBe(0);
		const parsed = JSON.parse(result.stdout ?? "{}");
		expect(Object.keys(parsed)).toEqual(["phase", "next", "run_id"]);
		expect(parsed.phase).toBe("approval");
		expect(parsed.run_id).toBe("r1");
	});

	it("prints state status as one line", async () => {
		const root = await tempDir();
		await runNativeStateCommand(
			["write", "--mode", "deep-interview", "--input", JSON.stringify({ current_phase: "interviewing" })],
			root,
		);

		const result = await runNativeStateCommand(["status", "deep-interview"], root);
		expect(result.status).toBe(0);
		expect(result.stdout?.trim().split("\n")).toHaveLength(1);
		expect(result.stdout).toContain("deep-interview: phase=interviewing");
		expect(result.stdout).toContain("next=");
	});

	it("windows audit history with --limit", async () => {
		const root = await tempDir();
		for (let index = 0; index < 5; index += 1) {
			await runNativeStateCommand(
				["write", "--mode", "ralplan", "--input", JSON.stringify({ current_phase: `phase-${index}` })],
				root,
			);
		}

		const result = await runNativeStateCommand(["graph", "--history", "--limit", "2", "--json"], root);
		expect(result.status).toBe(0);
		const parsed = JSON.parse(result.stdout ?? "{}");
		expect(parsed.entries).toHaveLength(2);
		expect(parsed.limit).toBe(2);
		expect(parsed.truncated).toBe(true);
	});
});
