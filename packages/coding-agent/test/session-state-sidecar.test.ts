import { afterEach, describe, expect, it, setSystemTime, spyOn } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import type { PathLike, StatOptions } from "node:fs";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { postmortem } from "@gajae-code/utils";
import { FileLockTestHooks, processStartTime } from "../src/config/file-lock";
import { loadInstallationHostId } from "../src/config/machine-identity";
import { sessionRuntimeDir } from "../src/gjc-runtime/session-layout";
import {
	SessionStateLockTestHooks,
	SessionStateLockUnavailableError,
	withSessionStateFileLock,
} from "../src/gjc-runtime/session-state-lock";
import {
	__sessionStateSidecarTestHooks,
	canonicalCoordinatorSidecarPayload,
	classifyRuntimeToolActivity,
	clearCoordinatorRuntimeStateRescope,
	eventAffectsCoordinatorRuntimeState,
	GJC_COORDINATOR_SESSION_BRANCH_ENV,
	GJC_COORDINATOR_SESSION_ID_ENV,
	GJC_COORDINATOR_SESSION_LAUNCH_ID_ENV,
	GJC_COORDINATOR_SESSION_READINESS_FILE_ENV,
	GJC_COORDINATOR_SESSION_STATE_FILE_ENV,
	GJC_COORDINATOR_SIDECAR_KEY_ID_ENV,
	GJC_COORDINATOR_SIDECAR_SIGNATURE_REQUIRED_ENV,
	GJC_COORDINATOR_SIDECAR_SIGNING_KEY_ENV,
	GJC_TMUX_OWNER_GENERATION_ENV,
	GJC_TMUX_OWNER_SERVER_KEY_ENV,
	GJC_TMUX_OWNER_STATE_DIR_ENV,
	markCoordinatorRuntimeStateRescopePublishing,
	ownerTerminalContextFromEnvironment,
	persistCoordinatorRuntimeInputReady,
	persistCoordinatorRuntimeStateFromEvent,
	persistCoordinatorRuntimeStateFromPostmortem,
	persistCoordinatorWorkerIntegrationOutcome,
	prepareCoordinatorRuntimeStateRescope,
	publicRuntimeToolActivity,
	readTerminalRuntimeStateMarker,
	recoverCoordinatorRuntimeStateRescope,
	relocateCoordinatorRuntimeStateForRescope,
	stateForEvent,
} from "../src/gjc-runtime/session-state-sidecar";
import {
	createOwnerIntent,
	lifecyclePaths,
	observeOwnerTerminal,
	replaceOwnerGeneration,
} from "../src/gjc-runtime/tmux-owner-isolation";
import { installExactIdentityNatives } from "./helpers/exact-identity-natives";
import { coordinatorDurabilityAvailable } from "./helpers/issue-4545-gates";

// Dependency-conditional runner for the #4545 masking tests (#4459 semantics):
// full strength once the durability module exists, visible skip before that.
const maskingIt = coordinatorDurabilityAvailable() ? it : it.skip;

