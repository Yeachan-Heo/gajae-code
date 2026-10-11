import { afterEach, describe, expect, it, setDefaultTimeout, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import { AcpAgent } from "../../src/modes/acp/acp-agent";
import { AcpSdkAdapter, AcpSdkAdapterError } from "../../src/sdk/acp/adapter";
import { brokerOwnerForTest } from "../../src/sdk/broker/ensure";

setDefaultTimeout(120_000);

const roots: string[] = [];
const brokerDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const agentDir of brokerDirs.splice(0)) await brokerOwnerForTest(agentDir)?.stop();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

function agentText(updates: readonly SessionNotification[]): string[] {
	return updates.flatMap(update =>
		update.update.sessionUpdate === "agent_message_chunk" && update.update.content.type === "text"
			? [update.update.content.text]
			: [],
	);
}

/**
 * Production path: a real AcpAgent ensures a real SDK broker, which launches a
 * real session host (AgentSession wired through runtime-init). `/progress` must
 * be advertised in the ACP palette and answered from the `session.progress`
 * query against that host's durable state — never forwarded as a model turn.
 */
describe("ACP /progress builtin", () => {
	it("is advertised and dispatched as a builtin over session.progress, not forwarded to the model", async () => {
		const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-acp-progress-"));
		roots.push(root);
		const agentDir = path.join(root, "agent");
		const cwd = path.join(root, "repo");
		await fs.mkdir(cwd, { recursive: true });
		brokerDirs.push(agentDir);
		const updates: SessionNotification[] = [];
		const abort = new AbortController();
		const agent = new AcpAgent(
			{
				sessionUpdate: async (update: SessionNotification) => {
					updates.push(update);
				},
				signal: abort.signal,
				closed: Promise.withResolvers<void>().promise,
			} as unknown as AgentSideConnection,
			{ agentDir },
		);
		try {
			const { sessionId } = await agent.newSession({ cwd, mcpServers: [] });
			await waitFor(
				() => updates.some(update => update.update.sessionUpdate === "available_commands_update"),
				"ACP available commands",
			);
			const palette = updates.find(update => update.update.sessionUpdate === "available_commands_update")
				?.update as { availableCommands?: Array<{ name: string; description: string }> };
			expect(palette.availableCommands).toContainEqual({
				name: "progress",
				description: "Show read-only project progress overview",
			});

			// Durable plan the host reads; [blocked, pending] must report the pending story as next.
			await Bun.write(
				path.join(cwd, ".gjc", `_session-${sessionId}`, "ultragoal", "goals.json"),
				JSON.stringify({
					version: 1,
					brief: "b",
					gjcObjective: "Ship observable progress",
					goals: [
						{ id: "G001", title: "Model", status: "complete", completionVerification: { receiptId: "r1" } },
						{ id: "G002", title: "Collector", status: "blocked" },
						{ id: "G003", title: "Query", status: "pending" },
					],
				}),
			);

			const before = updates.length;
			await expect(agent.prompt({ sessionId, prompt: [{ type: "text", text: "/progress" }] })).resolves.toEqual({
				stopReason: "end_turn",
			});
			const [report, ...rest] = agentText(updates.slice(before));
			expect(rest).toEqual([]);
			expect(report).toContain("Project progress  Blocked");
			expect(report).toContain("~33%  1 of 3 ultragoal stories complete");
			expect(report).toContain("next: G003 Query");
			expect(report).toContain("Story G002 is blocked: Collector");
			// No model turn ran: nothing was echoed or appended to the host transcript.
			expect(updates.slice(before).map(update => update.update.sessionUpdate)).not.toContain("user_message_chunk");
			const transcript = (await agent.extMethod("_gjc/sdk/query", {
				sessionId,
				query: "transcript.list",
			})) as { ok?: boolean; result?: { page?: { items?: unknown[] } }; page?: { items?: unknown[] } };
			expect(transcript.ok).toBe(true);
			expect(transcript.page?.items ?? transcript.result?.page?.items).toEqual([]);

			// The structured interface stays available alongside the human command.
			const structured = (await agent.extMethod("_gjc/sdk/query", {
				sessionId,
				query: "session.progress",
			})) as { result?: { page?: { items?: unknown[] } }; page?: { items?: unknown[] } };
			expect((structured.page ?? structured.result?.page)?.items?.[0]).toMatchObject({
				schema: "gjc.project_progress.v1",
				activeWork: { story: { id: "G003", title: "Query" } },
			});
			await agent.closeSession({ sessionId });
		} finally {
			abort.abort();
		}
	});

	it("owns prompt admission while the session.progress query runs and releases it on success, cancel, and error", async () => {
		const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-acp-progress-admission-"));
		roots.push(root);
		const agentDir = path.join(root, "agent");
		const cwd = path.join(root, "repo");
		await fs.mkdir(cwd, { recursive: true });
		brokerDirs.push(agentDir);
		const updates: SessionNotification[] = [];
		const abort = new AbortController();
		const agent = new AcpAgent(
			{
				sessionUpdate: async (update: SessionNotification) => {
					updates.push(update);
				},
				signal: abort.signal,
				closed: Promise.withResolvers<void>().promise,
			} as unknown as AgentSideConnection,
			{ agentDir },
		);
		try {
			const { sessionId } = await agent.newSession({ cwd, mcpServers: [] });

			// Hold each session.progress query on a gate the test settles; other queries pass through.
			let gate = Promise.withResolvers<void>();
			let progressQueries = 0;
			const originalQuery = AcpSdkAdapter.prototype.query;
			vi.spyOn(AcpSdkAdapter.prototype, "query").mockImplementation(async function (
				this: AcpSdkAdapter,
				query,
				input,
				cursor,
			) {
				if (query === "session.progress") {
					progressQueries++;
					await gate.promise;
				}
				return await originalQuery.call(this, query, input, cursor);
			});
			// Provider preflight is the first step of an admitted model prompt. Count entries and
			// fail them so no model turn ever starts; `invalid_input` is not a readiness retry.
			let preflights = 0;
			vi.spyOn(AcpSdkAdapter.prototype, "ensureProviders").mockImplementation(async () => {
				preflights++;
				throw new AcpSdkAdapterError("invalid_input", "preflight intercepted by test");
			});
			const progress = () => agent.prompt({ sessionId, prompt: [{ type: "text", text: "/progress" }] });
			const ordinary = () => agent.prompt({ sessionId, prompt: [{ type: "text", text: "ordinary prompt" }] });
			const progressText = () => agentText(updates).filter(text => text.startsWith("Project progress")).length;

			// Success: a concurrent prompt is refused while /progress owns admission, then admitted.
			const succeeding = progress();
			await waitFor(() => progressQueries === 1, "first progress query");
			await expect(ordinary()).rejects.toMatchObject({ code: "conflict" });
			expect(preflights).toBe(0);
			gate.resolve();
			await expect(succeeding).resolves.toEqual({ stopReason: "end_turn" });
			expect(progressText()).toBe(1);
			await expect(ordinary()).rejects.toMatchObject({ code: "invalid_input" });
			expect(preflights).toBe(1);

			// Cancellation: settles /progress as cancelled, publishes nothing, and releases admission.
			gate = Promise.withResolvers<void>();
			const cancelled = progress();
			await waitFor(() => progressQueries === 2, "second progress query");
			await expect(ordinary()).rejects.toMatchObject({ code: "conflict" });
			expect(preflights).toBe(1);
			const hostAbort = vi.spyOn(AcpSdkAdapter.prototype, "cancel");
			await agent.cancel({ sessionId });
			// The model-free command has no host turn, so the cancel is not forwarded as turn.abort.
			expect(hostAbort).not.toHaveBeenCalled();
			await expect(cancelled).resolves.toEqual({ stopReason: "cancelled" });
			await expect(ordinary()).rejects.toMatchObject({ code: "invalid_input" });
			expect(preflights).toBe(2);
			gate.resolve();
			await Bun.sleep(50);
			expect(progressText()).toBe(1);

			// Error: a failed query rejects /progress and releases admission.
			gate = Promise.withResolvers<void>();
			const failing = progress();
			await waitFor(() => progressQueries === 3, "third progress query");
			await expect(ordinary()).rejects.toMatchObject({ code: "conflict" });
			expect(preflights).toBe(2);
			gate.reject(new AcpSdkAdapterError("unavailable", "progress query failed in test"));
			await expect(failing).rejects.toMatchObject({ code: "unavailable" });
			await expect(ordinary()).rejects.toMatchObject({ code: "invalid_input" });
			expect(preflights).toBe(3);
			expect(progressText()).toBe(1);
			// No model turn ran at any point.
			expect(updates.map(update => update.update.sessionUpdate)).not.toContain("user_message_chunk");
		} finally {
			abort.abort();
		}
	});
});
