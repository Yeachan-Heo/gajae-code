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
	it("elides large arrays only for --compact while plain --json and readWorkflowStateJson stay full", async () => {
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

		const compactMarkdown = await runNativeStateCommand(
			["read", "--mode", "deep-interview", "--session-id", "", "--compact"],
			root,
		);
		expect(compactMarkdown.status).toBe(0);
		expect(compactMarkdown.stdout).toContain("rounds: 2 entries (elided)");
		expect(compactMarkdown.stdout).toContain("ontology_snapshots: 1 entries (elided)");
		expect(compactMarkdown.stdout).not.toContain("transcript");

		const compactJson = await runNativeStateCommand(
			["read", "--mode", "deep-interview", "--session-id", "", "--compact", "--json"],
			root,
		);
		expect(compactJson.status).toBe(0);
		const parsedCompact = JSON.parse(compactJson.stdout ?? "{}");
		expect(parsedCompact.rounds).toBeUndefined();
		expect(parsedCompact.elided.rounds).toEqual({ type: "array", count: 2, pointer: "/rounds" });

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
			[
				"write",
				"--mode",
				"ralplan",
				"--force",
				"--input",
				JSON.stringify({ current_phase: "approval", run_id: "r1" }),
			],
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

	it("resolves explicit skill for both status positional forms", async () => {
		const root = await tempDir();
		await runNativeStateCommand(
			["write", "--mode", "ralplan", "--input", JSON.stringify({ current_phase: "planner" })],
			root,
		);
		const actionFirst = await runNativeStateCommand(["status", "ralplan"], root);
		const skillFirst = await runNativeStateCommand(["ralplan", "status"], root);
		expect(actionFirst.status).toBe(0);
		expect(skillFirst.status).toBe(0);
		expect(actionFirst.stdout).toContain("ralplan: phase=planner");
		expect(skillFirst.stdout).toContain("ralplan: phase=planner");
	});

	it("rejects wrong typed consumed scalars while preserving extension fields", async () => {
		const root = await tempDir();
		const wrongVersion = await runNativeStateCommand(
			["write", "--mode", "ralplan", "--input", JSON.stringify({ version: "1", current_phase: "planner" })],
			root,
		);
		expect(wrongVersion.status).not.toBe(0);
		expect(wrongVersion.stderr).toContain("state.version must be a number");

		const wrongUpdatedAt = await runNativeStateCommand(
			["write", "--mode", "ralplan", "--input", JSON.stringify({ updated_at: 123, current_phase: "planner" })],
			root,
		);
		expect(wrongUpdatedAt.status).not.toBe(0);
		expect(wrongUpdatedAt.stderr).toContain("state.updated_at must be a string");

		const extension = await runNativeStateCommand(
			[
				"write",
				"--mode",
				"ralplan",
				"--input",
				JSON.stringify({ current_phase: "planner", rounds: [{ n: 1 }], topology: { free: ["form"] } }),
			],
			root,
		);
		expect(extension.status).toBe(0);
		const readBack = await runNativeStateCommand(["read", "--mode", "ralplan", "--json"], root);
		const parsed = JSON.parse(readBack.stdout ?? "{}");
		expect(parsed.state.rounds).toEqual([{ n: 1 }]);
		expect(parsed.state.topology).toEqual({ free: ["form"] });
	});

	it("windows audit history with --limit", async () => {
		const root = await tempDir();
		for (let index = 0; index < 5; index += 1) {
			await runNativeStateCommand(
				["write", "--mode", "ralplan", "--force", "--input", JSON.stringify({ current_phase: `phase-${index}` })],
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
