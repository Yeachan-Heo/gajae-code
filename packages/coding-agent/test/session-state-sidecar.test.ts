import { afterEach, describe, expect, it, setSystemTime, spyOn } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { postmortem } from "@gajae-code/utils";
import { sessionRuntimeDir } from "../src/gjc-runtime/session-layout";
import {
	eventAffectsCoordinatorRuntimeState,
	GJC_COORDINATOR_SESSION_BRANCH_ENV,
	GJC_COORDINATOR_SESSION_ID_ENV,
	GJC_COORDINATOR_SESSION_STATE_FILE_ENV,
	persistCoordinatorRuntimeStateFromEvent,
	persistCoordinatorRuntimeStateFromPostmortem,
	readTerminalRuntimeStateMarker,
	stateForEvent,
} from "../src/gjc-runtime/session-state-sidecar";

const tempDirs: string[] = [];

type RuntimePayload = Record<string, unknown>;

async function readPayload(stateFile: string): Promise<RuntimePayload> {
	return JSON.parse(await Bun.file(stateFile).text()) as RuntimePayload;
}

function assistantEnd(text: string, stopReason: "stop" | "error" = "stop") {
	return {
		type: "agent_end",
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text }],
				stopReason,
			},
		],
	};
}

function expectCompactJson(raw: string): RuntimePayload {
	expect(raw).not.toContain("\n  ");
	expect(raw.endsWith("\n")).toBe(true);
	return JSON.parse(raw) as RuntimePayload;
}

const ORIGINAL_STATE_FILE = process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
const ORIGINAL_SESSION_ID = process.env[GJC_COORDINATOR_SESSION_ID_ENV];
const ORIGINAL_BRANCH = process.env[GJC_COORDINATOR_SESSION_BRANCH_ENV];
const PROMPT_ACCEPTED_ENV = "GJC_SESSION_PROMPT_ACCEPTED_JSON";
const BASELINE_DIRTY_ENV = "GJC_SESSION_WORKTREE_BASELINE_DIRTY";
const ORIGINAL_PROMPT_ACCEPTED = process.env[PROMPT_ACCEPTED_ENV];
const ORIGINAL_BASELINE_DIRTY = process.env[BASELINE_DIRTY_ENV];

async function tempRoot(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sidecar-"));
	tempDirs.push(dir);
	return dir;
}

function git(cwd: string, args: string[]): void {
	const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) throw new Error(proc.stderr.toString() || `git ${args.join(" ")} failed`);
}