const tempDirs: string[] = [];
// Every write below serializes on the coordinator state lock, whose removals go through
// identity-bound native primitives. Point them at a working implementation so these tests
// exercise the sidecar rather than the compiled addon's availability.
installExactIdentityNatives();

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
const ORIGINAL_SIDECAR_SIGNING_KEY = process.env[GJC_COORDINATOR_SIDECAR_SIGNING_KEY_ENV];
const ORIGINAL_SIDECAR_KEY_ID = process.env[GJC_COORDINATOR_SIDECAR_KEY_ID_ENV];
const ORIGINAL_SIDECAR_SIGNATURE_REQUIRED = process.env[GJC_COORDINATOR_SIDECAR_SIGNATURE_REQUIRED_ENV];
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
	FileLockTestHooks.afterParentMkdir = undefined;
	__sessionStateSidecarTestHooks.afterRescopeLocksAcquired = undefined;
	__sessionStateSidecarTestHooks.beforeRescopeJournalWrite = undefined;
	__sessionStateSidecarTestHooks.beforePersistFromEvent = undefined;
	__sessionStateSidecarTestHooks.beforeRescopePublish = undefined;
	setSystemTime();
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
	if (ORIGINAL_SIDECAR_SIGNING_KEY === undefined) delete process.env[GJC_COORDINATOR_SIDECAR_SIGNING_KEY_ENV];
	else process.env[GJC_COORDINATOR_SIDECAR_SIGNING_KEY_ENV] = ORIGINAL_SIDECAR_SIGNING_KEY;
	if (ORIGINAL_SIDECAR_KEY_ID === undefined) delete process.env[GJC_COORDINATOR_SIDECAR_KEY_ID_ENV];
	else process.env[GJC_COORDINATOR_SIDECAR_KEY_ID_ENV] = ORIGINAL_SIDECAR_KEY_ID;
	if (ORIGINAL_SIDECAR_SIGNATURE_REQUIRED === undefined)
		delete process.env[GJC_COORDINATOR_SIDECAR_SIGNATURE_REQUIRED_ENV];
	else process.env[GJC_COORDINATOR_SIDECAR_SIGNATURE_REQUIRED_ENV] = ORIGINAL_SIDECAR_SIGNATURE_REQUIRED;
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
	it("persists post-publication integration failures with correlation", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "agent_start" },
			{ sessionId: "reconcile", cwd: root, sessionFile: null },
		);
		await persistCoordinatorRuntimeStateFromEvent(
			{
				type: "agent_end",
				messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }],
			},
			{ sessionId: "reconcile", cwd: root, sessionFile: null },
		);
		await persistCoordinatorWorkerIntegrationOutcome(
			{ sessionId: "reconcile", cwd: root, sessionFile: null },
			{
				kind: "worker_integration",
				status: "failed",
				correlationId: "cmd:turn",
				error: "worker\u0000 unavailable\n",
			},
		);
		const payload = await readJson(stateFile);
		expect(payload.worker_integration).toMatchObject({
			status: "failed",
			correlation_id: "cmd:turn",
			error: "worker  unavailable",
		});
		expect(payload.error).toMatchObject({ code: "worker_integration_failed", recoverable: true });
	});

	it("terminalizes prior running state when terminal persistence fails", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "agent_start" },
			{ sessionId: "terminal-failure", cwd: root, sessionFile: null },
		);
		await persistCoordinatorWorkerIntegrationOutcome(
			{ sessionId: "terminal-failure", cwd: root, sessionFile: null },
			{ kind: "terminal_persistence", status: "failed", error: "write failed" },
		);
		await expect(readJson(stateFile)).resolves.toMatchObject({
			state: "errored",
			ready_for_input: false,
			live: false,
			current_turn_id: null,
			execution_state: "failed",
			receipt_state: "absent",
			error: { code: "terminal_persistence_failed", recoverable: true },
		});
	});

	it("regresses signed subprocess bootstrap, continuation, and tamper refusal", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "state.json");
		const fixture = path.join(import.meta.dir, "fixtures", "session-state-sidecar-subprocess.ts");
		const { privateKey, publicKey } = generateKeyPairSync("ed25519");
		const privateDer = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
		const publicDer = publicKey.export({ format: "der", type: "spki" });
		const keyId = "155f1a4c155f1a4c155f1a4c155f1a4c155f1a4c155f1a4c155f1a4c155f1a4c";
		const env = {
			...process.env,
			[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]: stateFile,
			[GJC_COORDINATOR_SESSION_ID_ENV]: "155-FinalA4",
			[GJC_COORDINATOR_SIDECAR_SIGNATURE_REQUIRED_ENV]: "true",
			[GJC_COORDINATOR_SIDECAR_KEY_ID_ENV]: keyId,
			[GJC_COORDINATOR_SIDECAR_SIGNING_KEY_ENV]: privateDer,
		};
		const run = async () => {
			const child = Bun.spawn([process.execPath, fixture, stateFile], { env, stdout: "pipe", stderr: "pipe" });
			return await child.exited;
		};
		expect(await run()).toBe(0);
		const raw = await Bun.file(stateFile).text();
		const payload = JSON.parse(raw) as Record<string, unknown>;
		expect(payload.sidecar_key_id).toBe(keyId);
		expect(typeof payload.sidecar_signature).toBe("string");
		const { sidecar_signature: signature, ...unsigned } = payload;
		expect(
			verify(
				null,
				Buffer.from(canonicalCoordinatorSidecarPayload(unsigned)),
				{ key: publicDer, format: "der", type: "spki" },
				Buffer.from(String(signature), "base64"),
			),
		).toBe(true);
		expect(unsigned.state).toBe("completed");
		expect(unsigned.activity).toMatchObject({ active_tool_count: 0 });
		const tampered = { ...payload, state: "running" };
		await Bun.write(stateFile, `${JSON.stringify(tampered)}\\n`);
		const before = await Bun.file(stateFile).bytes();
		expect(await run()).not.toBe(0);
		expect(await Bun.file(stateFile).bytes()).toEqual(before);
	});

	it("requires a valid predecessor signature before a pinned rescope is re-signed", async () => {
		const root = await tempRoot();
		const launcher = path.join(root, "launcher");
		const target = path.join(root, "target");
		const next = path.join(root, "next");
		await fs.mkdir(launcher);
		await fs.mkdir(target);
		await fs.mkdir(next);
		const stateFile = path.join(root, "state.json");
		const fixture = path.join(import.meta.dir, "fixtures", "session-state-sidecar-subprocess.ts");
		const { privateKey, publicKey } = generateKeyPairSync("ed25519");
		const privateDer = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
		const publicDer = publicKey.export({ format: "der", type: "spki" });
		const keyId = "255f1a4c255f1a4c255f1a4c255f1a4c255f1a4c255f1a4c255f1a4c255f1a4c";
		const env = {
			...process.env,
			[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]: stateFile,
			[GJC_COORDINATOR_SESSION_ID_ENV]: "155-FinalA4",
			[GJC_COORDINATOR_SIDECAR_SIGNATURE_REQUIRED_ENV]: "true",
			[GJC_COORDINATOR_SIDECAR_KEY_ID_ENV]: keyId,
			[GJC_COORDINATOR_SIDECAR_SIGNING_KEY_ENV]: privateDer,
		};
		const run = async (args: string[], cwd: string) => {
			const child = Bun.spawn([process.execPath, fixture, stateFile, ...args], {
				cwd,
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			return await child.exited;
		};
		expect(await run([], launcher)).toBe(0);
		expect(await run(["relocate", launcher, target], launcher)).toBe(0);
		const relocated = await readPayload(stateFile);
		expect(relocated.cwd).toBe(path.resolve(target));
		const { sidecar_signature: signature, ...unsigned } = relocated;
		expect(
			verify(
				null,
				Buffer.from(canonicalCoordinatorSidecarPayload(unsigned)),
				{ key: publicDer, format: "der", type: "spki" },
				Buffer.from(String(signature), "base64"),
			),
		).toBe(true);

		await Bun.write(stateFile, `${JSON.stringify({ ...relocated, state: "running" })}\n`);
		const tampered = await Bun.file(stateFile).bytes();
		expect(await run(["relocate", target, next], target)).not.toBe(0);
		expect(await Bun.file(stateFile).bytes()).toEqual(tampered);
	});

	it("rejects a tampered signed rescope journal without clearing recovery evidence", async () => {
		const root = await tempRoot();
		const launcher = path.join(root, "launcher");
		const target = path.join(root, "target");
		await fs.mkdir(launcher);
		await fs.mkdir(target);
		const stateFile = path.join(root, "state.json");
		const fixture = path.join(import.meta.dir, "fixtures", "session-state-sidecar-subprocess.ts");
		const { privateKey } = generateKeyPairSync("ed25519");
		const privateDer = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
		const keyId = "355f1a4c355f1a4c355f1a4c355f1a4c355f1a4c355f1a4c355f1a4c355f1a4c";
		const env = {
			...process.env,
			[GJC_COORDINATOR_SESSION_STATE_FILE_ENV]: stateFile,
			[GJC_COORDINATOR_SESSION_ID_ENV]: "155-FinalA4",
			[GJC_COORDINATOR_SIDECAR_SIGNATURE_REQUIRED_ENV]: "true",
			[GJC_COORDINATOR_SIDECAR_KEY_ID_ENV]: keyId,
			[GJC_COORDINATOR_SIDECAR_SIGNING_KEY_ENV]: privateDer,
		};
		const run = async (args: string[], cwd: string) => {
			const child = Bun.spawn([process.execPath, fixture, stateFile, ...args], {
				cwd,
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			return await child.exited;
		};
		expect(await run([], launcher)).toBe(0);
		expect(await run(["prepare-journal", launcher, target], launcher)).toBe(0);
		const journalFile = path.join(sessionRuntimeDir(target, "155-FinalA4"), "runtime-state-rescope.json");
		const journal = await readPayload(journalFile);
		await Bun.write(journalFile, `${JSON.stringify({ ...journal, previous_cwd: root })}\n`);
		const beforeJournal = await Bun.file(journalFile).bytes();
		const beforeState = await Bun.file(stateFile).bytes();

		expect(await run(["recover", target], target)).not.toBe(0);

		expect(await Bun.file(journalFile).bytes()).toEqual(beforeJournal);
		expect(await Bun.file(stateFile).bytes()).toEqual(beforeState);
	});

	it("ignores a session root removed between postmortem lock parent creation and acquisition", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, ".gjc", "_session-removed", "state", "runtime-state.json");
		const sessionRoot = path.resolve(path.dirname(stateFile), "..");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		let removed = false;
		FileLockTestHooks.afterParentMkdir = async lockPath => {
			if (removed || !lockPath.endsWith("mutation.lock.lock")) return;
			removed = true;
			await fs.rm(sessionRoot, { recursive: true, force: true });
		};

		await expect(
			persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.EXIT, {
				sessionId: "removed",
				cwd: root,
				sessionFile: null,
			}),
		).resolves.toBeUndefined();
		expect(removed).toBe(true);
		expect(fsSync.existsSync(sessionRoot)).toBe(false);
	});
	it("does not suppress a nested state lock failure while the owning session root remains", async () => {
		const root = await tempRoot();
		const sessionRoot = path.join(root, ".gjc", "_session-present");
		const stateFile = path.join(sessionRoot, "runtime", "nested", "runtime-state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		await fs.mkdir(sessionRoot, { recursive: true });
		await fs.writeFile(path.join(sessionRoot, "owner.marker"), "present");
		let removed = false;
		FileLockTestHooks.afterParentMkdir = async lockPath => {
			if (removed || !lockPath.endsWith("mutation.lock.lock")) return;
			removed = true;
			await fs.rm(path.dirname(lockPath), { recursive: true, force: true });
		};

		await expect(
			persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.EXIT, {
				sessionId: "present",
				cwd: root,
				sessionFile: null,
			}),
		).rejects.toMatchObject({ code: "ENOENT" });
		expect(removed).toBe(true);
		expect(fsSync.existsSync(sessionRoot)).toBe(true);
	});
	it("reports whether events affect coordinator runtime state", () => {
		const events = [
			{
				event: { type: "message_update", message: {}, assistantMessageEvent: {} },
				affects: false,
				lifecycle: false,
			},
			{ event: { type: "notice", level: "info", message: "background notice" }, affects: false, lifecycle: false },
			{ event: { type: "turn_start" }, affects: true, lifecycle: true },
			{ event: { type: "agent_start" }, affects: true, lifecycle: true },
			{ event: { type: "agent_end", messages: [] }, affects: true, lifecycle: true },
			// Tool events carry no lifecycle state, but they do change the shared file.
			{ event: { type: "tool_execution_start", toolCallId: "call-1" }, affects: true, lifecycle: false },
			{ event: { type: "tool_execution_end", toolCallId: "call-1" }, affects: true, lifecycle: false },
		] as const;

		for (const { event, affects, lifecycle } of events) {
			expect(eventAffectsCoordinatorRuntimeState(event as never)).toBe(affects);
			expect(stateForEvent(event as never) !== null).toBe(lifecycle);
		}
	});

	it("persists explicit standalone tmux state with authority env cleared", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "standalone-state.json");
		delete process.env[GJC_COORDINATOR_SIDECAR_SIGNING_KEY_ENV];
		delete process.env[GJC_COORDINATOR_SIDECAR_SIGNATURE_REQUIRED_ENV];
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "standalone-tmux";

		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "agent_start" },
			{ sessionId: "fallback", cwd: root, sessionFile: null },
		);

		expect(await readPayload(stateFile)).toMatchObject({ session_id: "standalone-tmux", state: "running" });
	});

	it("requires Coordinator signing material captured at launch and rejects predecessor launch payloads", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "coordinator-state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "coordinator-session";
		process.env[GJC_COORDINATOR_SIDECAR_SIGNATURE_REQUIRED_ENV] = "true";
		delete process.env[GJC_COORDINATOR_SIDECAR_SIGNING_KEY_ENV];

		await expect(
			persistCoordinatorRuntimeStateFromEvent(
				{ type: "agent_start" },
				{ sessionId: "fallback", cwd: root, sessionFile: null },
			),
		).rejects.toThrow("invalid or unreadable");
		expect(await Bun.file(stateFile).exists()).toBe(false);

		// The signer is captured and removed before runtime initialization. Supplying
		// a predecessor-format secret after module bootstrap must not arm a signer.
		process.env[GJC_COORDINATOR_SIDECAR_SIGNING_KEY_ENV] = "a".repeat(64);
		process.env[GJC_COORDINATOR_SIDECAR_KEY_ID_ENV] = "a".repeat(64);
		await expect(
			persistCoordinatorRuntimeStateFromEvent(
				{ type: "turn_start" },
				{ sessionId: "fallback", cwd: root, sessionFile: null },
			),
		).rejects.toThrow("invalid or unreadable");
		expect(await Bun.file(stateFile).exists()).toBe(false);
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

	it("reports a live transition timeout without misclassifying or changing runtime state", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "transition-timeout-state.json");
		const transitionDir = `${stateFile}.lock.transition`;
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "transition-timeout";

		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "turn_start" },
			{ sessionId: "fallback", cwd: root, sessionFile: null },
		);
		const before = await Bun.file(stateFile).bytes();
		await fs.mkdir(transitionDir);
		await fs.writeFile(
			`${transitionDir}.owner`,
			JSON.stringify({
				pid: process.pid,
				start_time: processStartTime(process.pid) ?? "unknown",
				token: "live-transition-timeout",
				owner_host_id: await loadInstallationHostId(),
			}),
		);

		const failure = await persistCoordinatorRuntimeStateFromEvent(
			{ type: "turn_start" },
			{ sessionId: "fallback", cwd: root, sessionFile: null },
		).catch(error => error);

		expect(failure).toBeInstanceOf(SessionStateLockUnavailableError);
		expect(failure).toMatchObject({
			lockPath: transitionDir,
			reason: "transition_claim_timeout",
		});
		expect(await Bun.file(stateFile).bytes()).toEqual(before);
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
		const originalStat = fs.stat;
		const stat = spyOn(fs, "stat").mockImplementation((async (file: PathLike, options?: StatOptions) => {
			if (String(file) === stateFile) return Promise.reject(denied);
			return Reflect.apply(originalStat, fs, [file, options]) as never;
		}) as typeof fs.stat);
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

		const originalReadFileSync = fsSync.readFileSync;
		const readFileSync = spyOn(fsSync, "readFileSync").mockImplementation((file, options) => {
			if (String(file) === stateFile) throw denied;
			return Reflect.apply(originalReadFileSync, fsSync, [file, options]) as never;
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
			ready_for_input: false,
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
	it("publishes the owner verdict before preserving terminal agent evidence", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "state.json");
		const sessionId = "preserved-owner-session";
		const generation = await replaceOwnerGeneration(root, sessionId, "preserved-owner-generation");
		await createOwnerIntent(root, {
			generation,
			session_id: sessionId,
			server_key: "opaque-owner",
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
				state: "completed",
				cwd: root,
				workdir: root,
				session_file: null,
				final_response: { source: "agent_end", text: "Already done" },
			}),
		);

		await persistCoordinatorRuntimeStateFromPostmortem(postmortem.Reason.SIGTERM, {
			sessionId,
			cwd: root,
			sessionFile: null,
			ownerTerminal: { generation, stateDir: root, socketKey: "opaque-owner" },
		});

		expect(await readPayload(stateFile)).toMatchObject({
			state: "completed",
			final_response: { source: "agent_end", text: "Already done" },
		});
		expect(await readJson(lifecyclePaths(root, sessionId, generation).verdictFile)).toMatchObject({
			classification: "expected_operator_shutdown",
			observer: "sidecar",
		});
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
	}, 30_000);

	it("reclaims orphaned runtime-state locks without inspecting protected payloads", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "runtime-state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "orphaned-runtime-lock";
		SessionStateLockTestHooks.unqualifiedOwnerIsLocal = true;
		await fs.mkdir(`${stateFile}.lock`);
		await Bun.write(
			`${stateFile}.lock/info`,
			JSON.stringify({
				pid: 2 ** 22 - 1,
				start_time: "whenever",
				timestamp: Date.now() - 60_000,
				owner_host_id: await loadInstallationHostId(),
			}),
		);
		await Bun.write(`${stateFile}.lock/protected-payload`, "not-json-secret\n");
		await persistCoordinatorRuntimeStateFromEvent(assistantEnd("completed"), {
			sessionId: "orphaned-runtime-lock",
			cwd: root,
			sessionFile: null,
		});
		expect((await readPayload(stateFile)).state).toBe("completed");
		expect(await readJson(`${stateFile}.lock`)).toMatchObject({ pid: 1, released: true });
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
	maskingIt("does not let a failing readiness cleanup mask the publication error (#4545)", async () => {
		const root = await tempRoot();
		const readinessFile = path.join(root, "runtime-input-ready.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = path.join(root, "state.json");
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "masking-session";
		process.env[GJC_COORDINATOR_SESSION_LAUNCH_ID_ENV] = "masking-launch";
		process.env[GJC_COORDINATOR_SESSION_READINESS_FILE_ENV] = readinessFile;
		// Primary: the readiness publication (fs.link to the readiness file)
		// fails with EIO. Secondary: the finally-block temp-file cleanup (fs.rm)
		// fails with EACCES. Pre-fix (`try { ... } finally { await fs.rm(...) }`)
		// the cleanup error replaced the publication error entirely. Post-#4459
		// the primary survives with the cleanup failure attached.
		const realLink = fs.link;
		const realRm = fs.rm;
		const link = spyOn(fs, "link").mockImplementation(async (source, destination) => {
			if (destination === readinessFile) throw Object.assign(new Error("EIO"), { code: "EIO" });
			return realLink(source, destination);
		});
		const rm = spyOn(fs, "rm").mockImplementation(async (target, options) => {
			if (String(target).endsWith(".tmp")) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
			return realRm(target, options);
		});
		try {
			const observed = await persistCoordinatorRuntimeInputReady().then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(observed).toBeInstanceOf(AggregateError);
			const aggregate = observed as AggregateError;
			const codes = aggregate.errors.map(cause => (cause as NodeJS.ErrnoException).code);
			expect(codes[0]).toBe("EIO");
			expect(codes).toContain("EACCES");
			expect(aggregate.message).toContain("readiness publication and cleanup failed");
		} finally {
			link.mockRestore();
			rm.mockRestore();
		}
	});

	maskingIt("does not let a failing close mask the readiness write error (#4545)", async () => {
		const root = await tempRoot();
		const readinessFile = path.join(root, "runtime-input-ready.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = path.join(root, "state.json");
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "masking-close-session";
		process.env[GJC_COORDINATOR_SESSION_LAUNCH_ID_ENV] = "masking-close-launch";
		process.env[GJC_COORDINATOR_SESSION_READINESS_FILE_ENV] = readinessFile;
		// Primary: the temp-file write fails with EIO. Secondary: handle.close()
		// fails with EACCES. Pre-fix (`try { write; sync } finally { close }`) the
		// close error replaced the write error. Post-#4459 both survive.
		const realOpen = fs.open;
		const open = spyOn(fs, "open").mockImplementation(async (target, flags) => {
			if (String(target).endsWith(".tmp")) {
				return {
					writeFile: async () => {
						throw Object.assign(new Error("EIO"), { code: "EIO" });
					},
					sync: async () => {},
					close: async () => {
						throw Object.assign(new Error("EACCES"), { code: "EACCES" });
					},
				} as unknown as Awaited<ReturnType<typeof fs.open>>;
			}
			return realOpen(target, flags);
		});
		try {
			const observed = await persistCoordinatorRuntimeInputReady().then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(observed).toBeInstanceOf(AggregateError);
			const aggregate = observed as AggregateError;
			const codes = aggregate.errors.map(cause => (cause as NodeJS.ErrnoException).code);
			expect(codes[0]).toBe("EIO");
			expect(codes).toContain("EACCES");
			expect(aggregate.message).toContain("readiness write and close failed");
		} finally {
			open.mockRestore();
		}
	});

	maskingIt(
		"still publishes the readiness marker when cleanup succeeds after a publication failure (#4545)",
		async () => {
			const root = await tempRoot();
			const readinessFile = path.join(root, "runtime-input-ready.json");
			process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = path.join(root, "state.json");
			process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "primary-only-session";
			process.env[GJC_COORDINATOR_SESSION_LAUNCH_ID_ENV] = "primary-only-launch";
			process.env[GJC_COORDINATOR_SESSION_READINESS_FILE_ENV] = readinessFile;
			// Publication fails, cleanup succeeds: the primary error must surface
			// alone (not swallowed, not replaced).
			const realLink = fs.link;
			const link = spyOn(fs, "link").mockImplementation(async (source, destination) => {
				if (destination === readinessFile) throw Object.assign(new Error("EIO"), { code: "EIO" });
				return realLink(source, destination);
			});
			try {
				const observed = await persistCoordinatorRuntimeInputReady().then(
					() => undefined,
					(error: unknown) => error,
				);
				expect(observed).toBeDefined();
				expect((observed as NodeJS.ErrnoException).code).toBe("EIO");
				expect(observed).not.toBeInstanceOf(AggregateError);
				expect((await fs.readdir(root)).filter(entry => entry.endsWith(".tmp"))).toEqual([]);
			} finally {
				link.mockRestore();
			}
		},
	);

	it("barriers the parent before returning a same-authority EEXIST race marker", async () => {
		const root = await tempRoot();
		const readinessFile = path.join(root, "runtime-input-ready.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = path.join(root, "state.json");
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "barrier-race-session";
		process.env[GJC_COORDINATOR_SESSION_LAUNCH_ID_ENV] = "barrier-race-launch";
		process.env[GJC_COORDINATOR_SESSION_READINESS_FILE_ENV] = readinessFile;
		const marker = {
			schema_version: 1,
			session_id: "barrier-race-session",
			launch_id: "barrier-race-launch",
			state: "ready_for_input",
			event: "interactive_input_ready",
			source: "gjc_interactive_runtime",
			ready_for_input: true,
			created_at: "2026-07-11T12:00:00.000Z",
		} as const;
		const link = spyOn(fs, "link").mockImplementation(async () => {
			await fs.writeFile(readinessFile, `${JSON.stringify(marker)}\n`);
			throw Object.assign(new Error("exists"), { code: "EEXIST" });
		});
		const realOpen = fs.open;
		let parentBarrierOpens = 0;
		const open = spyOn(fs, "open").mockImplementation(async (...args) => {
			if (args[0] === path.dirname(readinessFile)) parentBarrierOpens += 1;
			return await realOpen(...args);
		});
		try {
			await expect(persistCoordinatorRuntimeInputReady()).resolves.toEqual(marker);
			expect(parentBarrierOpens).toBeGreaterThan(0);
		} finally {
			open.mockRestore();
			link.mockRestore();
		}
	});

	it("retries the parent barrier when an already-published marker reports uncertain durability", async () => {
		const root = await tempRoot();
		const readinessFile = path.join(root, "runtime-input-ready.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = path.join(root, "state.json");
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "retry-barrier-session";
		process.env[GJC_COORDINATOR_SESSION_LAUNCH_ID_ENV] = "retry-barrier-launch";
		process.env[GJC_COORDINATOR_SESSION_READINESS_FILE_ENV] = readinessFile;
		const realOpen = fs.open;
		let parentBarrierOpens = 0;
		const open = spyOn(fs, "open").mockImplementation(async (...args) => {
			if (args[0] === path.dirname(readinessFile)) {
				parentBarrierOpens += 1;
				if (parentBarrierOpens === 1)
					return {
						async sync(): Promise<void> {
							throw Object.assign(new Error("EIO"), { code: "EIO" });
						},
						async close(): Promise<void> {},
					} as unknown as fs.FileHandle;
			}
			return await realOpen(...args);
		});
		try {
			await expect(persistCoordinatorRuntimeInputReady()).rejects.toMatchObject({ code: "EIO" });
			await expect(persistCoordinatorRuntimeInputReady()).resolves.toBeDefined();
			expect(parentBarrierOpens).toBeGreaterThanOrEqual(3);
		} finally {
			open.mockRestore();
		}
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
	it("accepts a coordinator-seeded payload and preserves current_turn_id (#2549)", async () => {
		// The coordinator seeds its state file with current_turn_id but without
		// cwd/workdir/session_file (runtime identity fields). When the runtime writes
		// to the same coordinator-shared file, assertPreviousRuntimeStateIdentity
		// must accept the seed (same session_id) and basePayload must preserve the
		// coordinator's current_turn_id. This is the fencing-compatibility fix that
		// lets the exact-match terminal predicate work without heuristic inference.
		const root = await tempRoot();
		const stateFile = path.join(root, "coordinator-state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		const sessionId = "broker-session-2549";
		const coordinatorTurnId = "turn-correlated-2549";

		// Seed the file as the coordinator would: session_id + current_turn_id, no cwd/workdir.
		await Bun.write(
			stateFile,
			`${JSON.stringify({
				schema_version: 1,
				session_id: sessionId,
				state: "running",
				ready_for_input: false,
				current_turn_id: coordinatorTurnId,
				last_turn_id: null,
				updated_at: new Date().toISOString(),
				source: "coordinator",
				live: null,
				reason: null,
			})}\n`,
		);

		// Runtime writes agent_end to the same file. It must not throw fencing error.
		await persistCoordinatorRuntimeStateFromEvent(assistantEnd("FINAL-2549"), {
			sessionId,
			cwd: root,
			sessionFile: path.join(root, "session.jsonl"),
		});

		const payload = await readPayload(stateFile);
		// The runtime completed with the coordinator's turn ID preserved.
		expect(payload.state).toBe("completed");
		expect(payload.source).toBe("agent_session_event");
		expect(payload.current_turn_id).toBe(coordinatorTurnId);
		expect((payload.final_response as Record<string, unknown> | undefined)?.text).toBe("FINAL-2549");
	});

	it("rejects a foreign session_id in the coordinator-shared file (#2549)", async () => {
		// A genuinely foreign session_id must still be rejected by identity fencing,
		// even when the previous payload lacks cwd/workdir/session_file.
		const root = await tempRoot();
		const stateFile = path.join(root, "coordinator-state-foreign.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		const foreignSessionId = "different-session";
		const runtimeSessionId = "runtime-session-2549";

		await Bun.write(
			stateFile,
			`${JSON.stringify({
				schema_version: 1,
				session_id: foreignSessionId,
				state: "running",
				current_turn_id: "turn-foreign",
			})}\n`,
		);

		// The runtime has a different session_id; fencing must throw.
		await expect(
			persistCoordinatorRuntimeStateFromEvent(assistantEnd("should-not-persist"), {
				sessionId: runtimeSessionId,
				cwd: root,
				sessionFile: path.join(root, "session.jsonl"),
			}),
		).rejects.toThrow();
	});

	it("issue-4629: cwd-derived rescope migrates the payload, clears the orphan, and unblocks later persists", async () => {
		// No GJC_COORDINATOR_SESSION_STATE_FILE: the state file is cwd-derived and lives
		// under the per-session runtime dir rooted at the cwd. move_session changes the cwd
		// but leaves the predecessor payload pointing at the launch root, so the next persist
		// would be refused as a foreign marker until the payload is relocated.
		delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
		const root = await tempRoot();
		const sessionId = "rescope-cwd-derived";
		const launcher = path.join(root, "launcher");
		const target = path.join(launcher, "sub");
		await fs.mkdir(target, { recursive: true });
		const launcherFile = path.join(sessionRuntimeDir(launcher, sessionId), "runtime-state.json");
		const targetFile = path.join(sessionRuntimeDir(target, sessionId), "runtime-state.json");

		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "agent_start" },
			{ sessionId, cwd: launcher, sessionFile: null },
		);
		expect((await readPayload(launcherFile)).cwd).toBe(path.resolve(launcher));

		await relocateCoordinatorRuntimeStateForRescope({ sessionId, cwd: target, sessionFile: null }, launcher);

		const migrated = await readPayload(targetFile);
		expect(migrated.cwd).toBe(path.resolve(target));
		expect(migrated.workdir).toBe(path.resolve(target));
		expect(migrated.source).toBe("session_rescope");
		expect(fsSync.existsSync(launcherFile)).toBe(false);

		// The terminal persist that previously threw now succeeds against the new cwd.
		await persistCoordinatorRuntimeStateFromEvent(assistantEnd("done"), {
			sessionId,
			cwd: target,
			sessionFile: null,
		});
		expect((await readPayload(targetFile)).state).toBe("completed");
	});

	it("issue-4629: restart recovery completes an interrupted authenticated rescope journal", async () => {
		delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
		const root = await tempRoot();
		const sessionId = "rescope-restart-recovery";
		const launcher = path.join(root, "launcher");
		const target = path.join(launcher, "sub");
		await fs.mkdir(target, { recursive: true });
		const launcherFile = path.join(sessionRuntimeDir(launcher, sessionId), "runtime-state.json");
		const targetFile = path.join(sessionRuntimeDir(target, sessionId), "runtime-state.json");
		const journalFile = path.join(sessionRuntimeDir(target, sessionId), "runtime-state-rescope.json");
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "agent_start" },
			{ sessionId, cwd: launcher, sessionFile: null },
		);
		const moveId = await prepareCoordinatorRuntimeStateRescope({
			sessionId,
			previousCwd: launcher,
			newCwd: target,
			previousSessionFile: null,
			newSessionFile: null,
		});
		await markCoordinatorRuntimeStateRescopePublishing(
			{ sessionId, cwd: target, sessionFile: null },
			launcher,
			moveId,
		);
		expect(fsSync.existsSync(journalFile)).toBe(true);

		await recoverCoordinatorRuntimeStateRescope({ sessionId, cwd: target, sessionFile: null });

		expect(fsSync.existsSync(journalFile)).toBe(false);
		expect(fsSync.existsSync(launcherFile)).toBe(false);
		expect(await readPayload(targetFile)).toMatchObject({
			session_id: sessionId,
			cwd: path.resolve(target),
			workdir: path.resolve(target),
			source: "session_rescope",
		});
	});

	it("issue-4629: restart recovery accepts a pinned state file already relocated before journal cleanup", async () => {
		const root = await tempRoot();
		const sessionId = "rescope-pinned-restart";
		const launcher = path.join(root, "launcher");
		const target = path.join(root, "target");
		await fs.mkdir(launcher);
		await fs.mkdir(target);
		const stateFile = path.join(root, "pinned-state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = sessionId;
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "agent_start" },
			{ sessionId, cwd: launcher, sessionFile: null },
		);
		const moveId = await prepareCoordinatorRuntimeStateRescope({
			sessionId,
			previousCwd: launcher,
			newCwd: target,
			previousSessionFile: null,
			newSessionFile: null,
		});
		await markCoordinatorRuntimeStateRescopePublishing(
			{ sessionId, cwd: target, sessionFile: null },
			launcher,
			moveId,
		);
		expect(
			await relocateCoordinatorRuntimeStateForRescope({ sessionId, cwd: target, sessionFile: null }, launcher),
		).toBe(true);
		const relocated = await Bun.file(stateFile).text();

		await recoverCoordinatorRuntimeStateRescope({ sessionId, cwd: target, sessionFile: null });

		expect(await Bun.file(stateFile).text()).toBe(relocated);
		expect(fsSync.existsSync(path.join(sessionRuntimeDir(target, sessionId), "runtime-state-rescope.json"))).toBe(
			false,
		);
	});

	it("issue-4629: recovery retains a pinned journal when ambient state-file configuration changed", async () => {
		const root = await tempRoot();
		const sessionId = "rescope-pinned-config-change";
		const launcher = path.join(root, "launcher");
		const target = path.join(root, "target");
		await fs.mkdir(launcher);
		await fs.mkdir(target);
		const originalStateFile = path.join(root, "state-a.json");
		const replacementStateFile = path.join(root, "state-b.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = originalStateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = sessionId;
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "agent_start" },
			{ sessionId, cwd: launcher, sessionFile: null },
		);
		await prepareCoordinatorRuntimeStateRescope({
			sessionId,
			previousCwd: launcher,
			newCwd: target,
			previousSessionFile: null,
			newSessionFile: null,
		});
		const journalFile = path.join(sessionRuntimeDir(target, sessionId), "runtime-state-rescope.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = replacementStateFile;

		await expect(
			recoverCoordinatorRuntimeStateRescope({ sessionId, cwd: target, sessionFile: null }),
		).rejects.toThrow();

		expect(fsSync.existsSync(journalFile)).toBe(true);
		expect(fsSync.existsSync(originalStateFile)).toBe(true);
		expect(fsSync.existsSync(replacementStateFile)).toBe(false);
	});

	it("issue-4629: journal preparation rejects a symlinked target runtime root", async () => {
		delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
		const root = await tempRoot();
		const sessionId = "rescope-journal-symlink";
		const launcher = path.join(root, "launcher");
		const target = path.join(root, "target");
		const outside = path.join(root, "outside");
		await fs.mkdir(launcher);
		await fs.mkdir(target);
		await fs.mkdir(outside);
		await fs.symlink(outside, path.join(target, ".gjc"));

		await expect(
			prepareCoordinatorRuntimeStateRescope({
				sessionId,
				previousCwd: launcher,
				newCwd: target,
				previousSessionFile: null,
				newSessionFile: null,
			}),
		).rejects.toThrow();

		expect(fsSync.existsSync(path.join(outside, `_session-${sessionId}`, "runtime-state-rescope.json"))).toBe(false);
	});
	it("issue-4629: preparing a new move never replaces an existing recovery journal", async () => {
		delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
		const root = await tempRoot();
		const sessionId = "rescope-journal-no-replace";
		const launcher = path.join(root, "launcher");
		const target = path.join(root, "target");
		await fs.mkdir(launcher);
		await fs.mkdir(target);
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "agent_start" },
			{ sessionId, cwd: launcher, sessionFile: null },
		);
		await prepareCoordinatorRuntimeStateRescope({
			sessionId,
			previousCwd: launcher,
			newCwd: target,
			previousSessionFile: null,
			newSessionFile: null,
		});
		const journalFile = path.join(sessionRuntimeDir(target, sessionId), "runtime-state-rescope.json");
		const original = await Bun.file(journalFile).bytes();

		await expect(
			prepareCoordinatorRuntimeStateRescope({
				sessionId,
				previousCwd: launcher,
				newCwd: target,
				previousSessionFile: null,
				newSessionFile: null,
			}),
		).rejects.toThrow();

		expect(await Bun.file(journalFile).bytes()).toEqual(original);
	});

	it("issue-4629: a prepared move with no source marker recovers as a completed no-op", async () => {
		delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
		const root = await tempRoot();
		const sessionId = "rescope-absent-source";
		const launcher = path.join(root, "launcher");
		const target = path.join(root, "target");
		await fs.mkdir(launcher);
		await fs.mkdir(target);
		const moveId = await prepareCoordinatorRuntimeStateRescope({
			sessionId,
			previousCwd: launcher,
			newCwd: target,
			previousSessionFile: null,
			newSessionFile: null,
		});
		await markCoordinatorRuntimeStateRescopePublishing(
			{ sessionId, cwd: target, sessionFile: null },
			launcher,
			moveId,
		);

		await recoverCoordinatorRuntimeStateRescope({ sessionId, cwd: target, sessionFile: null });

		expect(fsSync.existsSync(path.join(sessionRuntimeDir(launcher, sessionId), "runtime-state-rescope.json"))).toBe(
			false,
		);
		expect(fsSync.existsSync(path.join(sessionRuntimeDir(target, sessionId), "runtime-state-rescope.json"))).toBe(
			false,
		);
	});

	it("issue-4629: restart at the old cwd retires a pre-commit move intent and permits retry", async () => {
		delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
		const root = await tempRoot();
		const sessionId = "rescope-precommit-crash";
		const launcher = path.join(root, "launcher");
		const target = path.join(root, "target");
		await fs.mkdir(launcher);
		await fs.mkdir(target);
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "agent_start" },
			{ sessionId, cwd: launcher, sessionFile: null },
		);
		await prepareCoordinatorRuntimeStateRescope({
			sessionId,
			previousCwd: launcher,
			newCwd: target,
			previousSessionFile: null,
			newSessionFile: null,
		});

		await recoverCoordinatorRuntimeStateRescope({ sessionId, cwd: launcher, sessionFile: null });
		await prepareCoordinatorRuntimeStateRescope({
			sessionId,
			previousCwd: launcher,
			newCwd: target,
			previousSessionFile: null,
			newSessionFile: null,
		});

		expect(fsSync.existsSync(path.join(sessionRuntimeDir(launcher, sessionId), "runtime-state-rescope.json"))).toBe(
			true,
		);
		expect((await readPayload(path.join(sessionRuntimeDir(launcher, sessionId), "runtime-state.json"))).cwd).toBe(
			path.resolve(launcher),
		);
	});

	it("issue-4629: restart at the old cwd preserves a move whose publication phase began", async () => {
		delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
		const root = await tempRoot();
		const sessionId = "rescope-publishing-crash";
		const launcher = path.join(root, "launcher");
		const target = path.join(root, "target");
		await fs.mkdir(launcher);
		await fs.mkdir(target);
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "agent_start" },
			{ sessionId, cwd: launcher, sessionFile: null },
		);
		const moveId = await prepareCoordinatorRuntimeStateRescope({
			sessionId,
			previousCwd: launcher,
			newCwd: target,
			previousSessionFile: null,
			newSessionFile: null,
		});
		await markCoordinatorRuntimeStateRescopePublishing(
			{ sessionId, cwd: target, sessionFile: null },
			launcher,
			moveId,
		);

		await expect(
			recoverCoordinatorRuntimeStateRescope({ sessionId, cwd: launcher, sessionFile: null }),
		).rejects.toThrow();

		expect(fsSync.existsSync(path.join(sessionRuntimeDir(launcher, sessionId), "runtime-state-rescope.json"))).toBe(
			true,
		);
		expect(fsSync.existsSync(path.join(sessionRuntimeDir(target, sessionId), "runtime-state-rescope.json"))).toBe(
			true,
		);
	});

	it("issue-4629: pinned recovery keeps journal namespace separate from coordinator payload identity", async () => {
		const root = await tempRoot();
		const sessionId = "agent-session-id";
		const launcher = path.join(root, "launcher");
		const target = path.join(root, "target");
		await fs.mkdir(launcher);
		await fs.mkdir(target);
		const stateFile = path.join(root, "pinned.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "coordinator-session-id";
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "agent_start" },
			{ sessionId, cwd: launcher, sessionFile: null },
		);
		const moveId = await prepareCoordinatorRuntimeStateRescope({
			sessionId,
			previousCwd: launcher,
			newCwd: target,
			previousSessionFile: null,
			newSessionFile: null,
		});
		await markCoordinatorRuntimeStateRescopePublishing(
			{ sessionId, cwd: target, sessionFile: null },
			launcher,
			moveId,
		);

		await recoverCoordinatorRuntimeStateRescope({ sessionId, cwd: target, sessionFile: null });

		expect((await readPayload(stateFile)).session_id).toBe("coordinator-session-id");
		expect((await readPayload(stateFile)).cwd).toBe(path.resolve(target));
	});

	it("issue-4629: an active move journal fences concurrent old-cwd event writers", async () => {
		delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
		const root = await tempRoot();
		const sessionId = "rescope-writer-fence";
		const launcher = path.join(root, "launcher");
		const target = path.join(root, "target");
		await fs.mkdir(launcher);
		await fs.mkdir(target);
		const stateFile = path.join(sessionRuntimeDir(launcher, sessionId), "runtime-state.json");
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "agent_start" },
			{ sessionId, cwd: launcher, sessionFile: null },
		);
		const before = await Bun.file(stateFile).bytes();
		const moveId = await prepareCoordinatorRuntimeStateRescope({
			sessionId,
			previousCwd: launcher,
			newCwd: target,
			previousSessionFile: null,
			newSessionFile: null,
		});

		await expect(
			persistCoordinatorRuntimeStateFromEvent(
				{ type: "turn_start" },
				{ sessionId, cwd: launcher, sessionFile: null },
			),
		).rejects.toThrow();
		expect(await Bun.file(stateFile).bytes()).toEqual(before);
		await clearCoordinatorRuntimeStateRescope({ sessionId, cwd: target, sessionFile: null }, moveId, launcher);
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "turn_start" },
			{ sessionId, cwd: launcher, sessionFile: null },
		);
		expect((await readPayload(stateFile)).event).toBe("turn_start");
	});

	it("issue-4629: cwd-derived rescope preserves a payload already self-healed at the new cwd", async () => {
		// If the first post-move event already seeded a fresh payload at the new cwd, the
		// relocation must not clobber that current state with the stale predecessor.
		delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
		const root = await tempRoot();
		const sessionId = "rescope-self-healed";
		const launcher = path.join(root, "launcher");
		const target = path.join(launcher, "sub");
		await fs.mkdir(target, { recursive: true });
		const launcherFile = path.join(sessionRuntimeDir(launcher, sessionId), "runtime-state.json");
		const targetFile = path.join(sessionRuntimeDir(target, sessionId), "runtime-state.json");

		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "agent_start" },
			{ sessionId, cwd: launcher, sessionFile: null },
		);
		// A post-move event self-heals at the new cwd first.
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "turn_start" },
			{ sessionId, cwd: target, sessionFile: null },
		);
		const beforeRelocate = await readPayload(targetFile);
		expect(beforeRelocate.event).toBe("turn_start");

		await relocateCoordinatorRuntimeStateForRescope({ sessionId, cwd: target, sessionFile: null }, launcher);

		const afterRelocate = await readPayload(targetFile);
		expect(afterRelocate.event).toBe("turn_start");
		expect(afterRelocate.cwd).toBe(path.resolve(target));
		expect(fsSync.existsSync(launcherFile)).toBe(false);
	});

	it("issue-4629: an authenticated terminal destination survives a future-dated old running marker", async () => {
		delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
		const root = await tempRoot();
		const sessionId = "rescope-terminal-destination";
		const launcher = path.join(root, "launcher");
		const target = path.join(root, "target");
		await fs.mkdir(launcher);
		await fs.mkdir(target);
		const launcherFile = path.join(sessionRuntimeDir(launcher, sessionId), "runtime-state.json");
		const targetFile = path.join(sessionRuntimeDir(target, sessionId), "runtime-state.json");
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "agent_start" },
			{ sessionId, cwd: launcher, sessionFile: null },
		);
		const old = await readPayload(launcherFile);
		await Bun.write(launcherFile, `${JSON.stringify({ ...old, updated_at: "2099-01-01T00:00:00.000Z" })}\n`);
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "agent_start" },
			{ sessionId, cwd: target, sessionFile: null },
		);
		await persistCoordinatorRuntimeStateFromEvent(assistantEnd("done"), {
			sessionId,
			cwd: target,
			sessionFile: null,
		});

		expect(
			await relocateCoordinatorRuntimeStateForRescope({ sessionId, cwd: target, sessionFile: null }, launcher),
		).toBe(true);

		expect((await readPayload(targetFile)).state).toBe("completed");
		expect(fsSync.existsSync(launcherFile)).toBe(false);
	});

	it("issue-4629: pinned-path rescope rewrites the predecessor identity in place", async () => {
		// A pinned GJC_COORDINATOR_SESSION_STATE_FILE never moves with the cwd, so the
		// predecessor payload is rewritten in place to the new cwd.
		const root = await tempRoot();
		const stateFile = path.join(root, "pinned-runtime-state.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		const sessionId = "rescope-pinned";
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = sessionId;
		const launcher = path.join(root, "launcher");
		const target = path.join(launcher, "sub");
		await fs.mkdir(target, { recursive: true });

		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "agent_start" },
			{ sessionId, cwd: launcher, sessionFile: null },
		);
		expect((await readPayload(stateFile)).cwd).toBe(path.resolve(launcher));

		await relocateCoordinatorRuntimeStateForRescope({ sessionId, cwd: target, sessionFile: null }, launcher);
		expect((await readPayload(stateFile)).cwd).toBe(path.resolve(target));

		// The persist that would previously have been fenced now succeeds.
		await persistCoordinatorRuntimeStateFromEvent(assistantEnd("done"), {
			sessionId,
			cwd: target,
			sessionFile: null,
		});
		expect((await readPayload(stateFile)).state).toBe("completed");
	});

	it("issue-4629: rescope does not migrate a predecessor that fails old-identity authentication", async () => {
		// A payload at the old path whose recorded cwd/session_file does not match the claimed
		// pre-move identity is a foreign/tampered marker. Relocation must leave both paths
		// untouched rather than laundering it into an authoritative payload at the new cwd.
		delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
		const root = await tempRoot();
		const sessionId = "rescope-tamper";
		const launcher = path.join(root, "launcher");
		const target = path.join(launcher, "sub");
		await fs.mkdir(target, { recursive: true });
		const launcherFile = path.join(sessionRuntimeDir(launcher, sessionId), "runtime-state.json");
		const targetFile = path.join(sessionRuntimeDir(target, sessionId), "runtime-state.json");
		await fs.mkdir(path.dirname(launcherFile), { recursive: true });

		// Predecessor records a DIFFERENT cwd than the claimed pre-move launcher cwd.
		const foreign = {
			schema_version: 1,
			session_id: sessionId,
			state: "running",
			ready_for_input: false,
			live: true,
			cwd: path.join(root, "somewhere-else"),
			workdir: path.join(root, "somewhere-else"),
			session_file: null,
			updated_at: "2026-08-12T00:00:00.000Z",
		};
		await Bun.write(launcherFile, `${JSON.stringify(foreign)}\n`);
		const before = await Bun.file(launcherFile).text();

		await relocateCoordinatorRuntimeStateForRescope({ sessionId, cwd: target, sessionFile: null }, launcher);

		// Neither migrated to the new path nor removed from the old path.
		expect(fsSync.existsSync(targetFile)).toBe(false);
		expect(await Bun.file(launcherFile).text()).toBe(before);
	});

	it("issue-4629: rescope rejects an unsigned coordinator bootstrap seed without runtime identity", async () => {
		delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
		const root = await tempRoot();
		const sessionId = "rescope-bootstrap-seed";
		const launcher = path.join(root, "launcher");
		const target = path.join(launcher, "sub");
		await fs.mkdir(target, { recursive: true });
		const launcherFile = path.join(sessionRuntimeDir(launcher, sessionId), "runtime-state.json");
		const targetFile = path.join(sessionRuntimeDir(target, sessionId), "runtime-state.json");
		await fs.mkdir(path.dirname(launcherFile), { recursive: true });
		const bootstrapSeed = {
			schema_version: 1,
			session_id: sessionId,
			state: "running",
			source: "coordinator",
			current_turn_id: "turn-bootstrap",
		};
		await Bun.write(launcherFile, `${JSON.stringify(bootstrapSeed)}\n`);

		await relocateCoordinatorRuntimeStateForRescope({ sessionId, cwd: target, sessionFile: null }, launcher);

		expect(fsSync.existsSync(targetFile)).toBe(false);
		expect(await readPayload(launcherFile)).toEqual(bootstrapSeed);
	});

	it("issue-4629: rescope refuses a partial destination identity instead of retaining or replacing it", async () => {
		delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
		const root = await tempRoot();
		const sessionId = "rescope-forged-destination";
		const launcher = path.join(root, "launcher");
		const target = path.join(launcher, "sub");
		await fs.mkdir(target, { recursive: true });
		const launcherFile = path.join(sessionRuntimeDir(launcher, sessionId), "runtime-state.json");
		const targetFile = path.join(sessionRuntimeDir(target, sessionId), "runtime-state.json");
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "agent_start" },
			{ sessionId, cwd: launcher, sessionFile: null },
		);
		await fs.mkdir(path.dirname(targetFile), { recursive: true });
		const forgedDestination = {
			schema_version: 1,
			session_id: sessionId,
			state: "running",
			cwd: path.resolve(target),
		};
		await Bun.write(targetFile, `${JSON.stringify(forgedDestination)}\n`);
		const sourceBefore = await Bun.file(launcherFile).text();

		await relocateCoordinatorRuntimeStateForRescope({ sessionId, cwd: target, sessionFile: null }, launcher);

		expect(await readPayload(targetFile)).toEqual(forgedDestination);
		expect(await Bun.file(launcherFile).text()).toBe(sourceBefore);
	});

	it("issue-4629: rescope holds both state-file locks across destination publication and orphan cleanup", async () => {
		delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
		const root = await tempRoot();
		const sessionId = "rescope-dual-lock";
		const launcher = path.join(root, "launcher");
		const target = path.join(launcher, "sub");
		await fs.mkdir(target, { recursive: true });
		const launcherFile = path.join(sessionRuntimeDir(launcher, sessionId), "runtime-state.json");
		const targetFile = path.join(sessionRuntimeDir(target, sessionId), "runtime-state.json");
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "agent_start" },
			{ sessionId, cwd: launcher, sessionFile: null },
		);

		const locksAcquired = Promise.withResolvers<void>();
		const releaseRelocation = Promise.withResolvers<void>();
		__sessionStateSidecarTestHooks.afterRescopeLocksAcquired = async () => {
			locksAcquired.resolve();
			await releaseRelocation.promise;
		};
		const relocation = relocateCoordinatorRuntimeStateForRescope(
			{ sessionId, cwd: target, sessionFile: null },
			launcher,
		);
		await locksAcquired.promise;

		let oldWriterEntered = false;
		const oldWriter = withSessionStateFileLock(launcherFile, async () => {
			oldWriterEntered = true;
			if (await Bun.file(launcherFile).exists()) {
				const payload = await readPayload(launcherFile);
				await Bun.write(launcherFile, `${JSON.stringify({ ...payload, event: "racing_old_writer" })}\n`);
			}
		});
		await Bun.sleep(25);
		expect(oldWriterEntered).toBe(false);

		releaseRelocation.resolve();
		await relocation;
		await oldWriter;
		expect(oldWriterEntered).toBe(true);
		expect(fsSync.existsSync(launcherFile)).toBe(false);
		expect((await readPayload(targetFile)).cwd).toBe(path.resolve(target));
	});

	it("issue-4629: opposing rescopes take the same lock order and finish without duplicate markers", async () => {
		delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
		const root = await tempRoot();
		const sessionId = "rescope-opposing";
		const cwdA = path.join(root, "a");
		const cwdB = path.join(root, "b");
		await fs.mkdir(cwdA);
		await fs.mkdir(cwdB);
		const stateA = path.join(sessionRuntimeDir(cwdA, sessionId), "runtime-state.json");
		const stateB = path.join(sessionRuntimeDir(cwdB, sessionId), "runtime-state.json");
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "agent_start" },
			{ sessionId, cwd: cwdA, sessionFile: null },
		);

		const results = await Promise.all([
			relocateCoordinatorRuntimeStateForRescope({ sessionId, cwd: cwdB, sessionFile: null }, cwdA),
			relocateCoordinatorRuntimeStateForRescope({ sessionId, cwd: cwdA, sessionFile: null }, cwdB),
		]);

		expect(results).toEqual([true, true]);
		const existing = [stateA, stateB].filter(file => fsSync.existsSync(file));
		expect(existing).toHaveLength(1);
		const payload = await readPayload(existing[0]!);
		expect(payload.session_id).toBe(sessionId);
		expect(payload.cwd === path.resolve(cwdA) || payload.cwd === path.resolve(cwdB)).toBe(true);
	});

	it("issue-4629: atomic no-replace publication preserves a destination injected after authentication", async () => {
		delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
		const root = await tempRoot();
		const sessionId = "rescope-destination-race";
		const launcher = path.join(root, "launcher");
		const target = path.join(root, "target");
		await fs.mkdir(launcher);
		await fs.mkdir(target);
		const launcherFile = path.join(sessionRuntimeDir(launcher, sessionId), "runtime-state.json");
		const targetFile = path.join(sessionRuntimeDir(target, sessionId), "runtime-state.json");
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "agent_start" },
			{ sessionId, cwd: launcher, sessionFile: null },
		);
		const sourceBefore = await Bun.file(launcherFile).bytes();
		const injected = { foreign: true };
		__sessionStateSidecarTestHooks.beforeRescopePublish = async () => {
			await fs.mkdir(path.dirname(targetFile), { recursive: true });
			await Bun.write(targetFile, `${JSON.stringify(injected)}\n`);
		};

		await expect(
			relocateCoordinatorRuntimeStateForRescope({ sessionId, cwd: target, sessionFile: null }, launcher),
		).rejects.toThrow();

		expect(await readPayload(targetFile)).toEqual(injected);
		expect(await Bun.file(launcherFile).bytes()).toEqual(sourceBefore);
	});

	it("issue-4629: a source changed after authentication is retained for journal recovery", async () => {
		delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
		const root = await tempRoot();
		const sessionId = "rescope-source-race";
		const launcher = path.join(root, "launcher");
		const target = path.join(root, "target");
		await fs.mkdir(launcher);
		await fs.mkdir(target);
		const launcherFile = path.join(sessionRuntimeDir(launcher, sessionId), "runtime-state.json");
		const targetFile = path.join(sessionRuntimeDir(target, sessionId), "runtime-state.json");
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "agent_start" },
			{ sessionId, cwd: launcher, sessionFile: null },
		);
		await prepareCoordinatorRuntimeStateRescope({
			sessionId,
			previousCwd: launcher,
			newCwd: target,
			previousSessionFile: null,
			newSessionFile: null,
		});
		__sessionStateSidecarTestHooks.beforeRescopePublish = async () => {
			const current = await readPayload(launcherFile);
			await Bun.write(
				launcherFile,
				`${JSON.stringify({ ...current, event: "newer_old_writer", updated_at: new Date(Date.now() + 1000).toISOString() })}\n`,
			);
		};

		expect(
			await relocateCoordinatorRuntimeStateForRescope({ sessionId, cwd: target, sessionFile: null }, launcher),
		).toBe(false);

		expect((await readPayload(launcherFile)).event).toBe("newer_old_writer");
		expect((await readPayload(targetFile)).event).toBe("move_session");
		__sessionStateSidecarTestHooks.beforeRescopePublish = undefined;
		await expect(
			recoverCoordinatorRuntimeStateRescope({ sessionId, cwd: target, sessionFile: null }),
		).rejects.toThrow();
		expect((await readPayload(launcherFile)).event).toBe("newer_old_writer");
		expect((await readPayload(targetFile)).event).toBe("move_session");
		expect(fsSync.existsSync(path.join(sessionRuntimeDir(target, sessionId), "runtime-state-rescope.json"))).toBe(
			true,
		);
	});

	it("issue-4629: rescope does not touch a foreign session_id at either path", async () => {
		delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
		const root = await tempRoot();
		const sessionId = "rescope-owner";
		const launcher = path.join(root, "launcher");
		const target = path.join(launcher, "sub");
		await fs.mkdir(target, { recursive: true });
		const launcherFile = path.join(sessionRuntimeDir(launcher, sessionId), "runtime-state.json");
		await fs.mkdir(path.dirname(launcherFile), { recursive: true });
		const otherSession = {
			schema_version: 1,
			session_id: "a-different-session",
			state: "running",
			ready_for_input: false,
			live: true,
			cwd: path.resolve(launcher),
			workdir: path.resolve(launcher),
			session_file: null,
			updated_at: "2026-08-12T00:00:00.000Z",
		};
		await Bun.write(launcherFile, `${JSON.stringify(otherSession)}\n`);
		const before = await Bun.file(launcherFile).text();

		await relocateCoordinatorRuntimeStateForRescope({ sessionId, cwd: target, sessionFile: null }, launcher);

		expect(fsSync.existsSync(path.join(sessionRuntimeDir(target, sessionId), "runtime-state.json"))).toBe(false);
		expect(await Bun.file(launcherFile).text()).toBe(before);
	});

	it("issue-4629: rescope refuses a symlinked predecessor without reading or removing its target", async () => {
		delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
		const root = await tempRoot();
		const sessionId = "rescope-symlink-source";
		const launcher = path.join(root, "launcher");
		const target = path.join(launcher, "sub");
		await fs.mkdir(target, { recursive: true });
		const launcherFile = path.join(sessionRuntimeDir(launcher, sessionId), "runtime-state.json");
		const targetFile = path.join(sessionRuntimeDir(target, sessionId), "runtime-state.json");
		const externalFile = path.join(root, "external-state.json");
		await fs.mkdir(path.dirname(launcherFile), { recursive: true });
		const external = {
			schema_version: 1,
			session_id: sessionId,
			state: "running",
			cwd: path.resolve(launcher),
			workdir: path.resolve(launcher),
			session_file: null,
		};
		await Bun.write(externalFile, `${JSON.stringify(external)}\n`);
		await fs.symlink(externalFile, launcherFile);
		const before = await Bun.file(externalFile).bytes();

		await expect(
			relocateCoordinatorRuntimeStateForRescope({ sessionId, cwd: target, sessionFile: null }, launcher),
		).rejects.toThrow();

		expect(fsSync.lstatSync(launcherFile).isSymbolicLink()).toBe(true);
		expect(await Bun.file(externalFile).bytes()).toEqual(before);
		expect(fsSync.existsSync(targetFile)).toBe(false);
	});

	it("issue-4629: direct relocation deduplicates a symlink cwd alias to one physical state path", async () => {
		delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
		const root = await tempRoot();
		const sessionId = "rescope-cwd-alias";
		const cwd = path.join(root, "real");
		const alias = path.join(root, "alias");
		await fs.mkdir(cwd);
		await fs.symlink(cwd, alias);
		const stateFile = path.join(sessionRuntimeDir(cwd, sessionId), "runtime-state.json");
		await persistCoordinatorRuntimeStateFromEvent({ type: "agent_start" }, { sessionId, cwd, sessionFile: null });

		expect(await relocateCoordinatorRuntimeStateForRescope({ sessionId, cwd: alias, sessionFile: null }, cwd)).toBe(
			true,
		);

		expect(fsSync.existsSync(stateFile)).toBe(true);
		expect((await readPayload(stateFile)).cwd).toBe(path.resolve(cwd));
	});

	it("issue-4629: a persist concurrent with relocation serializes without corrupting the new-cwd payload", async () => {
		// Relocation and a racing persist both take the new-path critical section, so the
		// result is one consistent payload keyed to the new cwd, never interleaved bytes.
		delete process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV];
		const root = await tempRoot();
		const sessionId = "rescope-concurrent";
		const launcher = path.join(root, "launcher");
		const target = path.join(launcher, "sub");
		await fs.mkdir(target, { recursive: true });
		const targetFile = path.join(sessionRuntimeDir(target, sessionId), "runtime-state.json");

		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "agent_start" },
			{ sessionId, cwd: launcher, sessionFile: null },
		);

		await Promise.all([
			relocateCoordinatorRuntimeStateForRescope({ sessionId, cwd: target, sessionFile: null }, launcher),
			persistCoordinatorRuntimeStateFromEvent({ type: "turn_start" }, { sessionId, cwd: target, sessionFile: null }),
		]);

		// The file parses cleanly and is keyed to the new cwd regardless of interleaving.
		const payload = await readPayload(targetFile);
		expect(payload.session_id).toBe(sessionId);
		expect(payload.cwd).toBe(path.resolve(target));
		// And a subsequent persist at the new cwd still succeeds (fence unblocked).
		await persistCoordinatorRuntimeStateFromEvent(assistantEnd("done"), {
			sessionId,
			cwd: target,
			sessionFile: null,
		});
		expect((await readPayload(targetFile)).state).toBe("completed");
	});

	it("issue-4351: completed session reports ready_for_input false with authoritative ended_at", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "issue-4351-completed.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "issue-4351-completed";
		await Bun.write(
			stateFile,
			`${JSON.stringify({
				schema_version: 1,
				session_id: "issue-4351-completed",
				state: "running",
				ready_for_input: false,
				cwd: root,
				workdir: root,
				session_file: null,
				current_turn_id: "turn-final",
				last_turn_id: "turn-prev",
				live: true,
				updated_at: "2026-08-12T00:00:00.000Z",
				reason: null,
			})}\n`,
		);

		await persistCoordinatorRuntimeStateFromEvent(assistantEnd("done"), {
			sessionId: "issue-4351-completed",
			cwd: root,
			sessionFile: null,
		});

		const payload = await readPayload(stateFile);
		expect(payload.state).toBe("completed");
		expect(payload.ready_for_input).toBe(false);
		expect(payload.live).toBe(false);
		expect(typeof payload.ended_at).toBe("string");
		expect(Number.isFinite(Date.parse(payload.ended_at as string))).toBe(true);
	});

	it("issue-4351: errored session reports ready_for_input false", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "issue-4351-errored.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "issue-4351-errored";
		await Bun.write(
			stateFile,
			`${JSON.stringify({
				schema_version: 1,
				session_id: "issue-4351-errored",
				state: "running",
				ready_for_input: false,
				cwd: root,
				workdir: root,
				session_file: null,
				current_turn_id: null,
				last_turn_id: null,
				live: true,
				updated_at: "2026-08-12T00:00:00.000Z",
				reason: null,
			})}\n`,
		);

		await persistCoordinatorRuntimeStateFromEvent(assistantEnd("boom", "error"), {
			sessionId: "issue-4351-errored",
			cwd: root,
			sessionFile: null,
		});

		const payload = await readPayload(stateFile);
		expect(payload.state).toBe("errored");
		expect(payload.ready_for_input).toBe(false);
		expect(payload.live).toBe(false);
	});

	it("issue-4351: validation rejects a stale completed+ready_for_input:true marker", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "issue-4351-stale.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		process.env[GJC_COORDINATOR_SESSION_ID_ENV] = "issue-4351-stale";
		// A pre-fix marker with the contradictory completed + ready_for_input: true.
		await Bun.write(
			stateFile,
			`${JSON.stringify({
				schema_version: 1,
				session_id: "issue-4351-stale",
				state: "completed",
				ready_for_input: true,
				cwd: root,
				workdir: root,
				session_file: null,
				current_turn_id: null,
				last_turn_id: null,
				live: false,
				updated_at: "2026-08-11T00:00:00.000Z",
				reason: null,
			})}\n`,
		);

		// The stale marker must be rejected; the runtime must not silently preserve it.
		await expect(
			persistCoordinatorRuntimeStateFromEvent(assistantEnd("re-assert completion"), {
				sessionId: "issue-4351-stale",
				cwd: root,
				sessionFile: null,
			}),
		).rejects.toThrow();
	});
});

