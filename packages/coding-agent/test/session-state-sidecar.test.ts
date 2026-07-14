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
	GJC_COORDINATOR_SESSION_LAUNCH_ID_ENV,
	GJC_COORDINATOR_SESSION_READINESS_FILE_ENV,
	GJC_COORDINATOR_SESSION_STATE_FILE_ENV,
	GJC_TMUX_OWNER_GENERATION_ENV,
	GJC_TMUX_OWNER_SERVER_KEY_ENV,
	GJC_TMUX_OWNER_STATE_DIR_ENV,
	ownerTerminalContextFromEnvironment,
	persistCoordinatorRuntimeInputReady,
	persistCoordinatorRuntimeStateFromEvent,
	persistCoordinatorRuntimeStateFromPostmortem,
	readTerminalRuntimeStateMarker,
	stateForEvent,
} from "../src/gjc-runtime/session-state-sidecar";
import {
	createOwnerIntent,
	lifecyclePaths,
	observeOwnerTerminal,
	replaceOwnerGeneration,
} from "../src/gjc-runtime/tmux-owner-isolation";

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
const ORIGINAL_LAUNCH_ID = process.env[GJC_COORDINATOR_SESSION_LAUNCH_ID_ENV];
const ORIGINAL_READINESS_FILE = process.env[GJC_COORDINATOR_SESSION_READINESS_FILE_ENV];
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
	if (ORIGINAL_LAUNCH_ID === undefined) delete process.env[GJC_COORDINATOR_SESSION_LAUNCH_ID_ENV];
	else process.env[GJC_COORDINATOR_SESSION_LAUNCH_ID_ENV] = ORIGINAL_LAUNCH_ID;
	if (ORIGINAL_READINESS_FILE === undefined) delete process.env[GJC_COORDINATOR_SESSION_READINESS_FILE_ENV];
	else process.env[GJC_COORDINATOR_SESSION_READINESS_FILE_ENV] = ORIGINAL_READINESS_FILE;
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
	it("adds managed owner generation to normal terminal event markers", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "state.json");
		const generation = "2b3847de-1cbb-480d-8cad-1f8aa51b891a";
		const keys = [
			GJC_TMUX_OWNER_GENERATION_ENV,
			GJC_TMUX_OWNER_STATE_DIR_ENV,
			GJC_TMUX_OWNER_SERVER_KEY_ENV,
		] as const;
		const previous = new Map(keys.map(key => [key, process.env[key]]));
		try {
			process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
			process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "managed-terminal-session";
			process.env[GJC_TMUX_OWNER_GENERATION_ENV] = generation;
			process.env[GJC_TMUX_OWNER_STATE_DIR_ENV] = root;
			process.env[GJC_TMUX_OWNER_SERVER_KEY_ENV] = "managed-socket";
			await persistCoordinatorRuntimeStateFromEvent(assistantEnd("launch failed", "error"), {
				sessionId: "fallback",
				cwd: root,
				sessionFile: null,
			});
			expect(await readJson(stateFile)).toMatchObject({
				state: "errored",
				owner_generation: generation,
				final_response: { source: "agent_end" },
			});
		} finally {
			for (const key of keys) {
				const value = previous.get(key);
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
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
	it("treats an absent runtime-state marker as empty state", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "missing-state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "missing-state";

		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "turn_start" },
			{ sessionId: "fallback", cwd: root, sessionFile: null },
		);

		expect(await readPayload(stateFile)).toMatchObject({ session_id: "missing-state", state: "running" });
	});

	it("preserves malformed runtime-state evidence and refuses event and postmortem writes", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "malformed-state.json");
		const evidence = "{ malformed terminal evidence\n";
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "malformed-state";
		await Bun.write(stateFile, evidence);

		await expect(
			persistCoordinatorRuntimeStateFromEvent(
				{ type: "agent_end", messages: [] },
				{ sessionId: "fallback", cwd: root, sessionFile: null },
			),
		).rejects.toThrow("Existing runtime state marker is invalid or unreadable; refusing to overwrite.");
		expect(await Bun.file(stateFile).text()).toBe(evidence);

		await expect(
			persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.SIGTERM, {
				sessionId: "fallback",
				cwd: root,
				sessionFile: null,
			}),
		).rejects.toThrow("Existing runtime state marker is invalid or unreadable; refusing to overwrite.");
		expect(await Bun.file(stateFile).text()).toBe(evidence);
	});

	it("preserves directory runtime-state evidence and refuses event and postmortem writes", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "unreadable-state");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "directory-state";
		await fs.mkdir(stateFile);

		await expect(
			persistCoordinatorRuntimeStateFromEvent(
				{ type: "turn_start" },
				{ sessionId: "fallback", cwd: root, sessionFile: null },
			),
		).rejects.toThrow("Existing runtime state marker is invalid or unreadable; refusing to overwrite.");
		expect((await fs.stat(stateFile)).isDirectory()).toBe(true);

		await expect(
			persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.SIGTERM, {
				sessionId: "fallback",
				cwd: root,
				sessionFile: null,
			}),
		).rejects.toThrow("Existing runtime state marker is invalid or unreadable; refusing to overwrite.");
		expect((await fs.stat(stateFile)).isDirectory()).toBe(true);
	});

	it("preserves unreadable runtime-state evidence and refuses event and postmortem writes", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "permission-denied-state.json");
		const evidence = JSON.stringify({ state: "completed", terminal: "durable" });
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "permission-denied-state";
		await Bun.write(stateFile, evidence);
		const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
		const stat = spyOn(fs, "stat").mockRejectedValue(denied);
		try {
			await expect(
				persistCoordinatorRuntimeStateFromEvent(
					{ type: "turn_start" },
					{ sessionId: "fallback", cwd: root, sessionFile: null },
				),
			).rejects.toThrow("Existing runtime state marker is invalid or unreadable; refusing to overwrite.");
		} finally {
			stat.mockRestore();
		}
		expect(await Bun.file(stateFile).text()).toBe(evidence);

		const readFileSync = spyOn(fsSync, "readFileSync").mockImplementation(() => {
			throw denied;
		});
		try {
			await expect(
				persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.SIGTERM, {
					sessionId: "fallback",
					cwd: root,
					sessionFile: null,
				}),
			).rejects.toThrow("Existing runtime state marker is invalid or unreadable; refusing to overwrite.");
		} finally {
			readFileSync.mockRestore();
		}
		expect(await Bun.file(stateFile).text()).toBe(evidence);
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
				cwd: root,
				workdir: root,
				session_file: null,
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
				cwd: root,
				workdir: root,
				session_file: null,
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
				cwd: root,
				workdir: root,
				session_file: null,
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
					cwd: root,
					workdir: root,
					session_file: null,
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
				cwd: root,
				workdir: root,
				session_file: null,
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
		const postmortemPromise = (async () => {
			await writeStartedPromise;
			return persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.SIGTERM, {
				sessionId: "fallback",
				cwd: root,
				sessionFile: null,
			});
		})();
		try {
			await writeStartedPromise;
			expect(writeFileSync).toHaveBeenCalledTimes(0);
		} finally {
			writeFileSync.mockRestore();
			releaseWrite();
			await persistPromise;
			await postmortemPromise;
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
				cwd: root,
				workdir: root,
				session_file: null,
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
				cwd: root,
				workdir: root,
				session_file: null,
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
			await persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.EXIT, {
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

		await persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.SIGTERM, {
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
				workdir: root,
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
	it("accepts case-equivalent Windows runtime-state paths", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "windows-state.json");
		await Bun.write(
			stateFile,
			JSON.stringify({
				schema_version: 1,
				session_id: "windows-session",
				state: "completed",
				cwd: "C:\\Users\\Operator\\Repo",
				workdir: "C:\\Users\\Operator\\Repo\\.\\",
				session_file: "C:\\Users\\Operator\\Repo\\.gjc\\session.jsonl",
			}),
		);

		await expect(
			readTerminalRuntimeStateMarker({
				stateFile,
				sessionId: "windows-session",
				cwd: "c:\\users\\operator\\repo",
				sessionFile: "c:\\users\\operator\\repo\\.gjc\\session.jsonl",
				platform: "win32",
			}),
		).resolves.toEqual({ terminal: true, state: "completed" });
		await expect(
			readTerminalRuntimeStateMarker({
				stateFile,
				sessionId: "windows-session",
				cwd: "D:\\Users\\Operator\\Repo",
				sessionFile: "c:\\users\\operator\\repo\\.gjc\\session.jsonl",
				platform: "win32",
			}),
		).resolves.toEqual({ terminal: false, reason: "cwd_mismatch" });
	});
	it("writes and preserves Windows case- and dot-equivalent runtime identities without accepting another drive", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "windows-runtime-state.json");
		const sessionId = "windows-runtime-identity";
		const initialContext = {
			sessionId: "fallback",
			cwd: "C:\\Users\\Operator\\Repo",
			sessionFile: "C:\\Users\\Operator\\Repo\\.gjc\\session.jsonl",
			platform: "win32" as const,
		};
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = sessionId;

		await persistCoordinatorRuntimeStateFromEvent({ type: "agent_start" }, initialContext);
		await persistCoordinatorRuntimeStateFromEvent(assistantEnd("Windows terminal"), {
			...initialContext,
			cwd: "c:\\USERS\\OPERATOR\\REPO\\.\\",
			sessionFile: "c:\\USERS\\OPERATOR\\REPO\\.gjc\\.\\session.jsonl",
		});
		const terminal = await readPayload(stateFile);
		expect(terminal).toMatchObject({
			session_id: sessionId,
			state: "completed",
			cwd: "c:\\USERS\\OPERATOR\\REPO",
			workdir: "c:\\USERS\\OPERATOR\\REPO",
			session_file: "c:\\USERS\\OPERATOR\\REPO\\.gjc\\session.jsonl",
			final_response: { source: "agent_end", text: "Windows terminal" },
		});

		await persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.SIGTERM, initialContext);
		expect(await readPayload(stateFile)).toEqual(terminal);

		const beforeRejectedWrite = await Bun.file(stateFile).text();
		await expect(
			persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.SIGTERM, {
				...initialContext,
				cwd: "D:\\Users\\Operator\\Repo",
				sessionFile: "D:\\Users\\Operator\\Repo\\.gjc\\session.jsonl",
			}),
		).rejects.toThrow("invalid or unreadable");
		expect(await Bun.file(stateFile).text()).toBe(beforeRejectedWrite);
	});
	it("rejects case-different POSIX runtime-state identities", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "posix-runtime-state.json");
		const sessionId = "posix-runtime-identity";
		const cwd = path.join(root, "workspace");
		const sessionFile = path.join(cwd, "session.jsonl");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = sessionId;

		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "agent_start" },
			{ sessionId: "fallback", cwd, sessionFile },
		);
		const beforeRejectedWrite = await Bun.file(stateFile).text();
		await expect(
			persistCoordinatorRuntimeStateFromEvent(
				{ type: "turn_start" },
				{
					sessionId: "fallback",
					cwd: path.join(root, "WORKSPACE"),
					sessionFile: path.join(root, "WORKSPACE", "session.jsonl"),
				},
			),
		).rejects.toThrow("invalid or unreadable");
		expect(await Bun.file(stateFile).text()).toBe(beforeRejectedWrite);
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
				workdir: root,
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
		).resolves.toEqual({
			terminal: false,
			reason: "non_terminal_state",
		});
		await expect(
			readTerminalRuntimeStateMarker({
				stateFile,
				sessionId: "session-a",
				cwd: path.join(root, "other"),
				sessionFile: path.join(root, "session.jsonl"),
			}),
		).resolves.toEqual({ terminal: false, reason: "cwd_mismatch" });
	});
	it("treats every parseable non-marker shape as semantic corruption before terminal dereference", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "invalid-terminal-marker.json");
		for (const value of [
			null,
			[],
			"terminal",
			{ schema_version: 1 },
			{ schema_version: 2, session_id: "session-a", state: "completed", cwd: root },
		]) {
			await Bun.write(stateFile, JSON.stringify(value));
			await expect(
				readTerminalRuntimeStateMarker({ stateFile, sessionId: "session-a", cwd: root }),
			).resolves.toEqual({
				terminal: false,
				reason: "invalid_state_marker",
			});
		}
	});

	it("writes public-safe postmortem exit evidence without transcript payloads", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "postmortem-session";
		process.env[GJC_COORDINATOR_SESSION_BRANCH_ENV] = "issue-1496";

		await persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.SIGTERM, {
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
				workdir: workspace,
				session_file: path.join(root, "session.jsonl"),
				current_turn_id: "turn-after-prompt-acceptance",
			}),
		);
		const previousExitCode = process.exitCode;
		process.exitCode = 0;
		try {
			await persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.EXIT, {
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
			JSON.stringify({
				schema_version: 1,
				session_id: "no-output-session",
				state: "running",
				cwd: workspace,
				workdir: workspace,
				session_file: null,
			}),
		);
		const previousExitCode = process.exitCode;
		process.exitCode = 0;
		try {
			await persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.EXIT, {
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
				workdir: workspace,
				session_file: null,
			}),
		);
		const previousExitCode = process.exitCode;
		process.exitCode = 0;
		try {
			await persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.EXIT, {
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
			await persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.EXIT, {
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

	it("refuses mismatched terminal session identity without replacing evidence", async () => {
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
				workdir: root,
				session_file: null,
				final_response: { source: "agent_end", text: "Stale done" },
			}),
		);
		const before = await Bun.file(stateFile).text();
		const previousExitCode = process.exitCode;
		process.exitCode = 0;
		try {
			await expect(
				persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.EXIT, {
					sessionId: "fallback",
					cwd: root,
					sessionFile: null,
				}),
			).rejects.toThrow("invalid or unreadable");
		} finally {
			process.exitCode = previousExitCode;
		}
		expect(await Bun.file(stateFile).text()).toBe(before);
	});

	it("refuses terminal payloads with mismatched cwd or session file", async () => {
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
					workdir: stale.cwd,
					final_response: { source: "launch_error", text: "Stale launch" },
				}),
			);
			const before = await Bun.file(stateFile).text();
			await expect(
				persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.SIGTERM, {
					sessionId: "fallback",
					cwd: root,
					sessionFile: path.join(root, "session.jsonl"),
				}),
			).rejects.toThrow("invalid or unreadable");
			expect(await Bun.file(stateFile).text()).toBe(before);
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
				cwd: root,
				workdir: root,
				session_file: null,
				final_response: { source: "agent_end", text: "Already done" },
			}),
		);

		await persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.SIGTERM, {
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
				cwd: root,
				workdir: root,
				session_file: null,
				final_response: { source: "launch_error", text: "Launch failed" },
			}),
		);

		await persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.EXIT, {
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
	it("derives only complete valid managed owner provenance and fails closed otherwise", () => {
		const keys = [
			GJC_TMUX_OWNER_GENERATION_ENV,
			GJC_TMUX_OWNER_STATE_DIR_ENV,
			GJC_TMUX_OWNER_SERVER_KEY_ENV,
			"GJC_TMUX_LAUNCHED",
		] as const;
		const previous = new Map(keys.map(key => [key, process.env[key]]));
		try {
			process.env.GJC_TMUX_LAUNCHED = "1";
			process.env[GJC_TMUX_OWNER_GENERATION_ENV] = "2b3847de-1cbb-480d-8cad-1f8aa51b891a";
			process.env[GJC_TMUX_OWNER_STATE_DIR_ENV] = "/tmp/gjc-owner-lifecycle";
			process.env[GJC_TMUX_OWNER_SERVER_KEY_ENV] = "tmux";
			expect(ownerTerminalContextFromEnvironment()).toEqual({
				generation: "2b3847de-1cbb-480d-8cad-1f8aa51b891a",
				stateDir: "/tmp/gjc-owner-lifecycle",
				socketKey: "tmux",
			});
			for (const invalid of [
				{ generation: "not-a-uuid", stateDir: "/tmp/gjc-owner-lifecycle", socketKey: "tmux" },
				{ generation: "2b3847de-1cbb-480d-8cad-1f8aa51b891a", stateDir: "relative", socketKey: "tmux" },
				{ generation: "   ", stateDir: "/tmp/gjc-owner-lifecycle", socketKey: "tmux" },
				{
					generation: "2b3847de-1cbb-480d-8cad-1f8aa51b891a",
					stateDir: "/tmp/gjc-owner-lifecycle",
					socketKey: "tmux\ncontrol",
				},
			]) {
				process.env[GJC_TMUX_OWNER_GENERATION_ENV] = invalid.generation;
				process.env[GJC_TMUX_OWNER_STATE_DIR_ENV] = invalid.stateDir;
				process.env[GJC_TMUX_OWNER_SERVER_KEY_ENV] = invalid.socketKey;
				expect(ownerTerminalContextFromEnvironment()).toBe("invalid");
			}
			process.env[GJC_TMUX_OWNER_GENERATION_ENV] = "2b3847de-1cbb-480d-8cad-1f8aa51b891a";
			process.env[GJC_TMUX_OWNER_STATE_DIR_ENV] = "/tmp/gjc-owner-lifecycle";
			delete process.env[GJC_TMUX_OWNER_SERVER_KEY_ENV];
			expect(ownerTerminalContextFromEnvironment()).toBe("invalid");
			delete process.env[GJC_TMUX_OWNER_GENERATION_ENV];
			delete process.env[GJC_TMUX_OWNER_STATE_DIR_ENV];
			expect(ownerTerminalContextFromEnvironment()).toBe(process.platform === "linux" ? "invalid" : null);
			delete process.env.GJC_TMUX_LAUNCHED;
			process.env[GJC_TMUX_OWNER_GENERATION_ENV] = "2b3847de-1cbb-480d-8cad-1f8aa51b891a";
			expect(ownerTerminalContextFromEnvironment()).toBe("invalid");
			delete process.env[GJC_TMUX_OWNER_GENERATION_ENV];
			expect(ownerTerminalContextFromEnvironment()).toBeNull();
		} finally {
			for (const key of keys) {
				const value = previous.get(key);
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("persists the immutable owner-terminal verdict with public-safe metadata", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "state.json");
		const sessionId = "owner-sidecar-session";
		const generation = await replaceOwnerGeneration(root, sessionId, "generation-one");
		await createOwnerIntent(root, {
			generation,
			session_id: sessionId,
			server_key: "opaque-server-key",
			expected_terminal: { signal: "SIGTERM", result: "owner_term_then_session_cleanup" },
			dispatch_id: "operator-dispatch",
			created_at: "2026-01-01T00:00:00.000Z",
			expires_at: "2099-01-01T00:00:00.000Z",
		});
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = sessionId;
		await Bun.write(
			stateFile,
			JSON.stringify({
				schema_version: 1,
				session_id: sessionId,
				state: "running",
				cwd: root,
				workdir: root,
				session_file: null,
			}),
		);

		await persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.SIGTERM, {
			sessionId,
			cwd: root,
			ownerTerminal: {
				generation,
				stateDir: root,
				socketKey: "opaque-server-key",
				scope: "gjc-owner.scope",
				ownerPid: 123,
				ownerName: "tmux",
			},
		});
		const rawVerdict = await observeOwnerTerminal({
			schema_version: 1,
			op: "observe_terminal",
			session_id: sessionId,
			owner_generation: generation,
			state_dir: root,
			socket_key: "opaque-server-key",
			observer: "raw_monitor",
			observed_at: new Date().toISOString(),
			signal: "SIGTERM",
			exit_code: null,
			exit_kind: "sigterm",
			reason: "raw_terminal",
		});
		expect(rawVerdict.classification).toBe("expected_operator_shutdown");
		expect(rawVerdict.observer).toBe("sidecar");
		let payload: RuntimePayload | null = null;
		for (let attempt = 0; attempt < 20; attempt++) {
			try {
				await fs.access(stateFile);
			} catch {
				await Bun.sleep(5);
				continue;
			}
			const candidate = await readPayload(stateFile);
			if (candidate.owner_terminal) {
				payload = candidate;
				break;
			}
			await Bun.sleep(5);
		}
		expect(payload).not.toBeNull();
		expect(payload?.owner_terminal).toMatchObject({
			generation,
			socket_key: "opaque-server-key",
			observer: "sidecar",
			classification: rawVerdict.classification,
			dedupe_key: rawVerdict.dedupe_key,
		});
		expect(payload?.state).toBe(rawVerdict.classification === "expected_operator_shutdown" ? "completed" : "errored");
		const serialized = JSON.stringify(payload);
		expect(serialized).not.toContain("raw_terminal");
		expect(serialized).not.toContain("operator-dispatch");
		await expect(fs.access(lifecyclePaths(root, sessionId, generation).verdictFile)).resolves.toBeNull();
	});
	it("fails closed with public-safe recovery state for invalid metadata or unavailable owner verdicts", async () => {
		const root = await tempRoot();
		const sessionId = "owner-fail-closed";
		const invalidStateFile = path.join(root, "invalid.json");
		await persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.SIGTERM, {
			sessionId,
			cwd: root,
			ownerTerminalMetadataInvalid: true,
			branch: null,
		});
		const invalid = await readPayload(path.join(sessionRuntimeDir(root, sessionId), "runtime-state.json"));
		expect(invalid).toMatchObject({
			state: "errored",
			reason: "owner_metadata_invalid",
			error: { code: "owner_metadata_invalid", recoverable: true },
			recovery: { action: "recover_or_resume_session" },
		});

		await Bun.write(invalidStateFile, "not-a-directory");
		const unavailableSessionId = "owner-verdict-unavailable";
		await persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.SIGTERM, {
			sessionId: unavailableSessionId,
			cwd: root,
			ownerTerminal: { generation: "owner-failure", stateDir: invalidStateFile, socketKey: "opaque-owner" },
		});
		const unavailable = await readPayload(
			path.join(sessionRuntimeDir(root, unavailableSessionId), "runtime-state.json"),
		);
		expect(unavailable).toMatchObject({
			state: "errored",
			reason: "owner_verdict_unavailable",
			error: { code: "owner_verdict_unavailable", recoverable: true },
			recovery: { action: "recover_or_resume_session" },
		});
		expect(JSON.stringify(unavailable)).not.toContain("not-a-directory");
	});

	it("fails closed for absent, malformed, mismatched, and expired owner intents", async () => {
		const root = await tempRoot();
		for (const kind of ["absent", "malformed", "mismatched", "expired"] as const) {
			const sessionId = `owner-intent-${kind}`;
			const generation = await replaceOwnerGeneration(root, sessionId, `generation-${kind}`);
			const paths = lifecyclePaths(root, sessionId, generation);
			if (kind === "malformed") await Bun.write(paths.intentFile, "{");
			if (kind === "mismatched") {
				await createOwnerIntent(root, {
					generation,
					session_id: sessionId,
					server_key: "other-owner",
					expected_terminal: { signal: "SIGTERM", result: "owner_term_then_session_cleanup" },
					dispatch_id: "dispatch",
					created_at: "2026-01-01T00:00:00.000Z",
					expires_at: "2099-01-01T00:00:00.000Z",
				});
			}
			if (kind === "expired")
				await Bun.write(
					paths.intentFile,
					JSON.stringify({
						schema_version: 1,
						intent_id: "expired-intent",
						generation,
						session_id: sessionId,
						server_key: "opaque-owner",
						expected_terminal: { signal: "SIGTERM", result: "owner_term_then_session_cleanup" },
						dispatch_id: "dispatch",
						created_at: "2019-01-01T00:00:00.000Z",
						expires_at: "2020-01-01T00:00:00.000Z",
						state: "pending",
					}),
				);
			const stateFile = path.join(root, `${kind}.json`);
			process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
			process.env[GJC_COORDINATOR_SESSION_ID_ENV] = sessionId;
			await persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.SIGTERM, {
				sessionId,
				cwd: root,
				ownerTerminal: { generation, stateDir: root, socketKey: "opaque-owner" },
			});
			const payload = await readPayload(stateFile);
			expect(payload).toMatchObject({
				owner_generation: generation,
				state: "errored",
				reason: "unexpected_owner_loss",
				error: { code: "unexpected_owner_loss", recoverable: true },
				recovery: { action: "recover_or_resume_session" },
			});
		}
	});

	it("reuses one immutable owner verdict when raw observation wins the race", async () => {
		const root = await tempRoot();
		const sessionId = "raw-first-owner";
		const generation = await replaceOwnerGeneration(root, sessionId, "raw-first-generation");
		await createOwnerIntent(root, {
			generation,
			session_id: sessionId,
			server_key: "opaque-owner",
			expected_terminal: { signal: "SIGTERM", result: "owner_term_then_session_cleanup" },
			dispatch_id: "dispatch",
			created_at: "2026-01-01T00:00:00.000Z",
			expires_at: "2099-01-01T00:00:00.000Z",
		});
		const raw = await observeOwnerTerminal({
			schema_version: 1,
			op: "observe_terminal",
			session_id: sessionId,
			owner_generation: generation,
			state_dir: root,
			socket_key: "opaque-owner",
			observer: "raw_monitor",
			observed_at: new Date().toISOString(),
			signal: "SIGTERM",
			exit_code: null,
			exit_kind: "sigterm",
			reason: "raw_terminal",
			operator_dispatch_id: "dispatch",
		});
		const stateFile = path.join(root, "raw-first.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = sessionId;
		await persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.SIGTERM, {
			sessionId,
			cwd: root,
			ownerTerminal: { generation, stateDir: root, socketKey: "opaque-owner" },
		});
		const payload = await readPayload(stateFile);
		expect(payload.owner_terminal).toMatchObject({ observer: "raw_monitor", dedupe_key: raw.dedupe_key });
		expect(JSON.stringify(payload)).not.toContain("raw_terminal");
	});
	it("rejects otherwise valid owner intents for non-SIGTERM exits and dispatch mismatches", async () => {
		const root = await tempRoot();
		for (const [signal, dispatch] of [
			["SIGHUP", "dispatch"],
			["SIGINT", "dispatch"],
			["EXIT", "dispatch"],
			["SIGTERM", "other-dispatch"],
		] as const) {
			const sessionId = `negative-${signal}-${dispatch}`;
			const generation = await replaceOwnerGeneration(root, sessionId, `generation-${signal}-${dispatch}`);
			await createOwnerIntent(root, {
				generation,
				session_id: sessionId,
				server_key: "private-owner",
				expected_terminal: { signal: "SIGTERM", result: "owner_term_then_session_cleanup" },
				dispatch_id: "dispatch",
				created_at: "2026-01-01T00:00:00.000Z",
				expires_at: "2099-01-01T00:00:00.000Z",
			});
			const verdict = await observeOwnerTerminal({
				schema_version: 1,
				op: "observe_terminal",
				session_id: sessionId,
				owner_generation: generation,
				state_dir: root,
				socket_key: "private-owner",
				observer: "raw_monitor",
				observed_at: "2026-01-01T00:00:01.000Z",
				signal,
				exit_code: null,
				exit_kind: signal.toLowerCase(),
				reason: "terminal",
				operator_dispatch_id: dispatch,
			});
			expect(verdict.classification).toBe("unexpected_owner_loss");
			expect(verdict.intent_id).toBeUndefined();
		}
	});

	it("reclaims orphaned runtime-state locks without inspecting protected payloads", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "runtime-state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "orphaned-runtime-lock";
		await Bun.write(
			`${stateFile}.lock`,
			JSON.stringify({ pid: 999_999_999, start_time: "0", token: "orphaned-writer" }),
		);
		await persistCoordinatorRuntimeStateFromEvent(assistantEnd("completed"), {
			sessionId: "orphaned-runtime-lock",
			cwd: root,
			sessionFile: null,
		});
		expect((await readPayload(stateFile)).state).toBe("completed");
		expect(await Bun.file(`${stateFile}.lock`).exists()).toBe(false);
	});

	it("publishes one byte-stable immutable verdict when raw and sidecar observers race", async () => {
		const root = await tempRoot();
		const sessionId = "barrier-race";
		const generation = await replaceOwnerGeneration(root, sessionId, "barrier-generation");
		await createOwnerIntent(root, {
			generation,
			session_id: sessionId,
			server_key: "private-owner",
			expected_terminal: { signal: "SIGTERM", result: "owner_term_then_session_cleanup" },
			dispatch_id: "barrier-dispatch",
			created_at: "2026-01-01T00:00:00.000Z",
			expires_at: "2099-01-01T00:00:10.000Z",
		});
		const generationBytes = await Bun.file(lifecyclePaths(root, sessionId, generation).generationFile).text();
		const barrier = Promise.withResolvers<void>();
		const observe = (observer: "raw_monitor" | "sidecar") =>
			barrier.promise.then(() =>
				observeOwnerTerminal({
					schema_version: 1,
					op: "observe_terminal",
					session_id: sessionId,
					owner_generation: generation,
					state_dir: root,
					socket_key: "private-owner",
					observer,
					observed_at: "2026-01-01T00:00:01.000Z",
					signal: "SIGTERM",
					exit_code: null,
					exit_kind: "sigterm",
					reason: "terminal",
					operator_dispatch_id: "barrier-dispatch",
				}),
			);
		const raw = observe("raw_monitor");
		const sidecar = observe("sidecar");
		barrier.resolve();
		const [rawVerdict, sidecarVerdict] = await Promise.all([raw, sidecar]);
		expect(rawVerdict).toEqual(sidecarVerdict);
		const paths = lifecyclePaths(root, sessionId, generation);
		const verdictBytes = await Bun.file(paths.verdictFile).text();
		expect(verdictBytes).toBe(`${JSON.stringify(rawVerdict)}\n`);
		expect(await Bun.file(paths.generationFile).text()).toBe(generationBytes);
		expect(["raw_monitor", "sidecar"]).toContain(rawVerdict.observer);
		expect(await Bun.file(paths.intentFile).exists()).toBe(false);
		expect(await Bun.file(`${paths.intentFile}.consumed`).exists()).toBe(true);
		expect(await Bun.file(paths.incidentFile).exists()).toBe(false);
	});
	it("serializes reverse-release running and terminal postmortem races", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "serialized-race.json");
		const sessionId = "serialized-race";
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		const context = { sessionId, cwd: root, sessionFile: null };

		await Promise.all([
			persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.SIGTERM, context),
			persistCoordinatorRuntimeStateFromEvent({ type: "agent_start" }, context),
			persistCoordinatorRuntimeStateFromEvent(assistantEnd("committed terminal"), context),
		]);

		const terminal = await readPayload(stateFile);
		expect(terminal).toMatchObject({
			session_id: sessionId,
			state: "completed",
			final_response: { source: "agent_end", text: "committed terminal" },
		});
		await persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.SIGTERM, context);
		expect(await readPayload(stateFile)).toEqual(terminal);
	});
	it("persists an immutable runtime input readiness marker with the coordinator authority fields", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "state.json");
		const readinessFile = path.join(root, "runtime-input-ready.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "ready-session";
		process.env[GJC_COORDINATOR_SESSION_LAUNCH_ID_ENV] = "ready-launch";
		process.env[GJC_COORDINATOR_SESSION_READINESS_FILE_ENV] = readinessFile;
		setSystemTime(new Date("2026-07-11T12:00:00.000Z"));

		const marker = await persistCoordinatorRuntimeInputReady();

		if (!marker) throw new Error("expected_runtime_readiness_marker");
		expect(marker).toEqual({
			schema_version: 1,
			session_id: "ready-session",
			launch_id: "ready-launch",
			state: "ready_for_input",
			event: "interactive_input_ready",
			source: "gjc_interactive_runtime",
			ready_for_input: true,
			created_at: "2026-07-11T12:00:00.000Z",
		});
		expect(Object.isFrozen(marker)).toBe(true);
		expect(await readJson(readinessFile)).toEqual(marker);
		setSystemTime();
	});

	it("does not create a readiness marker without every coordinator authority input", async () => {
		delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
		delete process.env[GJC_COORDINATOR_SESSION_ID_ENV];
		delete process.env[GJC_COORDINATOR_SESSION_LAUNCH_ID_ENV];
		delete process.env[GJC_COORDINATOR_SESSION_READINESS_FILE_ENV];

		expect(await persistCoordinatorRuntimeInputReady()).toBeNull();
	});

	it("returns the original readiness marker without rewriting its timestamp", async () => {
		const root = await tempRoot();
		const readinessFile = path.join(root, "runtime-input-ready.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = path.join(root, "state.json");
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "idempotent-session";
		process.env[GJC_COORDINATOR_SESSION_LAUNCH_ID_ENV] = "idempotent-launch";
		process.env[GJC_COORDINATOR_SESSION_READINESS_FILE_ENV] = readinessFile;
		setSystemTime(new Date("2026-07-11T12:00:00.000Z"));
		const first = await persistCoordinatorRuntimeInputReady();
		const original = await Bun.file(readinessFile).text();
		setSystemTime(new Date("2026-07-11T12:01:00.000Z"));

		const second = await persistCoordinatorRuntimeInputReady();

		expect(second).toEqual(first);
		expect(await Bun.file(readinessFile).text()).toBe(original);
		setSystemTime();
	});

	it("rejects malformed and conflicting readiness markers without overwriting them", async () => {
		const root = await tempRoot();
		const readinessFile = path.join(root, "runtime-input-ready.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = path.join(root, "state.json");
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "conflict-session";
		process.env[GJC_COORDINATOR_SESSION_LAUNCH_ID_ENV] = "conflict-launch";
		process.env[GJC_COORDINATOR_SESSION_READINESS_FILE_ENV] = readinessFile;
		await Bun.write(readinessFile, "not json");

		await expect(persistCoordinatorRuntimeInputReady()).rejects.toMatchObject({
			code: "runtime_readiness_marker_conflict",
		});
		expect(await Bun.file(readinessFile).text()).toBe("not json");
		await Bun.write(
			readinessFile,
			JSON.stringify({
				schema_version: 1,
				session_id: "other-session",
				launch_id: "conflict-launch",
				state: "ready_for_input",
				event: "interactive_input_ready",
				source: "gjc_interactive_runtime",
				ready_for_input: true,
				created_at: "2026-07-11T12:00:00.000Z",
			}),
		);

		await expect(persistCoordinatorRuntimeInputReady()).rejects.toMatchObject({
			code: "runtime_readiness_marker_conflict",
		});
		expect((await readJson(readinessFile)).session_id).toBe("other-session");
		await Bun.write(
			readinessFile,
			JSON.stringify({
				schema_version: 1,
				session_id: "conflict-session",
				launch_id: "conflict-launch",
				state: "ready_for_input",
				event: "interactive_input_ready",
				source: "gjc_interactive_runtime",
				ready_for_input: true,
				created_at: "",
			}),
		);
		await expect(persistCoordinatorRuntimeInputReady()).rejects.toMatchObject({
			code: "runtime_readiness_marker_conflict",
		});
		expect((await readJson(readinessFile)).created_at).toBe("");
	});

	it("resolves a same-authority create race to the installed marker and removes temporary files", async () => {
		const root = await tempRoot();
		const readinessFile = path.join(root, "runtime-input-ready.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = path.join(root, "state.json");
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "race-session";
		process.env[GJC_COORDINATOR_SESSION_LAUNCH_ID_ENV] = "race-launch";
		process.env[GJC_COORDINATOR_SESSION_READINESS_FILE_ENV] = readinessFile;

		const [left, right] = await Promise.all([
			persistCoordinatorRuntimeInputReady(),
			persistCoordinatorRuntimeInputReady(),
		]);
		if (!left || !right) throw new Error("expected_runtime_readiness_marker");

		expect(left).toEqual(right);
		expect(await readJson(readinessFile)).toEqual(left);
		expect((await fs.readdir(root)).filter(entry => entry.endsWith(".tmp"))).toEqual([]);
	});

	it("keeps the input readiness marker independent from subsequent mutable state writes", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "state.json");
		const readinessFile = path.join(root, "runtime-input-ready.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "independent-session";
		process.env[GJC_COORDINATOR_SESSION_LAUNCH_ID_ENV] = "independent-launch";
		process.env[GJC_COORDINATOR_SESSION_READINESS_FILE_ENV] = readinessFile;
		const marker = await persistCoordinatorRuntimeInputReady();
		if (!marker) throw new Error("expected_runtime_readiness_marker");

		await persistCoordinatorRuntimeStateFromEvent({ type: "agent_start" }, { sessionId: "fallback", cwd: root });

		expect(await readJson(readinessFile)).toEqual(marker);
		expect((await readJson(stateFile)).state).toBe("running");
	});
});
