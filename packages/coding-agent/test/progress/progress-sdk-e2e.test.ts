import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { activeSnapshotPath, activeStateDir } from "../../src/gjc-runtime/session-layout";
import * as stateWriter from "../../src/gjc-runtime/state-writer";
import { createSdkMcpServer } from "../../src/sdk/mcp";
import { syncSkillActiveState } from "../../src/skill-state/active-state";
import { type AdapterFixture, fixture, runDaemonCli } from "../helpers/sdk-adapter-dispositions-shared";

/**
 * Drives `session.progress` against the real production SDK host (real
 * AgentSession wired through runtime-init) via the MCP and daemon CLI machine
 * adapters, with a real ultragoal plan on disk.
 */
describe("session.progress through production SDK adapters", () => {
	let host: AdapterFixture;

	beforeAll(async () => {
		host = await fixture();
		await Bun.write(
			path.join(host.repo, ".gjc", `_session-${host.sessionId}`, "ultragoal", "goals.json"),
			JSON.stringify({
				version: 1,
				brief: "b",
				gjcObjective: "Ship observable progress",
				goals: [
					{ id: "G001", title: "Model", status: "complete", completionVerification: { receiptId: "r1" } },
					{ id: "G002", title: "Collector", status: "active" },
					{ id: "G003", title: "Query", status: "blocked" },
				],
			}),
		);
	}, 60_000);

	afterAll(async () => {
		await host?.stop();
	});

	const expected = {
		schema: "gjc.project_progress.v1",
		state: "blocked",
		completion: { basis: "ultragoal-stories", done: 1, total: 3, percent: 33, allUnitsDone: false, complete: false },
		activeWork: { story: { id: "G002", title: "Collector" } },
		verification: { storyReceipts: { complete: 1, withReceipt: 1, withoutReceipt: 0 }, reviewVerdicts: [] },
		attention: [{ kind: "blocker", source: "ultragoal", ref: "G003", text: "Story G003 is blocked: Query" }],
		sources: { sessionStateRead: true, unreadable: [] },
	};

	it("returns the durable snapshot over MCP", async () => {
		const mcp = createSdkMcpServer({ agentDir: host.agentDir });
		try {
			const result = (await mcp.callTool("gjc_session_query", {
				sessionId: host.sessionId,
				query: "session.progress",
				input: {},
			})) as { ok?: boolean; result?: { page?: { items?: unknown[] } }; page?: { items?: unknown[] } };
			expect(result.ok).toBe(true);
			const page = result.page ?? result.result?.page;
			expect(page?.items?.[0]).toMatchObject(expected);
		} finally {
			await mcp.close();
		}
	}, 60_000);

	it("returns the same snapshot through the daemon CLI", async () => {
		const { output, exitCode } = await runDaemonCli({
			action: "query",
			agentDir: host.agentDir,
			sessionId: host.sessionId,
			query: "session.progress",
			jsonInput: "{}",
		});
		expect(exitCode).toBeUndefined();
		expect(output).toMatchObject({ type: "query_response", ok: true, page: { items: [expected], complete: true } });
	}, 60_000);

	it("does not report a workflow that only a stale derived snapshot still lists", async () => {
		const cwd = host.repo;
		const sessionId = host.sessionId;
		await syncSkillActiveState({ cwd, skill: "autoresearch", phase: "research", active: true, sessionId });
		const rebuild = vi
			.spyOn(stateWriter, "rebuildActiveSnapshot")
			.mockRejectedValue(new Error("simulated crash before snapshot rebuild"));
		await expect(syncSkillActiveState({ cwd, skill: "autoresearch", active: false, sessionId })).rejects.toThrow(
			"simulated crash before snapshot rebuild",
		);
		rebuild.mockRestore();
		const mcp = createSdkMcpServer({ agentDir: host.agentDir });
		try {
			expect(await Bun.file(activeSnapshotPath(cwd, sessionId)).text()).toContain('"autoresearch"');
			const result = (await mcp.callTool("gjc_session_query", {
				sessionId,
				query: "session.progress",
				input: {},
			})) as { ok?: boolean; result?: { page?: { items?: unknown[] } }; page?: { items?: unknown[] } };
			expect(result.ok).toBe(true);
			const page = result.page ?? result.result?.page;
			expect(page?.items?.[0]).toMatchObject({
				activeWork: { workflows: [] },
				sources: { unreadable: [], recovered: [], discarded: ["workflow-state"], unresolved: [] },
			});
		} finally {
			await mcp.close();
			await fs.rm(activeSnapshotPath(cwd, sessionId), { force: true });
			await fs.rm(activeStateDir(cwd, sessionId), { recursive: true, force: true });
		}
	}, 60_000);
});