describe("coordinator runtime tool activity", () => {
	const SESSION_ID = "activity-session";
	const T0 = "2026-03-01T00:00:00.000Z";

	/** One seeded running session per test: env, a lifecycle write at T0, and its state file. */
	async function runningSession(name: string): Promise<string> {
		const root = await tempRoot();
		const stateFile = path.join(root, `${name}.json`);
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;
		setSystemTime(new Date(T0));
		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "turn_start" },
			{ sessionId: SESSION_ID, cwd: root, sessionFile: null },
		);
		return stateFile;
	}

	function context(stateFile: string) {
		return { sessionId: SESSION_ID, cwd: path.dirname(stateFile), sessionFile: null };
	}

	/**
	 * Emit one tool event carrying the observation the AgentSession boundary would have
	 * captured: the wall clock read there, and the label it proved for a START.
	 */
	async function toolEvent(
		stateFile: string,
		phase: "start" | "end",
		input: { at: string; callId?: unknown; label?: string; isError?: boolean; extra?: Record<string, unknown> },
	): Promise<void> {
		setSystemTime(new Date(input.at));
		await persistCoordinatorRuntimeStateFromEvent(
			{
				type: phase === "start" ? "tool_execution_start" : "tool_execution_end",
				toolCallId: input.callId,
				...(phase === "end" ? { isError: input.isError === true } : {}),
				...input.extra,
			} as Parameters<typeof persistCoordinatorRuntimeStateFromEvent>[0],
			context(stateFile),
			{ label: input.label ?? "custom", observedAt: input.at },
		);
	}

	async function activityOf(stateFile: string): Promise<Record<string, unknown>> {
		return (await readJson(stateFile)).activity as Record<string, unknown>;
	}

	it("records a bounded started snapshot without advancing the lifecycle heartbeat", async () => {
		const stateFile = await runningSession("activity-start");

		await toolEvent(stateFile, "start", { at: "2026-03-01T00:00:01.000Z", callId: "call-1", label: "bash" });

		expect(await readJson(stateFile)).toMatchObject({
			state: "running",
			// The heartbeat cadence is measured from lifecycle writes, so an activity
			// annotation must not advance updated_at.
			updated_at: T0,
			activity: {
				seq: 1,
				phase: "started",
				tool: "bash",
				outcome: null,
				elapsed_ms: null,
				last_activity_at: "2026-03-01T00:00:01.000Z",
				active_tool_count: 1,
				active_tools: [{ tool: "bash", started_at: "2026-03-01T00:00:01.000Z" }],
			},
		});
	});

	for (const { name, isError, outcome } of [
		{ name: "success", isError: false, outcome: "success" },
		{ name: "failure", isError: true, outcome: "failure" },
	]) {
		it(`closes a matching tool_execution_end as ${name} with elapsed time and a bumped sequence`, async () => {
			const stateFile = await runningSession(`activity-end-${name}`);

			await toolEvent(stateFile, "start", { at: "2026-03-01T00:00:01.000Z", callId: "call-1", label: "read" });
			await toolEvent(stateFile, "end", {
				at: "2026-03-01T00:00:03.500Z",
				callId: "call-1",
				label: "read",
				isError,
			});

			expect(await activityOf(stateFile)).toMatchObject({
				seq: 2,
				last_activity_at: "2026-03-01T00:00:03.500Z",
				tool: "read",
				phase: "finished",
				outcome,
				elapsed_ms: 2500,
				active_tool_count: 0,
				active_tools: [],
			});
		});
	}

	it("ignores the raw model tool name and records custom when no proven label is supplied", async () => {
		const stateFile = await runningSession("activity-untrusted-label");

		await toolEvent(stateFile, "start", {
			at: "2026-03-01T00:00:01.000Z",
			callId: "call-1",
			extra: { toolName: "PROMPT_SECRET_123" },
		});

		const raw = await Bun.file(stateFile).text();
		expect(raw).not.toContain("PROMPT_SECRET_123");
		expect(await activityOf(stateFile)).toMatchObject({ tool: "custom", active_tools: [{ tool: "custom" }] });
	});

	it("preserves the last activity snapshot and sequence across a lifecycle write", async () => {
		const stateFile = await runningSession("activity-preserve");

		await toolEvent(stateFile, "start", { at: "2026-03-01T00:00:01.000Z", callId: "call-1", label: "edit" });
		setSystemTime(new Date("2026-03-01T00:00:05.000Z"));
		await persistCoordinatorRuntimeStateFromEvent({ type: "turn_start" }, context(stateFile));

		const afterLifecycle = await readJson(stateFile);
		expect(afterLifecycle.updated_at).toBe("2026-03-01T00:00:05.000Z");
		expect(afterLifecycle.activity).toMatchObject({ seq: 1, tool: "edit", active_tool_count: 1 });

		// The preserved sequence is the base for the next activity event, so the
		// per-session sequence stays monotonic across lifecycle transitions.
		await toolEvent(stateFile, "end", { at: "2026-03-01T00:00:06.000Z", callId: "call-1", label: "edit" });
		expect(await activityOf(stateFile)).toMatchObject({ seq: 2, phase: "finished", elapsed_ms: 5000 });
	});

	it("settles orphaned active tools when the runtime reaches agent_end", async () => {
		const stateFile = await runningSession("activity-terminal");

		await toolEvent(stateFile, "start", { at: "2026-03-01T00:00:01.000Z", callId: "call-1", label: "bash" });
		setSystemTime(new Date("2026-03-01T00:00:02.000Z"));
		await persistCoordinatorRuntimeStateFromEvent(assistantEnd("done"), context(stateFile));
		const terminal = await readJson(stateFile);

		await toolEvent(stateFile, "start", { at: "2026-03-01T00:00:09.000Z", callId: "call-late", label: "bash" });
		await toolEvent(stateFile, "end", { at: "2026-03-01T00:00:10.000Z", callId: "call-late", label: "bash" });

		// A settled session cannot still be running a tool. The orphan is reported as
		// cancelled — never as a success or failure nothing observed — and the sequence
		// advances so a reader can see the settlement happened.
		expect(terminal).toMatchObject({
			state: "completed",
			activity: {
				seq: 2,
				last_activity_at: "2026-03-01T00:00:02.000Z",
				tool: "bash",
				phase: "finished",
				outcome: "cancelled",
				elapsed_ms: null,
				active_tool_count: 0,
				active_tools: [],
				in_flight: [],
			},
		});
		// Later tool events remain fenced and cannot resurrect the session.
		expect(await readJson(stateFile)).toEqual(terminal);
	});

	it("preserves the previous activity when a terminal transition has nothing in flight", async () => {
		const stateFile = await runningSession("activity-terminal-settled");

		await toolEvent(stateFile, "start", { at: "2026-03-01T00:00:01.000Z", callId: "call-1", label: "bash" });
		await toolEvent(stateFile, "end", { at: "2026-03-01T00:00:02.000Z", callId: "call-1", label: "bash" });
		const before = await activityOf(stateFile);
		setSystemTime(new Date("2026-03-01T00:00:03.000Z"));
		await persistCoordinatorRuntimeStateFromEvent(assistantEnd("done"), context(stateFile));

		const after = await readJson(stateFile);
		expect(after.state).toBe("completed");
		expect(after.activity).toEqual(before);
	});

	it("keeps a malformed activity snapshot hidden rather than re-seeding it at a terminal transition", async () => {
		const stateFile = await runningSession("activity-terminal-malformed");
		await toolEvent(stateFile, "start", { at: "2026-03-01T00:00:01.000Z", callId: "call-1", label: "bash" });
		const payload = await readJson(stateFile);
		payload.activity = { ...(payload.activity as Record<string, unknown>), phase: "exfiltrating" };
		await Bun.write(stateFile, `${JSON.stringify(payload)}\n`);

		setSystemTime(new Date("2026-03-01T00:00:04.000Z"));
		await persistCoordinatorRuntimeStateFromEvent(assistantEnd("done"), context(stateFile));

		const after = await readJson(stateFile);
		expect(after.state).toBe("completed");
		expect(after.activity).toEqual(payload.activity);
		expect(publicRuntimeToolActivity(after.activity, after.state)).toBeNull();
	});

	it("settles an uncorrelated started snapshot at a terminal transition", async () => {
		const stateFile = await runningSession("activity-terminal-uncorrelated");
		// A start whose call id carries no correlation: the phase advances but nothing
		// enters the in-flight table, so no later end can ever close it.
		await toolEvent(stateFile, "start", { at: "2026-03-01T00:00:01.000Z", callId: "   ", label: "bash" });
		expect(await activityOf(stateFile)).toMatchObject({ phase: "started", active_tool_count: 0 });

		setSystemTime(new Date("2026-03-01T00:00:05.000Z"));
		await persistCoordinatorRuntimeStateFromEvent(assistantEnd("done"), context(stateFile));

		const after = await readJson(stateFile);
		expect(after.state).toBe("completed");
		// A settled session cannot still be starting a tool, so the writer must not leave
		// the prohibited terminal+started pair on disk for a reader to hide.
		expect(after.activity).toMatchObject({ phase: "finished", outcome: "cancelled", elapsed_ms: null });
		expect(publicRuntimeToolActivity(after.activity, after.state)).toMatchObject({
			phase: "finished",
			outcome: "cancelled",
		});
	});

	it("keeps exact accounting above the public cap and drains back to zero", async () => {
		const stateFile = await runningSession("activity-accounting");

		// Far more concurrent calls than the public list holds. The private set is
		// current state, not history, so none of them may be silently dropped.
		const LIVE_CALLS = 65;
		for (let index = 0; index < LIVE_CALLS; index++) {
			await toolEvent(stateFile, "start", {
				at: new Date(Date.UTC(2026, 2, 1, 0, 0, index + 1)).toISOString(),
				callId: `call-${index}`,
				label: "bash",
			});
		}
		const started = await activityOf(stateFile);
		expect(started).toMatchObject({ seq: LIVE_CALLS, active_tool_count: LIVE_CALLS });
		expect((started.active_tools as unknown[]).length).toBe(8);
		expect((started.in_flight as unknown[]).length).toBe(LIVE_CALLS);

		// A duplicate start for a live call is idempotent; it never double-counts.
		await toolEvent(stateFile, "start", { at: "2026-03-01T00:02:00.000Z", callId: "call-0", label: "bash" });
		expect(await activityOf(stateFile)).toMatchObject({ seq: 66, active_tool_count: LIVE_CALLS });

		// call-0 is far outside the public top 8, but ending it still removes exactly
		// one entry from the exact total.
		await toolEvent(stateFile, "end", { at: "2026-03-01T00:02:01.000Z", callId: "call-0", label: "bash" });
		expect(await activityOf(stateFile)).toMatchObject({ seq: 67, active_tool_count: 64, elapsed_ms: 120_000 });

		// A duplicate end and an unmatched end change nothing but the snapshot header.
		await toolEvent(stateFile, "end", { at: "2026-03-01T00:02:02.000Z", callId: "call-0", label: "bash" });
		await toolEvent(stateFile, "end", { at: "2026-03-01T00:02:03.000Z", callId: "never-started", label: "bash" });
		expect(await activityOf(stateFile)).toMatchObject({ seq: 69, active_tool_count: 64, elapsed_ms: null });

		// A missing call id cannot correlate, so it must not corrupt accounting.
		await toolEvent(stateFile, "start", { at: "2026-03-01T00:02:04.000Z", label: "bash" });
		await toolEvent(stateFile, "end", { at: "2026-03-01T00:02:05.000Z", callId: "   ", label: "bash" });
		expect(await activityOf(stateFile)).toMatchObject({ seq: 71, active_tool_count: 64 });

		// Ending every remaining live call drains the set to exactly zero.
		for (let index = 1; index < LIVE_CALLS; index++) {
			await toolEvent(stateFile, "end", {
				at: new Date(Date.UTC(2026, 2, 1, 0, 3, index)).toISOString(),
				callId: `call-${index}`,
				label: "bash",
			});
		}
		const drained = await activityOf(stateFile);
		expect(drained).toMatchObject({ active_tool_count: 0, active_tools: [], in_flight: [] });
	}, 15_000);

	it("keeps distinct whitespace-bearing call ids distinct", async () => {
		const stateFile = await runningSession("activity-whitespace-ids");

		await toolEvent(stateFile, "start", { at: "2026-03-01T00:00:01.000Z", callId: " call-a", label: "bash" });
		await toolEvent(stateFile, "start", { at: "2026-03-01T00:00:02.000Z", callId: "call-a ", label: "bash" });
		expect(await activityOf(stateFile)).toMatchObject({ active_tool_count: 2 });

		// Ending one exact id closes exactly one correlation, never both.
		await toolEvent(stateFile, "end", { at: "2026-03-01T00:00:03.000Z", callId: " call-a", label: "bash" });
		expect(await activityOf(stateFile)).toMatchObject({ active_tool_count: 1, elapsed_ms: 2000 });
	});

	it("keeps call ids that differ only by an unpaired surrogate distinct", async () => {
		const stateFile = await runningSession("activity-surrogate-ids");

		// Two DIFFERENT lone surrogates. UTF-8 encoding replaces each with the same
		// replacement character, so a UTF-8 digest would fuse these into one correlation
		// slot and let one call's end close the other's.
		await toolEvent(stateFile, "start", { at: "2026-03-01T00:00:01.000Z", callId: "call-\ud800", label: "bash" });
		await toolEvent(stateFile, "start", { at: "2026-03-01T00:00:02.000Z", callId: "call-\ud801", label: "bash" });
		const started = await activityOf(stateFile);
		expect(started).toMatchObject({ active_tool_count: 2 });
		const digests = (started.in_flight as Array<{ digest: string }>).map(entry => entry.digest);
		expect(new Set(digests).size).toBe(2);
		for (const digest of digests) expect(digest).toMatch(/^[0-9a-f]{64}$/);

		await toolEvent(stateFile, "end", { at: "2026-03-01T00:00:03.000Z", callId: "call-\ud800", label: "bash" });
		expect(await activityOf(stateFile)).toMatchObject({ active_tool_count: 1, elapsed_ms: 2000 });
	});

	it("persists a full-length correlation digest, never a truncated prefix", async () => {
		const stateFile = await runningSession("activity-digest-length");

		await toolEvent(stateFile, "start", { at: "2026-03-01T00:00:01.000Z", callId: "call-1", label: "bash" });

		const inFlight = (await activityOf(stateFile)).in_flight as Array<{ digest: string }>;
		expect(inFlight).toHaveLength(1);
		expect(inFlight[0]?.digest).toMatch(/^[0-9a-f]{64}$/);
	});

	it("does not seed a state file from a tool event alone", async () => {
		const root = await tempRoot();
		const stateFile = path.join(root, "activity-unseeded.json");
		process.env[GJC_COORDINATOR_SESSION_STATE_FILE_ENV] = stateFile;

		await persistCoordinatorRuntimeStateFromEvent(
			{ type: "tool_execution_start", toolCallId: "call-1" },
			context(stateFile),
			{ label: "bash", observedAt: "2026-03-01T00:00:01.000Z" },
		);

		expect(await Bun.file(stateFile).exists()).toBe(false);
	});

	it("persists no tool arguments, results, raw call ids, or correlation digests", async () => {
		const stateFile = await runningSession("activity-privacy");

		await toolEvent(stateFile, "start", {
			at: "2026-03-01T00:00:01.000Z",
			callId: "toolu_RAWCALLID",
			label: "bash",
			extra: { toolName: "bash", args: { command: "printf SECRET_TOKEN", cwd: "/home/agent/private" } },
		});
		await toolEvent(stateFile, "end", {
			at: "2026-03-01T00:00:02.000Z",
			callId: "toolu_RAWCALLID",
			label: "bash",
			extra: { result: { content: [{ type: "text", text: "SECRET_TOKEN" }] } },
		});

		const raw = await Bun.file(stateFile).text();
		expect(raw).not.toContain("SECRET_TOKEN");
		expect(raw).not.toContain("printf");
		expect(raw).not.toContain("/home/agent/private");
		expect(raw).not.toContain("toolu_RAWCALLID");
		expect(raw).not.toContain("args");
		expect(raw).not.toContain("result");
		// The private correlation state never reaches a public projection.
		const publicActivity = publicRuntimeToolActivity((await readJson(stateFile)).activity, "running");
		expect(JSON.stringify(publicActivity)).not.toContain("digest");
		expect(Object.keys(publicActivity ?? {})).not.toContain("in_flight");
	});

	it("refuses to overwrite a malformed activity snapshot with a lower sequence", async () => {
		const stateFile = await runningSession("activity-malformed");
		await toolEvent(stateFile, "start", { at: "2026-03-01T00:00:01.000Z", callId: "call-1", label: "bash" });

		const payload = await readJson(stateFile);
		// A valid prior sequence with a phase the reader cannot trust.
		payload.activity = { ...(payload.activity as Record<string, unknown>), phase: "exfiltrating" };
		await Bun.write(stateFile, `${JSON.stringify(payload)}\n`);

		await expect(
			toolEvent(stateFile, "start", { at: "2026-03-01T00:00:02.000Z", callId: "call-2", label: "bash" }),
		).rejects.toThrow(/refus/i);
		expect(await readJson(stateFile)).toEqual(payload);
	});

	it("refuses an activity write whose sequence cannot advance safely", async () => {
		const stateFile = await runningSession("activity-overflow");
		await toolEvent(stateFile, "start", { at: "2026-03-01T00:00:01.000Z", callId: "call-1", label: "bash" });

		const payload = await readJson(stateFile);
		payload.activity = { ...(payload.activity as Record<string, unknown>), seq: Number.MAX_SAFE_INTEGER };
		await Bun.write(stateFile, `${JSON.stringify(payload)}\n`);

		await expect(
			toolEvent(stateFile, "end", { at: "2026-03-01T00:00:02.000Z", callId: "call-1", label: "bash" }),
		).rejects.toThrow(/refus/i);
		expect((await readJson(stateFile)).activity).toMatchObject({ seq: Number.MAX_SAFE_INTEGER });
	});

	it("timestamps tool activity from event observation, not from lock acquisition", async () => {
		const stateFile = await runningSession("activity-lock-delay");
		const observed = { start: "", end: "" };

		// Both events observe their wall clock before the lock is contended; only
		// persistence is delayed, so elapsed must describe the events themselves.
		FileLockTestHooks.afterParentMkdir = async lockPath => {
			// The namespace transaction lock is the one directory-style lock left on this
			// path; the state file itself uses the shared regular-file owner protocol.
			if (!lockPath.endsWith(`mutation.lock.lock`)) return;
			setSystemTime(new Date("2026-03-01T00:05:00.000Z"));
			await Bun.sleep(5);
		};
		observed.start = "2026-03-01T00:00:01.000Z";
		await toolEvent(stateFile, "start", { at: observed.start, callId: "call-1", label: "bash" });
		observed.end = "2026-03-01T00:00:02.500Z";
		await toolEvent(stateFile, "end", { at: observed.end, callId: "call-1", label: "bash" });

		expect(await activityOf(stateFile)).toMatchObject({
			last_activity_at: observed.end,
			elapsed_ms: 1500,
		});
	});

	/**
	 * The reader refuses an `elapsed_ms` outside the safe-integer range, because beyond it
	 * a millisecond count is no longer exact and so was never measured. The writer must
	 * therefore not be able to produce one: two canonical timestamps at the extremes of the
	 * representable range are 1.728e16 ms apart, and persisting that would leave the writer
	 * holding bytes its own validator calls malformed — which fences out every later
	 * activity write on this session.
	 */
	it("persists a null elapsed rather than a duration its own reader would reject", async () => {
		const stateFile = await runningSession("activity-elapsed-overflow");
		const start = "-271821-04-20T00:00:00.000Z";
		const end = "+275760-09-13T00:00:00.000Z";
		expect(new Date(start).toISOString()).toBe(start);
		expect(new Date(end).toISOString()).toBe(end);
		expect(Number.isSafeInteger(Date.parse(end) - Date.parse(start))).toBe(false);

		await toolEvent(stateFile, "start", { at: start, callId: "call-1", label: "bash" });
		await toolEvent(stateFile, "end", { at: end, callId: "call-1", label: "bash" });

		// Not saturated to MAX_SAFE_INTEGER, and not refused: the outcome is still the one
		// that was observed, with the interval reported as unmeasured.
		const finished = await activityOf(stateFile);
		expect(finished).toMatchObject({ seq: 2, phase: "finished", outcome: "success", elapsed_ms: null });

		// The writer's own strict reader accepts what it just wrote, and the snapshot is
		// still publicly projectable.
		expect(classifyRuntimeToolActivity(finished).kind).toBe("valid");
		expect(publicRuntimeToolActivity(finished, "running")).toMatchObject({
			seq: 2,
			tool: "bash",
			phase: "finished",
			elapsed_ms: null,
		});

		// And the next write is accepted rather than fenced out by this writer's own bytes.
		await toolEvent(stateFile, "start", { at: "2026-03-01T00:00:03.000Z", callId: "call-2", label: "bash" });
		expect(await activityOf(stateFile)).toMatchObject({ seq: 3, phase: "started", tool: "bash" });
	});

	it("keeps measuring an ordinary interval exactly", async () => {
		const stateFile = await runningSession("activity-elapsed-ordinary");

		await toolEvent(stateFile, "start", { at: "2026-03-01T00:00:01.000Z", callId: "call-1", label: "bash" });
		await toolEvent(stateFile, "end", { at: "2026-03-01T00:00:03.250Z", callId: "call-1", label: "bash" });

		expect(await activityOf(stateFile)).toMatchObject({ phase: "finished", outcome: "success", elapsed_ms: 2250 });
	});
	it("refuses the next activity write after malformed bytes, without touching them", async () => {
		const stateFile = await runningSession("activity-refuse-preserves-bytes");
		await toolEvent(stateFile, "start", { at: "2026-03-01T00:00:01.000Z", callId: "call-1", label: "bash" });
		const payload = await readJson(stateFile);
		payload.activity = { ...(payload.activity as Record<string, unknown>), elapsed_ms: -1, phase: "finished" };
		const corruptBytes = `${JSON.stringify(payload)}\n`;
		await Bun.write(stateFile, corruptBytes);

		await expect(
			toolEvent(stateFile, "start", { at: "2026-03-01T00:00:02.000Z", callId: "call-2", label: "bash" }),
		).rejects.toThrow(/refus/i);
		expect(await Bun.file(stateFile).text()).toBe(corruptBytes);
	});
});