afterEach(async () => {
	if (ORIGINAL_STATE_FILE === undefined) delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
	else process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = ORIGINAL_STATE_FILE;
	if (ORIGINAL_SESSION_ID === undefined) delete process.env[GJC_COORDINATOR_SESSION_ID_ENV];
	else process.env[GJC_COORDINATOR_SESSION_ID_ENV] = ORIGINAL_SESSION_ID;
	if (ORIGINAL_BRANCH === undefined) delete process.env[GJC_COORDINATOR_SESSION_BRANCH_ENV];
	else process.env[GJC_COORDINATOR_SESSION_BRANCH_ENV] = ORIGINAL_BRANCH;
	if (ORIGINAL_PROMPT_ACCEPTED === undefined) delete process.env[PROMPT_ACCEPTED_ENV];
	else process.env[PROMPT_ACCEPTED_ENV] = ORIGINAL_PROMPT_ACCEPTED;
	if (ORIGINAL_BASELINE_DIRTY === undefined) delete process.env[BASELINE_DIRTY_ENV];
	else process.env[BASELINE_DIRTY_ENV] = ORIGINAL_BASELINE_DIRTY;
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function readJson(file: string): Promise<Record<string, unknown>> {
	return JSON.parse(await Bun.file(file).text()) as Record<string, unknown>;
}

describe("coordinator runtime state sidecar", () => {
	it("reports whether events affect coordinator runtime state", () => {
		const events = [
			{ event: { type: "message_update", message: {}, assistantMessageEvent: {} }, affects: false },
			{ event: { type: "notice", level: "info", message: "background notice" }, affects: false },
			{ event: { type: "turn_start" }, affects: true },
			{ event: { type: "agent_start" }, affects: true },
			{ event: { type: "agent_end", messages: [] }, affects: true },
		] as const;

		for (const { event, affects } of events) {
			expect(eventAffectsCoordinatorRuntimeState(event as never)).toBe(affects);
			expect(eventAffectsCoordinatorRuntimeState(event as never)).toBe(stateForEvent(event as never) !== null);
		}
	});

	it("skips duplicate same-state running writes within the heartbeat", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "heartbeat-session";
		try {
			setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			await persistCoordinatorRuntimeStateFromEvent(
				{ type: "turn_start" },
				{ sessionId: "fallback", cwd: root, sessionFile: null },
			);
			const beforeStat = await fs.stat(stateFile);
			const beforeText = await Bun.file(stateFile).text();

			setSystemTime(new Date("2026-01-01T00:00:00.500Z"));
			await persistCoordinatorRuntimeStateFromEvent(
				{ type: "turn_start" },
				{ sessionId: "fallback", cwd: root, sessionFile: null },
			);

			const afterStat = await fs.stat(stateFile);
			expect(await Bun.file(stateFile).text()).toBe(beforeText);
			expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
		} finally {
			setSystemTime();
		}
	});

	it("refreshes updated_at for duplicate same-state running writes after the heartbeat", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "heartbeat-session";
		try {
			setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			await persistCoordinatorRuntimeStateFromEvent(
				{ type: "turn_start" },
				{ sessionId: "fallback", cwd: root, sessionFile: null },
			);
			const before = await readJson(stateFile);

			setSystemTime(new Date("2026-01-01T00:00:01.100Z"));
			await persistCoordinatorRuntimeStateFromEvent(
				{ type: "turn_start" },
				{ sessionId: "fallback", cwd: root, sessionFile: null },
			);

			const after = await readJson(stateFile);
			expect(after.updated_at).toBe("2026-01-01T00:00:01.100Z");
			expect(after.updated_at).not.toBe(before.updated_at);
			const { updated_at: _afterTs, ...afterRest } = after;
			const { updated_at: _beforeTs, ...beforeRest } = before;
			expect(afterRest).toEqual(beforeRest);
		} finally {
			setSystemTime();
		}
	});

	it("always writes state transitions from running to completed", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "transition-session";
		try {
			setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			await persistCoordinatorRuntimeStateFromEvent(
				{ type: "turn_start" },
				{ sessionId: "fallback", cwd: root, sessionFile: null },
			);

			setSystemTime(new Date("2026-01-01T00:00:00.200Z"));
			await persistCoordinatorRuntimeStateFromEvent(
				{ type: "agent_end", messages: [] },
				{ sessionId: "fallback", cwd: root, sessionFile: null },
			);

			const payload = await readJson(stateFile);
			expect(payload).toMatchObject({
				state: "completed",
				updated_at: "2026-01-01T00:00:00.200Z",
				ended_at: "2026-01-01T00:00:00.200Z",
			});
		} finally {
			setSystemTime();
		}
	});

	it("always writes terminal final_response events", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "terminal-session";
		const event = {
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" }],
		};
		try {
			setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			await persistCoordinatorRuntimeStateFromEvent(event, { sessionId: "fallback", cwd: root, sessionFile: null });

			setSystemTime(new Date("2026-01-01T00:00:00.200Z"));
			await persistCoordinatorRuntimeStateFromEvent(event, { sessionId: "fallback", cwd: root, sessionFile: null });

			const payload = await readJson(stateFile);
			expect(payload).toMatchObject({
				state: "completed",
				updated_at: "2026-01-01T00:00:00.200Z",
				final_response: { text: "Done", source: "agent_end" },
			});
		} finally {
			setSystemTime();
		}
	});

	it("invalidates the async previous-payload cache after an external state file write", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "external-session";
		try {
			setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
			await persistCoordinatorRuntimeStateFromEvent(
				{ type: "turn_start" },
				{ sessionId: "fallback", cwd: root, sessionFile: null },
			);
			const external = {
				schema_version: 1,
				session_id: "external-session",
				state: "running",
				ready_for_input: false,
				updated_at: "2026-01-01T00:00:00.000Z",
				current_turn_id: "external-turn",
				last_turn_id: null,
				live: true,
				reason: null,
				source: "agent_session_event",
				event: "turn_start",
				cwd: root,
				workdir: root,
				branch: null,
				session_file: null,
			};
			await Bun.write(stateFile, `${JSON.stringify(external, null, 2)}\n`);

			setSystemTime(new Date("2026-01-01T00:00:01.100Z"));
			await persistCoordinatorRuntimeStateFromEvent(
				{ type: "turn_start" },
				{ sessionId: "fallback", cwd: root, sessionFile: null },
			);

			const payload = await readJson(stateFile);
			expect(payload.current_turn_id).toBe("external-turn");
			expect(payload.updated_at).toBe("2026-01-01T00:00:01.100Z");
		} finally {
			setSystemTime();
		}
	});
	it("persists final assistant text on agent_end", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "visible-session";

		await persistCoordinatorRuntimeStateFromEvent(
			{
				type: "agent_end",
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "Done from runtime" }],
						stopReason: "stop",
					},
				],
			},
			{ sessionId: "fallback", cwd: root, sessionFile: null },
		);

		const payload = JSON.parse(await Bun.file(stateFile).text());
		expect(payload).toMatchObject({
			session_id: "visible-session",
			state: "completed",
			final_response: {
				text: "Done from runtime",
				format: "markdown",
				source: "agent_end",
				artifact_path: null,
				truncated: false,
			},
		});
	});

	it("does not sync-read on the async event path and preserves cached turn state", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "async-session";
		await Bun.write(
			stateFile,
			JSON.stringify({
				schema_version: 1,
				session_id: "async-session",
				state: "running",
				current_turn_id: "turn-current",
				last_turn_id: "turn-last",
				final_response: { source: "agent_end", text: "previous final" },
			}),
		);
		const readFileSync = spyOn(fsSync, "readFileSync");
		try {
			await persistCoordinatorRuntimeStateFromEvent(
				{ type: "agent_start" },
				{ sessionId: "fallback", cwd: root, sessionFile: null },
			);
			for (let index = 0; index < 3; index++) {
				await persistCoordinatorRuntimeStateFromEvent(
					{ type: "turn_start" },
					{ sessionId: "fallback", cwd: root, sessionFile: null },
				);
			}
			await persistCoordinatorRuntimeStateFromEvent(
				{
					type: "agent_end",
					messages: [
						{
							role: "assistant",
							content: [{ type: "text", text: "Finished from cached chain" }],
							stopReason: "stop",
						},
					],
				},
				{ sessionId: "fallback", cwd: root, sessionFile: null },
			);
		} finally {
			readFileSync.mockRestore();
		}

		expect(readFileSync).toHaveBeenCalledTimes(0);
		const raw = await Bun.file(stateFile).text();
		expect(raw).not.toContain("\n  ");
		const payload = JSON.parse(raw);
		expect(payload).toMatchObject({
			session_id: "async-session",
			state: "completed",
			current_turn_id: "turn-current",
			last_turn_id: "turn-last",
			source: "agent_session_event",
			event: "agent_end",
			ready_for_input: true,
			live: false,
			final_response: { source: "agent_end", text: "Finished from cached chain" },
		});
		expect(typeof payload.ended_at).toBe("string");
	});

	it("G012 ZERO-SYNC-READ keeps async event path hot and preserves terminal chain", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "g012-zero-sync.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "g012-zero-sync";
		await Bun.write(
			stateFile,
			JSON.stringify({
				schema_version: 1,
				session_id: "g012-zero-sync",
				state: "running",
				current_turn_id: "turn-5",
				last_turn_id: "turn-4",
			}),
		);
		const readFileSync = spyOn(fsSync, "readFileSync");
		try {
			await persistCoordinatorRuntimeStateFromEvent(
				{ type: "agent_start" },
				{ sessionId: "fallback", cwd: root, sessionFile: null },
			);
			for (let index = 0; index < 5; index++) {
				await persistCoordinatorRuntimeStateFromEvent(
					{ type: "turn_start" },
					{ sessionId: "fallback", cwd: root, sessionFile: null },
				);
			}
			await persistCoordinatorRuntimeStateFromEvent(assistantEnd("g012 final"), {
				sessionId: "fallback",
				cwd: root,
				sessionFile: null,
			});
		} finally {
			readFileSync.mockRestore();
		}

		expect(readFileSync).toHaveBeenCalledTimes(0);
		const payload = expectCompactJson(await Bun.file(stateFile).text());
		expect(payload).toMatchObject({
			session_id: "g012-zero-sync",
			state: "completed",
			current_turn_id: "turn-5",
			last_turn_id: "turn-4",
			event: "agent_end",
			final_response: { source: "agent_end", text: "g012 final", format: "markdown" },
		});
		expect(typeof payload.ended_at).toBe("string");
	});

	it("COORDINATOR-EXTERNAL-WRITE cold-reads coordinator-owned files instead of stale cache", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "coordinator-external-write.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "coordinator-external-write";
		await Bun.write(
			stateFile,
			JSON.stringify({
				schema_version: 1,
				session_id: "coordinator-external-write",
				state: "running",
				current_turn_id: "turn-A",
				last_turn_id: "turn-before-A",
			}),
		);
		const readFileSync = spyOn(fsSync, "readFileSync");
		try {
			await persistCoordinatorRuntimeStateFromEvent(
				{ type: "agent_start" },
				{ sessionId: "fallback", cwd: root, sessionFile: null },
			);
			await Bun.write(
				stateFile,
				JSON.stringify({
					schema_version: 1,
					session_id: "coordinator-external-write",
					state: "running",
					current_turn_id: "turn-B",
					last_turn_id: "turn-A",
				}),
			);
			await persistCoordinatorRuntimeStateFromEvent(
				{ type: "turn_start" },
				{ sessionId: "fallback", cwd: root, sessionFile: null },
			);
		} finally {
			readFileSync.mockRestore();
		}

		expect(readFileSync).toHaveBeenCalledTimes(0);
		const payload = await readPayload(stateFile);
		expect(payload).toMatchObject({
			session_id: "coordinator-external-write",
			state: "running",
			current_turn_id: "turn-B",
			last_turn_id: "turn-A",
			event: "turn_start",
		});
	});

	it("POSTMORTEM-RACE preserves pending terminal event payload from the in-memory cache", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "postmortem-race.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "postmortem-race";
		await Bun.write(
			stateFile,
			JSON.stringify({
				schema_version: 1,
				session_id: "postmortem-race",
				state: "running",
				current_turn_id: "race-current",
			}),
		);

		let releaseWrite = () => {};
		const writeWait = new Promise<void>(resolveWrite => {
			releaseWrite = resolveWrite;
		});
		let resolveStarted = () => {};
		const writeStartedPromise = new Promise<void>(resolve => {
			resolveStarted = resolve;
		});
		const originalWrite = Bun.write;
		const writeSpy = spyOn(Bun, "write").mockImplementation((async (...args: unknown[]) => {
			resolveStarted();
			await writeWait;
			return (originalWrite as (...writeArgs: unknown[]) => Promise<number>)(...args);
		}) as typeof Bun.write);
		const writeFileSync = spyOn(fsSync, "writeFileSync");
		const persistPromise = persistCoordinatorRuntimeStateFromEvent(assistantEnd("terminal before flush"), {
			sessionId: "fallback",
			cwd: root,
			sessionFile: null,
		});
		try {
			await writeStartedPromise;
			persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.SIGTERM, {
				sessionId: "fallback",
				cwd: root,
				sessionFile: null,
			});
			expect(writeFileSync).toHaveBeenCalledTimes(0);
		} finally {
			writeFileSync.mockRestore();
			releaseWrite();
			await persistPromise;
			writeSpy.mockRestore();
		}

		const payload = await readPayload(stateFile);
		expect(payload).toMatchObject({
			state: "completed",
			source: "agent_session_event",
			current_turn_id: "race-current",
			final_response: { source: "agent_end", text: "terminal before flush" },
		});
	});

	it("G012 COLD-READ-RESTART async event honors existing file without sync reads", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "g012-cold-restart.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "g012-cold-restart";
		await Bun.write(
			stateFile,
			JSON.stringify({
				schema_version: 1,
				session_id: "g012-cold-restart",
				state: "completed",
				current_turn_id: "cold-current",
				last_turn_id: "cold-last",
				ended_at: "2026-07-06T00:00:00.000Z",
				final_response: { source: "agent_end", text: "previous terminal" },
			}),
		);
		const readFileSync = spyOn(fsSync, "readFileSync");
		try {
			await persistCoordinatorRuntimeStateFromEvent(assistantEnd("after restart"), {
				sessionId: "fallback",
				cwd: root,
				sessionFile: null,
			});
		} finally {
			readFileSync.mockRestore();
		}

		expect(readFileSync).toHaveBeenCalledTimes(0);
		const payload = await readPayload(stateFile);
		expect(payload).toMatchObject({
			session_id: "g012-cold-restart",
			state: "completed",
			current_turn_id: "cold-current",
			last_turn_id: "cold-last",
			final_response: { source: "agent_end", text: "after restart" },
		});
	});

	it("G012 CACHE-CONSISTENCY and INTERLEAVE keep file, cached async state, and sync postmortem aligned", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "g012-cache-interleave.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "g012-cache-interleave";
		await Bun.write(
			stateFile,
			JSON.stringify({
				schema_version: 1,
				session_id: "g012-cache-interleave",
				state: "running",
				current_turn_id: "cache-current",
				last_turn_id: "cache-last",
			}),
		);

		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "agent_start" },
			{ sessionId: "fallback", cwd: root, sessionFile: null },
		);
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "turn_start" },
			{ sessionId: "fallback", cwd: root, sessionFile: null },
		);
		const afterAsync = await readPayload(stateFile);
		expect(afterAsync).toMatchObject({
			state: "running",
			current_turn_id: "cache-current",
			last_turn_id: "cache-last",
		});

		const previousExitCode = process.exitCode;
		process.exitCode = 0;
		try {
			persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.EXIT, {
				sessionId: "fallback",
				cwd: root,
				sessionFile: null,
			});
		} finally {
			process.exitCode = previousExitCode;
		}
		const afterPostmortem = await readPayload(stateFile);
		expect(afterPostmortem).toMatchObject({
			state: "errored",
			source: "process_postmortem",
			reason: "process_exit_before_prompt_acceptance",
			current_turn_id: "cache-current",
			last_turn_id: "cache-last",
		});

		await persistCoordinatorRuntimeStateFromEvent(assistantEnd("interleaved final"), {
			sessionId: "fallback",
			cwd: root,
			sessionFile: null,
		});
		const finalPayload = expectCompactJson(await Bun.file(stateFile).text());
		expect(finalPayload).toMatchObject({
			state: "completed",
			event: "agent_end",
			current_turn_id: "cache-current",
			last_turn_id: "cache-last",
			final_response: { source: "agent_end", text: "interleaved final" },
		});
		expect(JSON.parse(JSON.stringify(finalPayload))).toEqual(finalPayload);
	});

	it("G012 TERMINAL-PRESERVATION keeps completed agent_end payload through postmortem", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "g012-terminal-preservation.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "g012-terminal-preservation";
		await persistCoordinatorRuntimeStateFromEvent(assistantEnd("terminal payload"), {
			sessionId: "fallback",
			cwd: root,
			sessionFile: null,
		});
		const terminal = await readPayload(stateFile);

		persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.SIGTERM, {
			sessionId: "fallback",
			cwd: root,
			sessionFile: null,
		});

		const afterPostmortem = await readPayload(stateFile);
		expect(afterPostmortem).toEqual(terminal);
		expect(afterPostmortem).toMatchObject({
			state: "completed",
			source: "agent_session_event",
			final_response: { source: "agent_end", text: "terminal payload" },
		});
	});

	it("G012 COMPACT-PARSE writes compact JSON accepted by terminal marker consumer", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "g012-compact-parse.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "g012-compact-parse";
		await persistCoordinatorRuntimeStateFromEvent(assistantEnd("compact final"), {
			sessionId: "fallback",
			cwd: root,
			sessionFile: path.join(root, "session.jsonl"),
		});

		const raw = await Bun.file(stateFile).text();
		const payload = expectCompactJson(raw);
		expect(payload.final_response).toMatchObject({ text: "compact final" });
		await expect(
			readTerminalRuntimeStateMarker({
				stateFile,
				sessionId: "g012-compact-parse",
				cwd: root,
				sessionFile: path.join(root, "session.jsonl"),
			}),
		).resolves.toEqual({ terminal: true, state: "completed" });
	});

	it("recognizes only matching completed or errored runtime markers as terminal", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "state.json");
		await Bun.write(
			stateFile,
			JSON.stringify({
				schema_version: 1,
				session_id: "session-a",
				state: "completed",
				cwd: root,
				session_file: path.join(root, "session.jsonl"),
			}),
		);

		await expect(
			readTerminalRuntimeStateMarker({
				stateFile,
				sessionId: "session-a",
				cwd: root,
				sessionFile: path.join(root, "session.jsonl"),
			}),
		).resolves.toEqual({ terminal: true, state: "completed" });
		await expect(readTerminalRuntimeStateMarker({ stateFile, sessionId: "other", cwd: root })).resolves.toEqual({
			terminal: false,
			reason: "session_id_mismatch",
		});
	});

	it("rejects non-terminal and mismatched runtime markers", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "state.json");
		await Bun.write(
			stateFile,
			JSON.stringify({
				schema_version: 1,
				session_id: "session-a",
				state: "running",
				cwd: root,
				session_file: path.join(root, "session.jsonl"),
			}),
		);

		await expect(readTerminalRuntimeStateMarker({ stateFile, sessionId: "session-a", cwd: root })).resolves.toEqual({
			terminal: false,
			reason: "non_terminal_state",
		});
		await expect(
			readTerminalRuntimeStateMarker({ stateFile, sessionId: "session-a", cwd: path.join(root, "other") }),
		).resolves.toEqual({ terminal: false, reason: "cwd_mismatch" });
	});

	it("writes public-safe postmortem exit evidence without transcript payloads", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "postmortem-session";
		process.env[GJC_COORDINATOR_SESSION_BRANCH_ENV] = "issue-1496";

		persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.SIGTERM, {
			sessionId: "fallback",
			cwd: root,
			sessionFile: path.join(root, "session.jsonl"),
		});

		const payload = JSON.parse(await Bun.file(stateFile).text());
		expect(payload).toMatchObject({
			schema_version: 1,
			session_id: "postmortem-session",
			state: "errored",
			ready_for_input: false,
			source: "process_postmortem",
			event: "process_exit",
			reason: "sigterm",
			exit_kind: "sigterm",
			signal: "SIGTERM",
			cwd: root,
			workdir: root,
			branch: "issue-1496",
			session_file: path.join(root, "session.jsonl"),
			error: { code: "sigterm", recoverable: true },
		});
		expect(payload).not.toHaveProperty("messages");
		expect(payload).not.toHaveProperty("transcript");
		expect(payload).not.toHaveProperty("paneLog");
	});

	it("marks zero-code post-acceptance process exit as recoverable instead of completed", async () => {
		const root = await tempRoot();
		const workspace = path.join(root, "worktree");
		await fs.mkdir(workspace);
		git(workspace, ["init"]);
		git(workspace, ["config", "user.email", "test@example.com"]);
		git(workspace, ["config", "user.name", "Test User"]);
		await Bun.write(path.join(workspace, "README.md"), "base\n");
		git(workspace, ["add", "README.md"]);
		git(workspace, ["commit", "-m", "init"]);
		await Bun.write(path.join(workspace, "README.md"), "base\nrecoverable dirty change\n");
		const stateFile = path.join(root, "state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "post-acceptance-session";
		const promptAccepted = path.join(root, "prompt-accepted.json");
		await Bun.write(
			promptAccepted,
			JSON.stringify({ evidence: "durable_turn_evidence", worktreeBaselineDirty: false }),
		);
		process.env[PROMPT_ACCEPTED_ENV] = promptAccepted;
		process.env[BASELINE_DIRTY_ENV] = "false";
		await Bun.write(
			stateFile,
			JSON.stringify({
				schema_version: 1,
				session_id: "post-acceptance-session",
				state: "running",
				ready_for_input: false,
				cwd: workspace,
				session_file: path.join(root, "session.jsonl"),
				current_turn_id: "turn-after-prompt-acceptance",
			}),
		);
		const previousExitCode = process.exitCode;
		process.exitCode = 0;
		try {
			persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.EXIT, {
				sessionId: "fallback",
				cwd: workspace,
				sessionFile: path.join(root, "session.jsonl"),
			});
		} finally {
			process.exitCode = previousExitCode;
		}

		const payload = JSON.parse(await Bun.file(stateFile).text());
		expect(payload).toMatchObject({
			schema_version: 1,
			session_id: "post-acceptance-session",
			state: "errored",
			ready_for_input: false,
			source: "process_postmortem",
			reason: "accepted_prompt_observed_recoverable_worktree_changes",
			exit_code: 0,
			previous_runtime_state: "running",
			error: { code: "accepted_prompt_observed_recoverable_worktree_changes", recoverable: true },
			recovery: { action: "recover_or_resume_session" },
			prompt_accepted: true,
			observed_recoverable_worktree_changes: true,
			worktree_baseline_dirty: false,
			worktree_changed_since_baseline: true,
		});
		expect(await Bun.file(path.join(workspace, "README.md")).text()).toContain("recoverable dirty change");
		expect(payload).not.toHaveProperty("messages");
		expect(payload).not.toHaveProperty("transcript");
		expect(payload).not.toHaveProperty("paneLog");
	});

	it("classifies accepted clean worktree exit as no useful output", async () => {
		const root = await tempRoot();
		const workspace = path.join(root, "worktree");
		await fs.mkdir(workspace);
		git(workspace, ["init"]);
		git(workspace, ["config", "user.email", "test@example.com"]);
		git(workspace, ["config", "user.name", "Test User"]);
		await Bun.write(path.join(workspace, "README.md"), "base\n");
		git(workspace, ["add", "README.md"]);
		git(workspace, ["commit", "-m", "init"]);
		const stateFile = path.join(root, "state.json");
		const promptAccepted = path.join(root, "prompt-accepted.json");
		await Bun.write(
			promptAccepted,
			JSON.stringify({ evidence: "durable_turn_evidence", worktreeBaselineDirty: false }),
		);
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "no-output-session";
		process.env[PROMPT_ACCEPTED_ENV] = promptAccepted;
		process.env[BASELINE_DIRTY_ENV] = "false";
		await Bun.write(
			stateFile,
			JSON.stringify({ schema_version: 1, session_id: "no-output-session", state: "running", cwd: workspace }),
		);
		const previousExitCode = process.exitCode;
		process.exitCode = 0;
		try {
			persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.EXIT, {
				sessionId: "fallback",
				cwd: workspace,
				sessionFile: null,
			});
		} finally {
			process.exitCode = previousExitCode;
		}

		const payload = JSON.parse(await Bun.file(stateFile).text());
		expect(payload).toMatchObject({
			state: "errored",
			reason: "accepted_prompt_no_useful_output",
			error: { code: "accepted_prompt_no_useful_output", recoverable: true },
			prompt_accepted: true,
			observed_recoverable_worktree_changes: false,
			worktree_baseline_dirty: false,
			worktree_changed_since_baseline: false,
		});
		expect(JSON.stringify(payload)).not.toContain("base\\n");
		expect(payload).not.toHaveProperty("messages");
		expect(payload).not.toHaveProperty("transcript");
		expect(payload).not.toHaveProperty("paneLog");
	});

	it("does not overclaim pre-existing dirty worktree as new recoverable work", async () => {
		const root = await tempRoot();
		const workspace = path.join(root, "worktree");
		await fs.mkdir(workspace);
		git(workspace, ["init"]);
		git(workspace, ["config", "user.email", "test@example.com"]);
		git(workspace, ["config", "user.name", "Test User"]);
		await Bun.write(path.join(workspace, "README.md"), "base\n");
		git(workspace, ["add", "README.md"]);
		git(workspace, ["commit", "-m", "init"]);
		await Bun.write(path.join(workspace, "README.md"), "base\npreexisting private filename should not appear\n");
		const stateFile = path.join(root, "state.json");
		const promptAccepted = path.join(root, "prompt-accepted.json");
		await Bun.write(
			promptAccepted,
			JSON.stringify({ evidence: "durable_turn_evidence", worktreeBaselineDirty: true }),
		);
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "preexisting-dirty-session";
		process.env[PROMPT_ACCEPTED_ENV] = promptAccepted;
		process.env[BASELINE_DIRTY_ENV] = "false";
		await Bun.write(
			stateFile,
			JSON.stringify({
				schema_version: 1,
				session_id: "preexisting-dirty-session",
				state: "running",
				cwd: workspace,
			}),
		);
		const previousExitCode = process.exitCode;
		process.exitCode = 0;
		try {
			persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.EXIT, {
				sessionId: "fallback",
				cwd: workspace,
				sessionFile: null,
			});
		} finally {
			process.exitCode = previousExitCode;
		}

		const payload = JSON.parse(await Bun.file(stateFile).text());
		expect(payload).toMatchObject({
			state: "errored",
			reason: "accepted_prompt_dirty_worktree_observed_without_new_change_proof",
			error: { code: "accepted_prompt_dirty_worktree_observed_without_new_change_proof", recoverable: true },
			prompt_accepted: true,
			observed_recoverable_worktree_changes: true,
			worktree_baseline_dirty: true,
			worktree_changed_since_baseline: false,
		});
		expect(JSON.stringify(payload)).not.toContain("preexisting private");
		expect(payload.reason).not.toContain("partial");
		expect(payload).not.toHaveProperty("messages");
		expect(payload).not.toHaveProperty("transcript");
		expect(payload).not.toHaveProperty("paneLog");
	});

	it("persists raw session runtime state without coordinator env", async () => {
		const root = await tempRoot();
		delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
		delete process.env[GJC_COORDINATOR_SESSION_ID_ENV];
		const sessionId = "raw-tmux-session";
		const stateFile = path.join(sessionRuntimeDir(root, sessionId), "runtime-state.json");

		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "turn_start" },
			{ sessionId, cwd: root, sessionFile: null },
		);
		const running = JSON.parse(await Bun.file(stateFile).text());
		expect(running).toMatchObject({
			session_id: sessionId,
			state: "running",
			source: "agent_session_event",
			event: "turn_start",
		});

		const previousExitCode = process.exitCode;
		process.exitCode = 0;
		try {
			persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.EXIT, {
				sessionId,
				cwd: root,
				sessionFile: null,
			});
		} finally {
			process.exitCode = previousExitCode;
		}

		const payload = JSON.parse(await Bun.file(stateFile).text());
		expect(payload).toMatchObject({
			session_id: sessionId,
			state: "errored",
			source: "process_postmortem",
			reason: "process_exit_before_prompt_acceptance",
			exit_code: 0,
			previous_runtime_state: "running",
			error: { code: "process_exit_before_prompt_acceptance", recoverable: true },
		});
		expect(payload).not.toHaveProperty("messages");
		expect(payload).not.toHaveProperty("transcript");
		expect(payload).not.toHaveProperty("paneLog");
	});

	it("overwrites mismatched terminal payloads instead of preserving stale evidence", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "state.json");
		const promptAccepted = path.join(root, "prompt-accepted.json");
		await Bun.write(
			promptAccepted,
			JSON.stringify({ evidence: "durable_turn_evidence", worktreeBaselineDirty: false }),
		);
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "current-session";
		process.env[PROMPT_ACCEPTED_ENV] = promptAccepted;
		await Bun.write(
			stateFile,
			JSON.stringify({
				schema_version: 1,
				session_id: "stale-session",
				state: "completed",
				cwd: root,
				final_response: { source: "agent_end", text: "Stale done" },
			}),
		);
		const previousExitCode = process.exitCode;
		process.exitCode = 0;
		try {
			persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.EXIT, {
				sessionId: "fallback",
				cwd: root,
				sessionFile: null,
			});
		} finally {
			process.exitCode = previousExitCode;
		}

		const payload = JSON.parse(await Bun.file(stateFile).text());
		expect(payload).toMatchObject({
			session_id: "current-session",
			state: "errored",
			source: "process_postmortem",
			reason: "accepted_prompt_no_useful_output",
			error: { code: "accepted_prompt_no_useful_output", recoverable: true },
		});
		expect(payload.final_response?.text).not.toBe("Stale done");
	});

	it("overwrites terminal payloads with mismatched cwd or session file", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "current-session";
		for (const stale of [
			{ cwd: path.join(root, "other"), session_file: path.join(root, "session.jsonl") },
			{ cwd: root, session_file: path.join(root, "other-session.jsonl") },
		]) {
			await Bun.write(
				stateFile,
				JSON.stringify({
					schema_version: 1,
					session_id: "current-session",
					state: "errored",
					...stale,
					final_response: { source: "launch_error", text: "Stale launch" },
				}),
			);
			persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.SIGTERM, {
				sessionId: "fallback",
				cwd: root,
				sessionFile: path.join(root, "session.jsonl"),
			});
			const payload = JSON.parse(await Bun.file(stateFile).text());
			expect(payload).toMatchObject({
				session_id: "current-session",
				state: "errored",
				source: "process_postmortem",
				reason: "sigterm",
			});
			expect(payload.final_response?.text).not.toBe("Stale launch");
		}
	});

	it("does not overwrite richer terminal agent_end evidence during postmortem", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "preserved-session";
		await Bun.write(
			stateFile,
			JSON.stringify({
				schema_version: 1,
				session_id: "preserved-session",
				state: "completed",
				final_response: { source: "agent_end", text: "Already done" },
			}),
		);

		persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.SIGTERM, {
			sessionId: "fallback",
			cwd: root,
			sessionFile: null,
		});

		const payload = JSON.parse(await Bun.file(stateFile).text());
		expect(payload).toMatchObject({
			state: "completed",
			final_response: { source: "agent_end", text: "Already done" },
		});
		expect(payload.source).not.toBe("process_postmortem");
	});

	it("does not overwrite richer terminal launch_error evidence during postmortem", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "launch-error-session";
		await Bun.write(
			stateFile,
			JSON.stringify({
				schema_version: 1,
				session_id: "launch-error-session",
				state: "errored",
				final_response: { source: "launch_error", text: "Launch failed" },
			}),
		);

		persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.EXIT, {
			sessionId: "fallback",
			cwd: root,
			sessionFile: null,
		});

		const payload = JSON.parse(await Bun.file(stateFile).text());
		expect(payload).toMatchObject({
			state: "errored",
			final_response: { source: "launch_error", text: "Launch failed" },
		});
		expect(payload.source).not.toBe("process_postmortem");
	});
});
