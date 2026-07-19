import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	ackCodexWakeEvent,
	bindDelegateCodexHandoff,
	listCodexWakeEvents,
	readCodexHandoff,
	recordCodexWakeEvent,
	registerCodexHandoff,
	updateCodexWakeEvent,
} from "../src/coordinator-mcp/codex-handoff";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-codex-handoff-"));
	tempDirs.push(root);
	return root;
}

async function persistedText(root: string): Promise<string> {
	const entries = await fs.readdir(root, { withFileTypes: true });
	const values = await Promise.all(
		entries.map(async entry => {
			const file = path.join(root, entry.name);
			return entry.isDirectory() ? persistedText(file) : fs.readFile(file, "utf8");
		}),
	);
	return values.join("\n");
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("Codex handoff durable state", () => {
	it("suppresses duplicate wake events without changing the original event", async () => {
		const root = await tempRoot();
		const input = {
			work_unit: "session-1",
			event_seq: 3,
			event_kind: "turn.completed" as const,
			summary: "first completion",
		};
		const first = await recordCodexWakeEvent(root, input);
		const duplicate = await recordCodexWakeEvent(root, { ...input, summary: "changed summary" });

		expect(first.created).toBe(true);
		expect(duplicate.created).toBe(false);
		expect(JSON.stringify(duplicate.event)).toBe(JSON.stringify(first.event));
	});

	it("persists registrations and wake state across fresh reads", async () => {
		const root = await tempRoot();
		await registerCodexHandoff(root, {
			work_unit: "session-2",
			thread_id: "thread-2",
			endpoint: { kind: "unix", path: "/tmp/codex.sock" },
		});
		const wake = await recordCodexWakeEvent(root, {
			work_unit: "session-2",
			event_seq: 4,
			event_kind: "question.opened",
			question_id: "question-2",
			summary: "A question needs an answer.",
		});

		expect((await readCodexHandoff(root, "session-2"))?.thread_id).toBe("thread-2");
		expect((await listCodexWakeEvents(root, "session-2"))[0]?.status).toBe("pending");
		await ackCodexWakeEvent(root, wake.event.key);
		expect((await listCodexWakeEvents(root, "session-2"))[0]?.status).toBe("acked");
	});
	it("enforces terminal wake state and bounds durable wake summaries", async () => {
		const root = await tempRoot();
		const wake = await recordCodexWakeEvent(root, {
			work_unit: "session-3",
			event_seq: 5,
			event_kind: "turn.completed",
			summary: `completed\n${"x".repeat(300)}`,
		});
		expect(wake.event.summary).toHaveLength(240);
		expect(wake.event.summary).not.toContain("\n");

		await updateCodexWakeEvent(root, wake.event.key, { status: "published" });
		const published = await updateCodexWakeEvent(root, wake.event.key, {
			status: "pending",
			attempts_delta: 1,
		});
		expect(published).toMatchObject({ status: "published", attempts: 1 });
		const acked = await ackCodexWakeEvent(root, wake.event.key);
		expect(await updateCodexWakeEvent(root, wake.event.key, { status: "failed", attempts_delta: 1 })).toEqual(acked);
	});

	it("rejects invalid work units and missing wake acknowledgements", async () => {
		const root = await tempRoot();
		await expect(
			recordCodexWakeEvent(root, {
				work_unit: "../not-safe",
				event_seq: 1,
				event_kind: "turn.failed",
				summary: "failed",
			}),
		).rejects.toThrow("invalid_work_unit");
		await expect(ackCodexWakeEvent(root, "missing:1")).rejects.toThrow("resource_gone");
	});

	it("stores token-file references without persisting token material", async () => {
		const root = await tempRoot();
		const token = "actual-codex-token-material";
		const tokenDir = await tempRoot();
		const tokenFile = path.join(tokenDir, "token.txt");
		await fs.writeFile(tokenFile, token, { mode: 0o600 });
		await registerCodexHandoff(root, {
			work_unit: "session-3",
			thread_id: "thread-3",
			endpoint: { kind: "unix", path: "/tmp/codex.sock" },
			token_file: tokenFile,
		});

		const state = await persistedText(root);
		expect(state).not.toContain(token);
		expect(state).toContain(tokenFile);
		await expect(
			registerCodexHandoff(root, {
				work_unit: "session-4",
				thread_id: "thread-4",
				endpoint: { kind: "unix", path: "/tmp/codex.sock" },
				token_file: "./token.txt",
			}),
		).rejects.toThrow("token_material_not_allowed");
	});
	it("creates exactly one wake across concurrent Bun processes", async () => {
		const root = await tempRoot();
		const marker = path.join(root, "start");
		const modulePath = path.resolve(import.meta.dir, "../src/coordinator-mcp/codex-handoff.ts");
		const script = (writer: string) => `
import { access } from "node:fs/promises";
import { recordCodexWakeEvent } from ${JSON.stringify(modulePath)};
while (true) {
	try {
		await access(${JSON.stringify(marker)});
		break;
	} catch {
		await Bun.sleep(1);
	}
}
console.log(JSON.stringify(await recordCodexWakeEvent(${JSON.stringify(root)}, {
	work_unit: "session-atomic",
	event_seq: 7,
	event_kind: "turn.completed",
	summary: ${JSON.stringify(`writer:${writer}`)},
})));
`;
		const first = Bun.spawn({ cmd: [process.execPath, "-e", script("one")], stdout: "pipe", stderr: "pipe" });
		const second = Bun.spawn({ cmd: [process.execPath, "-e", script("two")], stdout: "pipe", stderr: "pipe" });
		await Bun.sleep(10);
		await fs.writeFile(marker, "");
		const [firstExit, secondExit, firstOutput, secondOutput] = await Promise.all([
			first.exited,
			second.exited,
			new Response(first.stdout).text(),
			new Response(second.stdout).text(),
		]);

		expect([firstExit, secondExit]).toEqual([0, 0]);
		const results = [firstOutput, secondOutput].map(
			output => JSON.parse(output) as { created: boolean; event: Record<string, unknown> },
		);
		expect(results.filter(result => result.created)).toHaveLength(1);
		const winner = results.find(result => result.created)!;
		const persisted = JSON.parse(
			await fs.readFile(path.join(root, "codex-wake-events", "session-atomic__7.json"), "utf8"),
		) as Record<string, unknown>;
		expect(persisted).toMatchObject(winner.event);
	});
	it("never exposes a partial delegate binding to concurrent binders", async () => {
		const root = await tempRoot();
		const source = await registerCodexHandoff(root, {
			work_unit: "host",
			thread_id: "thread-source",
			endpoint: { kind: "unix", path: "/tmp/codex.sock" },
		});
		for (let index = 0; index < 20; index++) {
			const origin = {
				gjc_session_id: `concurrent-${index}`,
				gjc_turn_id: null,
				codex_thread_id: "thread-source",
				codex_turn_id: null,
				codex_host_session_id: "host",
				delegation_id: `delegate-${index}`,
				workflow: "execute",
				bound_at: "2026-07-19T00:00:00.000Z",
			};
			const results = await Promise.all([
				bindDelegateCodexHandoff(root, { work_unit: `concurrent-${index}`, source, origin }),
				bindDelegateCodexHandoff(root, { work_unit: `concurrent-${index}`, source, origin }),
			]);
			expect(results[0]?.handoff).toEqual(results[1]?.handoff);
			expect(results.map(result => result.created)).toEqual(expect.arrayContaining([true, false]));
		}
	});
	it("round-trips delegate origins and never overwrites an existing delegate binding", async () => {
		const root = await tempRoot();
		const source = await registerCodexHandoff(root, {
			work_unit: "host-session",
			thread_id: "thread-source",
			endpoint: { kind: "unix", path: "/tmp/codex.sock" },
			token_file: "/tmp/codex-token",
		});
		const origin = {
			gjc_session_id: "delegate-session",
			gjc_turn_id: "delegate-turn",
			codex_thread_id: "thread-source",
			codex_turn_id: "codex-turn-1",
			codex_host_session_id: "host-session",
			delegation_id: "delegate-turn",
			workflow: "execute",
			bound_at: "2026-07-19T00:00:00.000Z",
		};
		const first = await bindDelegateCodexHandoff(root, {
			work_unit: "delegate-session",
			source,
			origin,
		});
		const file = path.join(root, "codex-handoffs", "delegate-session.json");
		const beforeSecondBind = await fs.readFile(file, "utf8");
		const second = await bindDelegateCodexHandoff(root, {
			work_unit: "delegate-session",
			source,
			origin: { ...origin, delegation_id: "other-turn" },
		});

		expect(first).toMatchObject({ created: true, handoff: { origin } });
		expect(second).toMatchObject({ created: false, handoff: { origin } });
		expect(await fs.readFile(file, "utf8")).toBe(beforeSecondBind);
		await expect(
			registerCodexHandoff(root, {
				work_unit: "invalid-origin",
				thread_id: "thread-invalid",
				endpoint: { kind: "unix", path: "/tmp/codex.sock" },
				origin: { ...origin, delegation_id: 1 },
			}),
		).rejects.toThrow("state_corrupt");
		for (const hostileOrigin of [
			{ ...origin, delegation_id: "a/../b" },
			{ ...origin, workflow: "bogus" },
			{ ...origin, bound_at: "not-a-date" },
			{ ...origin, codex_thread_id: "other-thread" },
		]) {
			await expect(
				bindDelegateCodexHandoff(root, {
					work_unit: `invalid-${hostileOrigin.delegation_id.replaceAll(/[^a-z0-9]/gi, "") || "origin"}`,
					source,
					origin: hostileOrigin,
				}),
			).rejects.toThrow("state_corrupt");
		}

		await fs.writeFile(
			path.join(root, "codex-handoffs", "legacy.json"),
			JSON.stringify({
				schema_version: 1,
				work_unit: "legacy",
				thread_id: "thread-legacy",
				endpoint: { kind: "unix", path: "/tmp/codex.sock" },
				token_file: null,
				registered_at: "2026-07-19T00:00:00.000Z",
				updated_at: "2026-07-19T00:00:00.000Z",
			}),
		);
		expect((await readCodexHandoff(root, "legacy"))?.origin).toBeUndefined();
		await fs.writeFile(
			path.join(root, "codex-handoffs", "corrupt-origin.json"),
			JSON.stringify({
				schema_version: 1,
				work_unit: "corrupt-origin",
				thread_id: "thread-corrupt",
				endpoint: { kind: "unix", path: "/tmp/codex.sock" },
				token_file: null,
				registered_at: "2026-07-19T00:00:00.000Z",
				updated_at: "2026-07-19T00:00:00.000Z",
				origin: { ...origin, delegation_id: 1 },
			}),
		);
		await expect(readCodexHandoff(root, "corrupt-origin")).rejects.toThrow("state_corrupt");
	});
});