describe("persisted runtime tool activity validation", () => {
	const AT = "2026-03-01T00:00:02.000Z";
	const DIGEST_A = `a${"0".repeat(63)}`;
	const DIGEST_B = `b${"1".repeat(63)}`;

	function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			seq: 4,
			last_activity_at: AT,
			tool: "bash",
			phase: "started",
			outcome: null,
			elapsed_ms: null,
			active_tool_count: 1,
			active_tools: [{ tool: "bash", started_at: AT }],
			in_flight: [{ digest: DIGEST_A, tool: "bash", started_at: AT }],
			...overrides,
		};
	}

	it("accepts a snapshot this writer could have produced", () => {
		const valid = snapshot();
		const readout = classifyRuntimeToolActivity(valid);
		expect(readout.kind).toBe("valid");
		expect(readout.kind === "valid" && readout.activity).toEqual(valid as never);
	});

	it("distinguishes an absent snapshot from a malformed one", () => {
		expect(classifyRuntimeToolActivity(undefined)).toEqual({ kind: "absent" });
		expect(classifyRuntimeToolActivity(null)).toEqual({ kind: "malformed" });
		expect(classifyRuntimeToolActivity([])).toEqual({ kind: "malformed" });
	});

	for (const { name, overrides } of [
		{ name: "an out-of-range sequence", overrides: { seq: 0 } },
		{ name: "a non-integer sequence", overrides: { seq: 1.5 } },
		{ name: "an unparseable phase", overrides: { phase: "exfiltrating" } },
		{ name: "an unproven tool label", overrides: { tool: "cat /etc/passwd" } },
		// A label is safe because the writer proved it against the closed built-in
		// descriptor set, not because it happens to look like a bare token.
		{ name: "an arbitrary token-shaped label", overrides: { tool: "curl" } },
		{ name: "an unknown root key", overrides: { raw_id: "toolu_RAWCALLID" } },
		{
			name: "an unknown key on a private row",
			overrides: { in_flight: [{ digest: DIGEST_A, tool: "bash", started_at: AT, args: { command: "id" } }] },
		},
		{
			name: "an unknown key on a public row",
			overrides: { active_tools: [{ tool: "bash", started_at: AT, credential: "sk-live" }] },
		},
		{
			name: "an elapsed time beyond exact integer range",
			overrides: { phase: "finished", outcome: "success", elapsed_ms: Number.MAX_SAFE_INTEGER + 2 },
		},
		{
			name: "a cancelled outcome still claiming a live call",
			overrides: { phase: "finished", outcome: "cancelled", elapsed_ms: null },
		},
		{
			name: "a non-canonical snapshot timestamp",
			overrides: { last_activity_at: "2026-03-01T00:00:02Z" },
		},
		{
			name: "a non-canonical start timestamp",
			overrides: { in_flight: [{ digest: DIGEST_A, tool: "bash", started_at: "2026-03-01 00:00:02" }] },
		},
		{
			name: "an invalid private row",
			overrides: { in_flight: [{ digest: DIGEST_A, tool: "bash", started_at: AT }, { tool: "bash" }] },
		},
		{
			name: "a truncated digest",
			overrides: { in_flight: [{ digest: DIGEST_A.slice(0, 16), tool: "bash", started_at: AT }] },
		},
		{
			name: "an unproven label on a private row",
			overrides: { in_flight: [{ digest: DIGEST_A, tool: "rm -rf /", started_at: AT }] },
		},
		{
			name: "duplicate digests",
			overrides: {
				active_tool_count: 2,
				active_tools: [
					{ tool: "bash", started_at: AT },
					{ tool: "bash", started_at: AT },
				],
				in_flight: [
					{ digest: DIGEST_A, tool: "bash", started_at: AT },
					{ digest: DIGEST_A, tool: "bash", started_at: AT },
				],
			},
		},
		{ name: "a count contradicting the private set", overrides: { active_tool_count: 5 } },
		{ name: "a list contradicting the private set", overrides: { active_tools: [{ tool: "edit", started_at: AT }] } },
		{ name: "a started phase carrying an outcome", overrides: { outcome: "success" } },
		{ name: "a started phase carrying an elapsed time", overrides: { elapsed_ms: 10 } },
		{ name: "a finished phase with no outcome", overrides: { phase: "finished", outcome: null } },
		{
			name: "a finished phase with an unlisted outcome",
			overrides: { phase: "finished", outcome: "exfiltrated" },
		},
		{
			name: "a cancelled outcome claiming a measured interval",
			overrides: { phase: "finished", outcome: "cancelled", elapsed_ms: 10 },
		},
		{
			name: "a negative elapsed time",
			overrides: { phase: "finished", outcome: "success", elapsed_ms: -1 },
		},
		{
			name: "a fractional elapsed time",
			overrides: { phase: "finished", outcome: "success", elapsed_ms: 1.5 },
		},
	]) {
		it(`refuses a snapshot with ${name}`, () => {
			expect(classifyRuntimeToolActivity(snapshot(overrides))).toEqual({ kind: "malformed" });
			expect(publicRuntimeToolActivity(snapshot(overrides), "running")).toBeNull();
		});
	}

	it("accepts the honest shapes a settled or unmatched call produces", () => {
		for (const overrides of [
			// A cancelled snapshot is only ever written with the in-flight set emptied.
			{ phase: "finished", outcome: "success", elapsed_ms: null },
			{ phase: "finished", outcome: "failure", elapsed_ms: 0 },
			{
				phase: "finished",
				outcome: "cancelled",
				elapsed_ms: null,
				active_tool_count: 0,
				active_tools: [],
				in_flight: [],
			},
			{
				active_tool_count: 2,
				active_tools: [
					{ tool: "bash", started_at: AT },
					{ tool: "edit", started_at: AT },
				],
				in_flight: [
					{ digest: DIGEST_A, tool: "bash", started_at: AT },
					{ digest: DIGEST_B, tool: "edit", started_at: AT },
				],
			},
		]) {
			expect(classifyRuntimeToolActivity(snapshot(overrides)).kind).toBe("valid");
		}
	});

	// Each of these snapshots is individually valid. What makes it unpublishable is the
	// LIFECYCLE state it would be published next to: a settled session cannot be running a
	// tool, and a live one cannot have had its calls cancelled by a terminal it never reached.
	for (const lifecycle of ["completed", "errored"] as const) {
		it(`hides a started activity snapshot from a ${lifecycle} session`, () => {
			const started = snapshot();
			expect(classifyRuntimeToolActivity(started).kind).toBe("valid");
			expect(publicRuntimeToolActivity(started, lifecycle)).toBeNull();
		});

		it(`hides a terminal-incompatible in-flight count from a ${lifecycle} session`, () => {
			const stillRunning = snapshot({ phase: "finished", outcome: "success", elapsed_ms: 5 });
			expect(classifyRuntimeToolActivity(stillRunning).kind).toBe("valid");
			expect(publicRuntimeToolActivity(stillRunning, lifecycle)).toBeNull();
		});

		it(`publishes the terminal cancelled shape for a ${lifecycle} session`, () => {
			const settled = snapshot({
				phase: "finished",
				outcome: "cancelled",
				elapsed_ms: null,
				active_tool_count: 0,
				active_tools: [],
				in_flight: [],
			});
			expect(publicRuntimeToolActivity(settled, lifecycle)).toMatchObject({
				phase: "finished",
				outcome: "cancelled",
			});
		});
	}

	for (const lifecycle of ["running", "ready_for_input", "starting"] as const) {
		it(`hides a cancelled outcome from a ${lifecycle} session`, () => {
			const cancelled = snapshot({
				phase: "finished",
				outcome: "cancelled",
				elapsed_ms: null,
				active_tool_count: 0,
				active_tools: [],
				in_flight: [],
			});
			expect(classifyRuntimeToolActivity(cancelled).kind).toBe("valid");
			expect(publicRuntimeToolActivity(cancelled, lifecycle)).toBeNull();
		});

		it(`still publishes a live started snapshot for a ${lifecycle} session`, () => {
			expect(publicRuntimeToolActivity(snapshot(), lifecycle)).toMatchObject({
				phase: "started",
				active_tool_count: 1,
			});
		});
	}
});
