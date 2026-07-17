import { describe, expect, it, spyOn } from "bun:test";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseLaunchWorktreeMode } from "@gajae-code/coding-agent/gjc-runtime/launch-worktree";
import type { SessionCreateFrame } from "@gajae-code/coding-agent/sdk/bus/index";
import {
	attachLifecycleControl,
	buildCreateArgv,
	buildOrchestratorDeps,
	type ControlServerLike,
	createRateLimiter,
	daemonCloseSession,
	daemonResumeSession,
	daemonSpawnCreate,
	fileLedgerStore,
	type LifecycleControlServer,
	type LifecycleControlServerFactory,
	outcomeToResponse,
} from "@gajae-code/coding-agent/sdk/bus/lifecycle-control-runtime";
import type { LedgerEntry, OrchestratorDeps } from "@gajae-code/coding-agent/sdk/bus/lifecycle-orchestrator";
import { startDaemonLifecycleControl } from "@gajae-code/coding-agent/sdk/bus/telegram-daemon";
import { Settings } from "../src/config/settings";
import { acquireDaemonOwnership, TelegramNotificationDaemon } from "../src/sdk/bus/telegram-daemon";
import {
	prepareManagedSessionScopeForWriteSync,
	resolveManagedScope,
} from "../src/session/internal/managed-session-scope";

function writeManagedSession(sessionsRoot: string, cwd: string, sessionId: string): void {
	const resolved = resolveManagedScope({ cwd, agentDir: path.dirname(sessionsRoot), sessionsRoot });
	if (resolved.kind !== "resolved") throw new Error(resolved.message);
	const prepared = prepareManagedSessionScopeForWriteSync(resolved.scope);
	if (prepared.kind !== "resolved") throw new Error(prepared.message);
	const file = path.join(prepared.scope.directoryPath, `${sessionId}.jsonl`);
	fs.writeFileSync(file, `${JSON.stringify({ type: "session", id: sessionId, cwd })}\n`, { mode: 0o600 });
	fs.chmodSync(file, 0o600);
}

const PAIRED = "42";

function tmuxStatus(name: string, sessionId: string) {
	return {
		name,
		attached: false,
		windows: 1,
		panes: 1,
		bindings: "default",
		createdAt: "2026-01-01T00:00:00.000Z",
		sessionId,
		panePids: [],
	};
}

function createFrame(over: Partial<SessionCreateFrame> = {}): SessionCreateFrame {
	return {
		type: "session_create",
		requestId: "lc_1",
		lifecycleRequestId: "lc_1",
		intendedSessionId: "sess_pre_1",
		updateId: 100,
		chatId: PAIRED,
		token: "control-token",
		target: { kind: "existing_path", path: "/repo" },
		...over,
	};
}

function stubDeps(): OrchestratorDeps {
	return {
		pairedChatId: PAIRED,
		auditRedactionKey: new Uint8Array(32).fill(7),
		isPsmuxProvider: () => false,
		now: () => 1000,
		store: { read: async () => ({ version: 1, entries: {} }), write: async () => {} },
		audit: () => {},
		allowCreate: () => true,
		writeStartupPrompt: async () => undefined,
		spawnCreate: async (_f, ids) => ({
			sessionId: ids.intendedSessionId,
			tmuxSession: `gjc-${ids.intendedSessionId}`,
			endpointUrl: "ws://127.0.0.1:9",
			topicThreadId: "1",
		}),
		closeSession: async () => ({ processGone: true }),
		resumeSession: async () => ({
			sessionId: "s",
			tmuxSession: "gjc-s",
			endpointUrl: "",
			topicThreadId: "",
			mode: "reattached",
		}),
	};
}
it("requires exactly a 32-byte audit redaction key for production deps", () => {
	expect(() =>
		buildOrchestratorDeps({
			pairedChatId: PAIRED,
			agentNotificationsDir: "C:\\temporary\\notifications",
			auditRedactionKey: new Uint8Array(31),
		}),
	).toThrow("invalid_audit_redaction_key");
});
it("forwards the supplied 32-byte audit key unchanged and rejects invalid or missing keys before wiring", () => {
	let registered = 0;
	const controlServer: ControlServerLike = {
		onLifecycleRequest: () => {
			registered += 1;
		},
		respond: () => {},
	};
	const key = new Uint8Array(32).fill(0xa5);
	const deps = startDaemonLifecycleControl({
		controlServer,
		pairedChatId: PAIRED,
		agentDir: "C:\\temporary\\notifications-forwarding",
		auditRedactionKey: key,
	});
	expect(deps.auditRedactionKey).toBe(key);
	expect(registered).toBe(1);

	const invalidAgentDir = path.join(os.tmpdir(), `gjc-invalid-audit-key-${Date.now()}`);
	const auditPath = path.join(invalidAgentDir, "notifications", "telegram-lifecycle-audit.jsonl");
	for (const auditRedactionKey of [new Uint8Array(31), undefined as unknown as Uint8Array]) {
		registered = 0;
		expect(() =>
			startDaemonLifecycleControl({
				controlServer,
				pairedChatId: PAIRED,
				agentDir: invalidAgentDir,
				auditRedactionKey,
			}),
		).toThrow();
		expect(registered).toBe(0);
		expect(fs.existsSync(auditPath)).toBe(false);
	}
});
it("fails closed without creating files when startup prompt capability transport is unavailable", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-startup-prompt-unsupported-"));
	const deps = buildOrchestratorDeps({
		pairedChatId: PAIRED,
		agentNotificationsDir: root,
		auditRedactionKey: new Uint8Array(32).fill(7),
	});
	try {
		await expect(deps.writeStartupPrompt("request", undefined, async () => {})).resolves.toBeUndefined();
		await expect(deps.writeStartupPrompt("request", "SECRET", async () => {})).rejects.toThrow(
			"startup_prompt_capability_transport_unavailable",
		);
		expect(fs.readdirSync(root)).toEqual([]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

function daemonSettings(agentDir: string): Settings {
	const base = Settings.isolated({
		"notifications.enabled": true,
		"notifications.telegram.botToken": "123456:secret-token",
		"notifications.telegram.chatId": PAIRED,
	}) as Settings;
	return new Proxy(base, {
		get(target, prop) {
			if (prop === "getAgentDir") return () => agentDir;
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Settings;
}

function immediateTimeout(): typeof setTimeout {
	return ((callback: () => void) => {
		callback();
		return 0;
	}) as unknown as typeof setTimeout;
}

async function startAsOwner(settings: Settings, ownerId: string): Promise<void> {
	await acquireDaemonOwnership({
		settings,
		tokenFingerprint: "fingerprint",
		chatId: PAIRED,
		pid: process.pid,
		randomId: () => ownerId,
	});
}

it("passes the daemon-derived audit key through real lifecycle startup without a fallback", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-daemon-audit-key-"));
	const settings = daemonSettings(agentDir);
	await startAsOwner(settings, "audit-key-owner");

	let capturedKey: Uint8Array | undefined;
	let registered = 0;
	const factory: LifecycleControlServerFactory = () =>
		({
			onLifecycleRequest: () => {
				registered++;
			},
			respond: () => {},
			start: async () => undefined,
			stop: () => {},
		}) as LifecycleControlServer;
	const daemon = new TelegramNotificationDaemon({
		settings,
		ownerId: "audit-key-owner",
		botToken: "bot-token",
		chatId: PAIRED,
		botApi: { call: async () => ({ ok: true, result: [] }) } as never,
		idleTimeoutMs: 10,
		now: (() => {
			let now = 0;
			return () => (now += 11);
		})(),
		setTimeoutImpl: immediateTimeout(),
		createLifecycleControlServer: factory,
		createLifecycleOrchestratorDeps: input => {
			capturedKey = input.auditRedactionKey;
			return { ...stubDeps(), auditRedactionKey: input.auditRedactionKey };
		},
	});

	await daemon.run();

	expect(Buffer.from(capturedKey ?? []).toString("hex")).toBe(
		"03936c8324cc679ecdc4bca97b2a88acaedf993ec45a8e6b3196033a6f9727a6",
	);
	expect(registered).toBe(1);
});

it("does not attach lifecycle audit dependencies or fall back when daemon key derivation has no token", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-daemon-missing-audit-key-"));
	const settings = daemonSettings(agentDir);
	await startAsOwner(settings, "missing-audit-key-owner");

	let dependenciesBuilt = 0;
	let registered = 0;
	let started = 0;
	let stopped = 0;
	const factory: LifecycleControlServerFactory = () =>
		({
			onLifecycleRequest: () => {
				registered++;
			},
			respond: () => {},
			start: async () => {
				started++;
			},
			stop: () => {
				stopped++;
			},
		}) as LifecycleControlServer;
	const daemon = new TelegramNotificationDaemon({
		settings,
		ownerId: "missing-audit-key-owner",
		botToken: undefined as unknown as string,
		chatId: PAIRED,
		botApi: { call: async () => ({ ok: true, result: [] }) } as never,
		idleTimeoutMs: 10,
		now: (() => {
			let now = 0;
			return () => (now += 11);
		})(),
		setTimeoutImpl: immediateTimeout(),
		createLifecycleControlServer: factory,
		createLifecycleOrchestratorDeps: () => {
			dependenciesBuilt++;
			return stubDeps();
		},
	});

	await daemon.run();

	expect([dependenciesBuilt, registered, started, stopped]).toEqual([0, 0, 0, 1]);
});

describe("lifecycle control runtime", () => {
	it("buildCreateArgv emits only launcher-supported flags (no --session-id)", () => {
		expect(buildCreateArgv(createFrame(), { intendedSessionId: "x" })).toEqual({
			cwd: "/repo",
			args: [],
		});
		expect(
			buildCreateArgv(createFrame({ target: { kind: "worktree", repo: "/r", branch: "feat/y" } }), {
				intendedSessionId: "x",
			}),
		).toEqual({ cwd: "/r", args: ["--worktree=feat/y"] });
		expect(
			buildCreateArgv(createFrame({ target: { kind: "plain_dir", path: "/new" } }), { intendedSessionId: "x" }),
		).toEqual({ cwd: "/new", args: [] });
	});

	it("buildCreateArgv expands own-home tilde paths defensively", () => {
		const home = os.homedir();

		expect(
			buildCreateArgv(createFrame({ target: { kind: "existing_path", path: "~/repo" } }), {
				intendedSessionId: "x",
			}),
		).toEqual({
			cwd: `${home}/repo`,
			args: [],
		});
		expect(
			buildCreateArgv(createFrame({ target: { kind: "worktree", repo: "~/repo", branch: "feat/y" } }), {
				intendedSessionId: "x",
			}),
		).toEqual({ cwd: `${home}/repo`, args: ["--worktree=feat/y"] });
	});

	it("worktree argv parses as a NAMED (non-detached) worktree with no stray flags", () => {
		const { args } = buildCreateArgv(createFrame({ target: { kind: "worktree", repo: "/r", branch: "feat/y" } }), {
			intendedSessionId: "x",
		});
		const { mode, remainingArgs } = parseLaunchWorktreeMode(args);
		expect(mode).toEqual({ enabled: true, detached: false, name: "feat/y" });
		expect(remainingArgs).toEqual([]);
	});

	it("a flag-shaped branch stays a named worktree (no detached/stray-flag mis-parse)", () => {
		// `--worktree=<branch>` keeps the branch a single argv token even if it
		// looks like a flag, so it can never trigger detached mode.
		const { args } = buildCreateArgv(createFrame({ target: { kind: "worktree", repo: "/r", branch: "-x" } }), {
			intendedSessionId: "x",
		});
		expect(args).toEqual(["--worktree=-x"]);
		const { mode, remainingArgs } = parseLaunchWorktreeMode(args);
		expect(mode).toEqual({ enabled: true, detached: false, name: "-x" });
		expect(remainingArgs).toEqual([]);
	});

	it("buildCreateArgv emits root-parser-compatible --mpreset argv when modelPreset is set", () => {
		const pathLaunch = buildCreateArgv(createFrame({ modelPreset: "codex-eco" }), { intendedSessionId: "x" });
		expect(pathLaunch).toEqual({ cwd: "/repo", args: ["--mpreset", "codex-eco"] });
		expect(pathLaunch.args).not.toContain("--mpreset=codex-eco");

		const worktreeLaunch = buildCreateArgv(
			createFrame({ target: { kind: "worktree", repo: "/r", branch: "feat/y" }, modelPreset: "claude-opus" }),
			{ intendedSessionId: "x" },
		);
		expect(worktreeLaunch).toEqual({ cwd: "/r", args: ["--worktree=feat/y", "--mpreset", "claude-opus"] });
		const { mode, remainingArgs } = parseLaunchWorktreeMode(worktreeLaunch.args);
		expect(mode).toEqual({ enabled: true, detached: false, name: "feat/y" });
		expect(remainingArgs).toEqual(["--mpreset", "claude-opus"]);
	});

	it("buildCreateArgv omits --mpreset when modelPreset is undefined", () => {
		expect(buildCreateArgv(createFrame(), { intendedSessionId: "x" }).args).toEqual([]);
	});

	it("outcomeToResponse maps ok create to a create_response frame", () => {
		const entry: LedgerEntry = {
			requestHash: "h",
			state: "success",
			requestId: "lc_1",
			verb: "session_create",
			intendedSessionId: "sess_pre_1",
			sessionId: "sess_pre_1",
			createdAt: 0,
			updatedAt: 0,
			targetSummary: {},
			endpointUrl: "ws://x",
		};
		const resp = outcomeToResponse(createFrame(), { status: "ok", entry });
		expect(resp.type).toBe("session_create_response");
		if (resp.type === "session_create_response") {
			expect(resp.sessionId).toBe("sess_pre_1");
			expect(resp.matchedBy).toBe("spawn_marker");
		}
	});

	it("outcomeToResponse maps error to a lifecycle_error frame", () => {
		const resp = outcomeToResponse(createFrame(), {
			status: "error",
			reason: "rate_limited",
			message: "too many",
		});
		expect(resp.type).toBe("session_lifecycle_error");
		if (resp.type === "session_lifecycle_error") expect(resp.reason).toBe("rate_limited");
	});

	it("attachLifecycleControl wires a request through to a response", async () => {
		const responses: string[] = [];
		let handler:
			| ((err: Error | null, req: { kind: string; requestId: string; payloadJson: string }) => void)
			| undefined;
		const server: ControlServerLike = {
			onLifecycleRequest: cb => {
				handler = cb;
			},
			respond: json => responses.push(json),
		};
		attachLifecycleControl(server, stubDeps());
		expect(handler).toBeDefined();
		handler?.(null, { kind: "session_create", requestId: "lc_1", payloadJson: JSON.stringify(createFrame()) });
		await new Promise(r => setTimeout(r, 20));
		expect(responses).toHaveLength(1);
		const parsed = JSON.parse(responses[0]!);
		expect(parsed.type).toBe("session_create_response");
		expect(parsed.sessionId).toBe("sess_pre_1");
		// The control token must never appear in the response routed to clients.
		expect(responses[0]).not.toContain("control-token");
	});

	it("accepts authenticated token-redacted native create, close, and resume frames", async () => {
		const responses: string[] = [];
		let handler:
			| ((err: Error | null, req: { kind: string; requestId: string; payloadJson: string }) => void)
			| undefined;
		const calls: string[] = [];
		attachLifecycleControl(
			{
				onLifecycleRequest: cb => {
					handler = cb;
				},
				respond: json => responses.push(json),
			},
			{
				...stubDeps(),
				spawnCreate: async (_frame, ids) => {
					calls.push("create");
					return { sessionId: ids.intendedSessionId, tmuxSession: "managed", endpointUrl: "", topicThreadId: "" };
				},
				closeSession: async () => {
					calls.push("close");
					return { processGone: true };
				},
				resumeSession: async () => {
					calls.push("resume");
					return {
						sessionId: "resume-1",
						tmuxSession: "managed",
						endpointUrl: "",
						topicThreadId: "",
						mode: "reattached",
					};
				},
			},
		);
		const create = createFrame({ updateId: 201 });
		delete (create as Partial<SessionCreateFrame>).token;
		handler?.(null, { kind: "session_create", requestId: "native-create", payloadJson: JSON.stringify(create) });
		handler?.(null, {
			kind: "session_close",
			requestId: "native-close",
			payloadJson: JSON.stringify({
				type: "session_close",
				requestId: "native-close",
				updateId: 202,
				chatId: PAIRED,
				target: { sessionId: "sess_pre_1" },
				force: true,
			}),
		});
		handler?.(null, {
			kind: "session_resume",
			requestId: "native-resume",
			payloadJson: JSON.stringify({
				type: "session_resume",
				requestId: "native-resume",
				updateId: 203,
				chatId: PAIRED,
				target: { sessionIdOrPrefix: "resume-1" },
			}),
		});
		await new Promise(resolve => setTimeout(resolve, 40));

		expect(calls).toEqual(["create", "close", "resume"]);
		expect(responses.map(response => JSON.parse(response).type)).toEqual([
			"session_create_response",
			"session_close_response",
			"session_resume_response",
		]);
		expect(responses.join("\n")).not.toContain("control-token");
	});

	it("migrates legacy successful resume entries without resumeMode", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-lifecycle-legacy-resume-"));
		const ledgerPath = path.join(root, "ledger.json");
		const legacyEntry: LedgerEntry = {
			requestHash: "legacy-hash",
			state: "success",
			requestId: "legacy-resume",
			verb: "session_resume",
			sessionId: "session-1",
			tmuxSession: "gjc-session-1",
			endpointUrl: "ws://127.0.0.1:1",
			createdAt: 1,
			updatedAt: 2,
			targetSummary: { kind: "session_resume" },
		};
		delete legacyEntry.resumeMode;
		fs.writeFileSync(ledgerPath, JSON.stringify({ version: 1, entries: { "42:7": legacyEntry } }), { mode: 0o600 });
		try {
			const doc = await fileLedgerStore(ledgerPath).read();
			expect(doc.entries["42:7"]?.resumeMode).toBe("reattached");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
	it("distinguishes a missing ledger from corrupt or unreadable durable state", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-lifecycle-ledger-"));
		const ledgerPath = path.join(root, "ledger.json");
		const store = fileLedgerStore(ledgerPath);
		try {
			expect(await store.read()).toEqual({ version: 1, entries: {} });
			fs.writeFileSync(ledgerPath, "{not json", { mode: 0o600 });
			await expect(store.read()).rejects.toThrow("gjc_lifecycle_ledger_read_failed:invalid");
			expect(fs.readFileSync(ledgerPath, "utf8")).toBe("{not json");
			const nonDirectory = path.join(root, "not-a-directory");
			fs.writeFileSync(nonDirectory, "not a directory", { mode: 0o600 });
			await expect(fileLedgerStore(path.join(nonDirectory, "ledger.json")).read()).rejects.toThrow(
				"gjc_lifecycle_ledger_read_failed:ENOTDIR",
			);

			const originalRead = fs.readFileSync as (file: fs.PathOrFileDescriptor, options?: unknown) => string;
			const readSpy = spyOn(fs, "readFileSync").mockImplementation(((file, options) => {
				if (file === ledgerPath) {
					const error = new Error("permission denied") as NodeJS.ErrnoException;
					error.code = "EACCES";
					throw error;
				}
				return originalRead(file, options);
			}) as typeof fs.readFileSync);
			try {
				await expect(store.read()).rejects.toThrow("gjc_lifecycle_ledger_read_failed:EACCES");
			} finally {
				readSpy.mockRestore();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("ignores unsupported directory fsync only, and propagates directory open and close failures", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-lifecycle-ledger-sync-"));
		const ledgerPath = path.join(root, "ledger.json");
		const originalFsync = fs.fsyncSync;
		const originalOpen = fs.openSync;
		const originalClose = fs.closeSync;
		try {
			for (const code of ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EIO"] as const) {
				let fsyncCalls = 0;
				const fsyncSpy = spyOn(fs, "fsyncSync").mockImplementation(((fd: number) => {
					fsyncCalls++;
					if (fsyncCalls === 2) {
						const error = new Error("sync failed") as NodeJS.ErrnoException;
						error.code = code;
						throw error;
					}
					return originalFsync(fd);
				}) as typeof fs.fsyncSync);
				try {
					const write = fileLedgerStore(ledgerPath).write({ version: 1, entries: {} });
					if (["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(code)) await expect(write).resolves.toBeUndefined();
					else await expect(write).rejects.toThrow("sync failed");
				} finally {
					fsyncSpy.mockRestore();
				}
			}

			const directoryFd = 987_654;
			let closedDirectoryFd = false;
			const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => {
				throw new Error("private diagnostic output failure");
			});
			const directoryOpenSpy = spyOn(fs, "openSync").mockImplementation(((file, flags, mode) =>
				file === root ? directoryFd : originalOpen(file, flags, mode)) as typeof fs.openSync);
			const directoryFsyncSpy = spyOn(fs, "fsyncSync").mockImplementation(((fd: number) => {
				if (fd === directoryFd) {
					const error = new Error("unsupported directory sync") as NodeJS.ErrnoException;
					error.code = "EINVAL";
					throw error;
				}
				return originalFsync(fd);
			}) as typeof fs.fsyncSync);
			const directoryCloseSpy = spyOn(fs, "closeSync").mockImplementation(((fd: number) => {
				if (fd === directoryFd) {
					closedDirectoryFd = true;
					return;
				}
				return originalClose(fd);
			}) as typeof fs.closeSync);
			try {
				await expect(fileLedgerStore(ledgerPath).write({ version: 1, entries: {} })).resolves.toBeUndefined();
				expect(closedDirectoryFd).toBe(true);
			} finally {
				directoryCloseSpy.mockRestore();
				directoryFsyncSpy.mockRestore();
				directoryOpenSpy.mockRestore();
				stderrSpy.mockRestore();
			}

			const openSpy = spyOn(fs, "openSync").mockImplementation(((file, flags, mode) => {
				if (file === root) {
					const error = new Error("directory open failed") as NodeJS.ErrnoException;
					error.code = "EINVAL";
					throw error;
				}
				return originalOpen(file, flags, mode);
			}) as typeof fs.openSync);
			try {
				await expect(fileLedgerStore(ledgerPath).write({ version: 1, entries: {} })).rejects.toThrow(
					"directory open failed",
				);
			} finally {
				openSpy.mockRestore();
			}

			let closeCalls = 0;
			const closeSpy = spyOn(fs, "closeSync").mockImplementation(((fd: number) => {
				closeCalls++;
				if (closeCalls === 2) {
					const error = new Error("directory close failed") as NodeJS.ErrnoException;
					error.code = "EINVAL";
					throw error;
				}
				return originalClose(fd);
			}) as typeof fs.closeSync);
			try {
				await expect(fileLedgerStore(ledgerPath).write({ version: 1, entries: {} })).rejects.toThrow(
					"directory close failed",
				);
			} finally {
				closeSpy.mockRestore();
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("closes and never publishes a ledger temporary file after write or fsync failure", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-lifecycle-ledger-temp-"));
		const ledgerPath = path.join(root, "ledger.json");
		const originalWrite = fs.writeSync;
		const originalFsync = fs.fsyncSync;
		const originalClose = fs.closeSync;
		const originalRename = fs.renameSync;
		try {
			for (const failurePoint of ["write", "fsync"] as const) {
				let renamed = false;
				let closed = false;
				const writeSpy = spyOn(fs, "writeSync").mockImplementation(((...args: Parameters<typeof fs.writeSync>) => {
					if (failurePoint === "write") throw new Error("write failed");
					return originalWrite(...args);
				}) as typeof fs.writeSync);
				const fsyncSpy = spyOn(fs, "fsyncSync").mockImplementation(((fd: number) => {
					if (failurePoint === "fsync") throw new Error("fsync failed");
					return originalFsync(fd);
				}) as typeof fs.fsyncSync);
				const closeSpy = spyOn(fs, "closeSync").mockImplementation(((fd: number) => {
					closed = true;
					return originalClose(fd);
				}) as typeof fs.closeSync);
				const renameSpy = spyOn(fs, "renameSync").mockImplementation(((
					...args: Parameters<typeof fs.renameSync>
				) => {
					renamed = true;
					return originalRename(...args);
				}) as typeof fs.renameSync);
				try {
					await expect(fileLedgerStore(ledgerPath).write({ version: 1, entries: {} })).rejects.toThrow(
						failurePoint === "write" ? "write failed" : "fsync failed",
					);
					expect(closed).toBe(true);
					expect(renamed).toBe(false);
				} finally {
					renameSpy.mockRestore();
					closeSpy.mockRestore();
					fsyncSpy.mockRestore();
					writeSpy.mockRestore();
				}
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("persists complete ledger JSON across short writes", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-lifecycle-ledger-short-write-"));
		const ledgerPath = path.join(root, "ledger.json");
		const originalWrite = fs.writeSync as (
			fd: number,
			buffer: Uint8Array,
			offset: number,
			length: number,
			position?: number | null,
		) => number;
		let writeCalls = 0;
		const doc = { version: 1 as const, entries: {} };
		const writeSpy = spyOn(fs, "writeSync").mockImplementation(((
			fd: number,
			buffer: Uint8Array,
			offset: number,
			length: number,
		) => {
			writeCalls++;
			return originalWrite(fd, buffer as Uint8Array, offset as number, Math.min(length as number, 3));
		}) as typeof fs.writeSync);
		try {
			await fileLedgerStore(ledgerPath).write(doc);
			expect(writeCalls).toBeGreaterThan(1);
			expect(JSON.parse(fs.readFileSync(ledgerPath, "utf8"))).toEqual(doc);
		} finally {
			writeSpy.mockRestore();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves the prior ledger and removes the temporary file when a write makes no progress", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-lifecycle-ledger-zero-write-"));
		const ledgerPath = path.join(root, "ledger.json");
		const prior = JSON.stringify({ version: 1, entries: {} });
		fs.writeFileSync(ledgerPath, prior, { mode: 0o600 });
		let renamed = false;
		const originalRename = fs.renameSync;
		const writeSpy = spyOn(fs, "writeSync").mockImplementation((() => 0) as typeof fs.writeSync);
		const renameSpy = spyOn(fs, "renameSync").mockImplementation(((...args: Parameters<typeof fs.renameSync>) => {
			renamed = true;
			return originalRename(...args);
		}) as typeof fs.renameSync);
		try {
			await expect(fileLedgerStore(ledgerPath).write({ version: 1, entries: {} })).rejects.toThrow("Short write");
			expect(renamed).toBe(false);
			expect(fs.readFileSync(ledgerPath, "utf8")).toBe(prior);
			expect(fs.readdirSync(root).filter(name => name.endsWith(".tmp"))).toEqual([]);
		} finally {
			renameSpy.mockRestore();
			writeSpy.mockRestore();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns bounded errors for malformed and failed requests while preserving queue progress", async () => {
		const responses: string[] = [];
		let handler:
			| ((err: Error | null, req: { kind: string; requestId: string; payloadJson: string }) => void)
			| undefined;
		let spawns = 0;
		const server: ControlServerLike = {
			onLifecycleRequest: cb => {
				handler = cb;
			},
			respond: json => responses.push(json),
		};
		attachLifecycleControl(server, {
			...stubDeps(),
			spawnCreate: async (_frame, ids) => {
				spawns++;
				if (spawns === 1) throw new Error("private orchestrator failure");
				return { sessionId: ids.intendedSessionId, tmuxSession: "managed", endpointUrl: "", topicThreadId: "" };
			},
		});
		handler?.(null, { kind: "session_create", requestId: "malformed", payloadJson: "{" });
		handler?.(null, {
			kind: "session_create",
			requestId: "failed",
			payloadJson: JSON.stringify(createFrame({ updateId: 101 })),
		});
		handler?.(null, {
			kind: "session_create",
			requestId: "later",
			payloadJson: JSON.stringify(createFrame({ updateId: 102 })),
		});
		await new Promise(r => setTimeout(r, 40));

		expect(responses).toHaveLength(3);
		const parsed = responses.map(response => JSON.parse(response));
		expect(parsed[0]).toMatchObject({
			type: "session_lifecycle_error",
			requestId: "malformed",
			message: "request could not be processed",
		});
		expect(parsed[1]).toMatchObject({
			type: "session_lifecycle_error",
			requestId: "lc_1",
			message: "request could not be processed",
		});
		expect(parsed[1].message).not.toContain("private orchestrator failure");
		expect(parsed[2]).toMatchObject({ type: "session_create_response", requestId: "lc_1" });
		expect(spawns).toBe(2);
	});

	it("enforces UTF-8 byte bounds for parsed and fallback request IDs", async () => {
		const responses: string[] = [];
		let handler:
			| ((err: Error | null, req: { kind: string; requestId: string; payloadJson: string }) => void)
			| undefined;
		const server: ControlServerLike = {
			onLifecycleRequest: cb => {
				handler = cb;
			},
			respond: json => responses.push(json),
		};
		attachLifecycleControl(server, stubDeps());
		const exactMultibyteId = "😀".repeat(32);
		const surrogateBoundaryId = `${"a".repeat(127)}😀`;
		handler?.(null, {
			kind: "session_create",
			requestId: "native-numeric",
			payloadJson: JSON.stringify({ requestId: 1 }),
		});
		handler?.(null, {
			kind: "session_create",
			requestId: surrogateBoundaryId,
			payloadJson: JSON.stringify(createFrame({ requestId: "😀".repeat(33) })),
		});
		handler?.(null, {
			kind: "session_create",
			requestId: "fallback",
			payloadJson: JSON.stringify(createFrame({ requestId: exactMultibyteId, updateId: 106 })),
		});
		await new Promise(r => setTimeout(r, 40));

		expect(responses).toHaveLength(3);
		const parsed = responses.map(response => JSON.parse(response));
		expect(parsed[0].requestId).toBe("native-numeric");
		expect(parsed[1].requestId).toBe("a".repeat(127));
		expect(Buffer.byteLength(parsed[1].requestId, "utf8")).toBeLessThanOrEqual(128);
		expect(parsed[1].requestId).not.toContain("�");
		expect(parsed[2]).toMatchObject({ type: "session_create_response", requestId: exactMultibyteId });
		expect(Buffer.byteLength(parsed[2].requestId, "utf8")).toBe(128);
		expect(parsed.slice(0, 2).every(response => response.message === "request could not be processed")).toBe(true);
	});

	it("rejects lone-surrogate parsed IDs, emits a fixed callback diagnostic, and keeps the queue live", async () => {
		const responses: string[] = [];
		const diagnostics: string[] = [];
		let handler:
			| ((err: Error | null, req: { kind: string; requestId: string; payloadJson: string }) => void)
			| undefined;
		const stderrSpy = spyOn(process.stderr, "write").mockImplementation(((message: string) => {
			diagnostics.push(message);
			return true;
		}) as typeof process.stderr.write);
		try {
			attachLifecycleControl(
				{
					onLifecycleRequest: cb => {
						handler = cb;
					},
					respond: json => responses.push(json),
				},
				stubDeps(),
			);
			handler?.(new Error("private callback failure"), {
				kind: "session_create",
				requestId: "private",
				payloadJson: "{}",
			});
			handler?.(null, {
				kind: "session_create",
				requestId: "\ud800",
				payloadJson: JSON.stringify(createFrame({ requestId: "\ud800" })),
			});
			handler?.(null, { kind: "session_create", requestId: "later", payloadJson: JSON.stringify(createFrame()) });
			await new Promise(resolve => setTimeout(resolve, 40));
			const malformed = JSON.parse(responses[0]!);
			expect(malformed).toMatchObject({
				type: "session_lifecycle_error",
				requestId: "",
				message: "request could not be processed",
			});
			expect(responses[1]).toContain("session_create_response");
			expect(diagnostics).toEqual([
				"gjc lifecycle control request failed\n",
				"gjc lifecycle control request failed\n",
			]);
		} finally {
			stderrSpy.mockRestore();
		}
	});

	it("recovers the queue only after both response attempts fail for the current request", async () => {
		const responses: string[] = [];
		let handler:
			| ((err: Error | null, req: { kind: string; requestId: string; payloadJson: string }) => void)
			| undefined;
		let responseAttempts = 0;
		const server: ControlServerLike = {
			onLifecycleRequest: cb => {
				handler = cb;
			},
			respond: json => {
				responseAttempts++;
				if (responseAttempts <= 2) throw new Error("response transport failed");
				responses.push(json);
			},
		};
		attachLifecycleControl(server, stubDeps());
		handler?.(null, {
			kind: "session_create",
			requestId: "first",
			payloadJson: JSON.stringify(createFrame({ updateId: 103 })),
		});
		handler?.(null, {
			kind: "session_create",
			requestId: "second",
			payloadJson: JSON.stringify(createFrame({ updateId: 104 })),
		});
		await new Promise(r => setTimeout(r, 40));

		expect(responseAttempts).toBe(3);
		expect(responses).toHaveLength(1);
		expect(JSON.parse(responses[0]!)).toMatchObject({ type: "session_create_response", requestId: "lc_1" });
	});

	it("keeps audit sink failures to a fixed sanitized failure response", async () => {
		const responses: string[] = [];
		let handler:
			| ((err: Error | null, req: { kind: string; requestId: string; payloadJson: string }) => void)
			| undefined;
		const server: ControlServerLike = {
			onLifecycleRequest: cb => {
				handler = cb;
			},
			respond: json => responses.push(json),
		};
		attachLifecycleControl(server, {
			...stubDeps(),
			audit: () => {
				throw new Error("private audit failure");
			},
		});
		handler?.(null, {
			kind: "session_create",
			requestId: "native-request",
			payloadJson: JSON.stringify(createFrame({ updateId: 105 })),
		});
		await new Promise(r => setTimeout(r, 40));

		expect(responses).toHaveLength(1);
		expect(JSON.parse(responses[0]!)).toMatchObject({
			type: "session_lifecycle_error",
			requestId: "lc_1",
			message: "request could not be processed",
		});
		expect(responses[0]).not.toContain("private audit failure");
	});

	it("keeps parse, handle, audit, and transport diagnostics fixed while recovering the queue", async () => {
		const diagnostics: string[] = [];
		const stderrSpy = spyOn(process.stderr, "write").mockImplementation(((message: string) => {
			diagnostics.push(message);
			return true;
		}) as typeof process.stderr.write);
		const privatePayload = "private payload and error details";
		const responses: string[] = [];
		let handler:
			| ((err: Error | null, req: { kind: string; requestId: string; payloadJson: string }) => void)
			| undefined;
		let responseAttempts = 0;
		const server: ControlServerLike = {
			onLifecycleRequest: cb => {
				handler = cb;
			},
			respond: json => {
				responseAttempts++;
				if (responseAttempts === 4 || responseAttempts === 6 || responseAttempts === 7)
					throw new Error(`private transport failure: ${privatePayload}`);
				responses.push(json);
			},
		};
		let reads = 0;
		attachLifecycleControl(server, {
			...stubDeps(),
			store: {
				read: async () => {
					reads++;
					if (reads === 1) throw new Error(`private handle failure: ${privatePayload}`);
					return { version: 1, entries: {} };
				},
				write: async () => {},
			},
			audit: event => {
				if (event.updateId === 108) throw new Error(`private audit failure: ${privatePayload}`);
			},
		});
		handler?.(null, { kind: "session_create", requestId: "parse", payloadJson: `{${privatePayload}` });
		handler?.(null, {
			kind: "session_create",
			requestId: "handle",
			payloadJson: JSON.stringify(createFrame({ updateId: 107 })),
		});
		handler?.(null, {
			kind: "session_create",
			requestId: "audit",
			payloadJson: JSON.stringify(createFrame({ updateId: 108 })),
		});
		handler?.(null, {
			kind: "session_create",
			requestId: "primary",
			payloadJson: JSON.stringify(createFrame({ updateId: 109 })),
		});
		handler?.(null, {
			kind: "session_create",
			requestId: "fallback",
			payloadJson: JSON.stringify(createFrame({ updateId: 110 })),
		});
		handler?.(null, {
			kind: "session_create",
			requestId: "later",
			payloadJson: JSON.stringify(createFrame({ updateId: 111 })),
		});
		await new Promise(r => setTimeout(r, 60));
		stderrSpy.mockRestore();

		expect(diagnostics).toEqual([
			"gjc lifecycle control request failed\n",
			"gjc lifecycle control request failed\n",
			"gjc lifecycle control request failed\n",
			"gjc lifecycle control request failed\n",
			"gjc lifecycle control request failed\n",
			"gjc lifecycle control request failed\n",
		]);
		expect(responses).toHaveLength(5);
		expect(responses.every(response => Buffer.byteLength(response, "utf8") <= 128 * 16)).toBe(true);
		expect(responses.join("\n")).not.toContain(privatePayload);
		expect(JSON.parse(responses.at(-1)!).type).toBe("session_create_response");

		const throwingStderr = spyOn(process.stderr, "write").mockImplementation(() => {
			throw new Error(`private stderr failure: ${privatePayload}`);
		});
		let stderrHandler:
			| ((err: Error | null, req: { kind: string; requestId: string; payloadJson: string }) => void)
			| undefined;
		const stderrResponses: string[] = [];
		attachLifecycleControl(
			{
				onLifecycleRequest: cb => {
					stderrHandler = cb;
				},
				respond: json => stderrResponses.push(json),
			},
			stubDeps(),
		);
		stderrHandler?.(null, { kind: "session_create", requestId: "stderr", payloadJson: `{${privatePayload}` });
		await new Promise(r => setTimeout(r, 20));
		throwingStderr.mockRestore();
		expect(stderrResponses).toHaveLength(1);
		expect(stderrResponses[0]).not.toContain(privatePayload);
	});

	it("rate limiter allows up to N then blocks within the window", () => {
		const limit = createRateLimiter(2, 1000);
		expect(limit("42", 0)).toBe(true);
		expect(limit("42", 100)).toBe(true);
		expect(limit("42", 200)).toBe(false);
		expect(limit("42", 1300)).toBe(true); // window slid
	});

	it("serializes concurrent duplicate requests so only one spawn happens", async () => {
		const doc = { version: 1 as const, entries: {} as Record<string, unknown> };
		let spawns = 0;
		const deps = {
			...stubDeps(),
			store: {
				read: async () => JSON.parse(JSON.stringify(doc)),
				write: async (d: { version: 1; entries: Record<string, unknown> }) => {
					doc.entries = d.entries;
				},
			},
			spawnCreate: async (_f: unknown, ids: { intendedSessionId: string }) => {
				spawns++;
				await new Promise(r => setTimeout(r, 30)); // widen the race window
				return {
					sessionId: ids.intendedSessionId,
					tmuxSession: `gjc-${ids.intendedSessionId}`,
					endpointUrl: "",
					topicThreadId: "",
				};
			},
		} as unknown as OrchestratorDeps;

		const responses: string[] = [];
		let handler:
			| ((err: Error | null, req: { kind: string; requestId: string; payloadJson: string }) => void)
			| undefined;
		const server: ControlServerLike = {
			onLifecycleRequest: cb => {
				handler = cb;
			},
			respond: json => responses.push(json),
		};
		attachLifecycleControl(server, deps);

		const payload = JSON.stringify(createFrame());
		// Two identical updates arrive back-to-back (same updateId + body).
		handler?.(null, { kind: "session_create", requestId: "lc_1", payloadJson: payload });
		handler?.(null, { kind: "session_create", requestId: "lc_1", payloadJson: payload });
		await new Promise(r => setTimeout(r, 120));

		expect(spawns).toBe(1); // serial queue + durable ledger => exactly one spawn
		expect(responses).toHaveLength(2); // both get a response (one ok, one re-ack)
		expect(responses.every(r => r.includes("session_create_response"))).toBe(true);
	});

	it("daemonResumeSession fails closed against saved history (notFound / ambiguous)", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-resume-"));
		const proj = path.join(root, "proj");
		fs.mkdirSync(proj, { recursive: true });
		await writeManagedSession(root, proj, "abc111");
		await writeManagedSession(root, proj, "abc222");
		fs.writeFileSync(
			path.join(root, "raw-legacy.jsonl"),
			`${JSON.stringify({ type: "session", id: "abc333", cwd: proj })}\n`,
			{ mode: 0o600 },
		);

		// No live tmux match for these unique ids, so resolution falls to history.
		const resume = daemonResumeSession(process.env, { sessionsRoot: root });

		const missing = await resume({ sessionIdOrPrefix: "zzz-no-such", path: proj });
		expect(missing).toEqual({ notFound: true });

		const rawDirectoryCandidate = await resume({ sessionIdOrPrefix: "abc333", path: proj });
		expect(rawDirectoryCandidate).toEqual({ notFound: true });

		const ambiguous = await resume({ sessionIdOrPrefix: "abc", path: proj });
		expect("ambiguous" in ambiguous).toBe(true);
		if ("ambiguous" in ambiguous) {
			expect(ambiguous.ambiguous.map(c => c.sessionId).sort()).toEqual(["abc111", "abc222"]);
		}

		fs.rmSync(root, { recursive: true, force: true });
	});

	it("daemonResumeSession cold-restarts saved sessions from their recorded cwd", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-resume-cwd-"));
		const proj = path.join(root, "saved-project");
		const callsFile = path.join(root, "tmux-calls.log");
		const serverState = path.join(root, "tmux-server-started");
		const tmux = path.join(root, "fake-tmux.sh");
		fs.mkdirSync(proj, { recursive: true });
		await writeManagedSession(root, proj, "abc123");
		fs.writeFileSync(
			tmux,
			[
				"#!/usr/bin/env bash",
				'printf \'%s\\n\' "$*" >> "$TMUX_CALLS"',
				'if [ "$3" = "display-message" ]; then printf \'$42\\tgjc_lc_abc123\\n\'; exit 0; fi',
				'if [ "$3" = "if-shell" ]; then printf "__gjc_lifecycle_metadata_ok__\\n"; exit 0; fi',

				'if [ "$1" = "display-message" ]; then',
				'  if [ -f "$TMUX_SERVER_STATE" ]; then',
				"    printf '%s\\n' \"$TMUX_SERVER_PID\"",
				"    exit 0",
				"  fi",
				"  echo 'no server running' >&2",
				"  exit 1",
				"fi",
				'if [ "$1" = "list-sessions" ]; then',
				"  echo 'no server running' >&2",
				"  exit 1",
				"fi",
				'if [ "$1" = "new-session" ]; then',
				'  : > "$TMUX_SERVER_STATE"',
				"  printf '$42\\n'",
				"fi",
				"exit 0",
				"",
			].join("\n"),
		);
		fs.chmodSync(tmux, 0o755);
		let probeCalls = 0;

		const resume = daemonResumeSession(
			{
				...process.env,
				GJC_TMUX_COMMAND: tmux,
				TMUX_CALLS: callsFile,
				TMUX_SERVER_STATE: serverState,
				TMUX_SERVER_PID: String(process.pid),
			},
			{
				sessionsRoot: root,
				ownerIsolationProbe: {
					readCallerCgroup: async () =>
						"0::/user.slice/user-1000.slice/user@1000.service/app.slice/gjc-lifecycle-test.scope\n",
					probeServer: async () =>
						++probeCalls === 1
							? { state: "absent" }
							: {
									state: "safe",
									pid: process.pid,
									startTime: "1",
									cgroup: { classification: "safe", scope: "/gjc-lifecycle-test.scope" },
									sessionNames: ["gjc_lc_abc123"],
								},
				},
			},
		);
		const result = await resume({ sessionIdOrPrefix: "abc123" });

		expect("mode" in result && result.mode).toBe("cold_restarted");
		const calls = fs.readFileSync(callsFile, "utf8");
		expect(probeCalls).toBe(8);
		expect(calls).toContain("new-session -d -P -F #{session_id} -s gjc_lc_abc123 sh -c");
		expect(calls).toContain("GJC_TMUX_LAUNCHED='1' GJC_NOTIFICATIONS='1'");
		expect(calls).toContain("GJC_COORDINATOR_SESSION_ID='abc123'");
		expect(calls).toContain("GJC_TMUX_OWNER_GENERATION=");
		expect(calls).toContain("GJC_TMUX_OWNER_STATE_DIR=");
		expect(calls).toContain("GJC_TMUX_OWNER_SERVER_KEY='default'");
		expect(calls).toContain("@gjc-owner-generation");
		expect(calls).toContain("@gjc-owner-server-key");
		expect(calls).not.toContain("GJC_OWNER_");
		expect(calls).toContain(`gjc --resume 'abc123'`);
		expect(calls).not.toContain("gjc-lifecycle-owner-isolation");
		expect(calls).toContain("@gjc-project");
		expect(fs.existsSync(serverState)).toBe(true);
		expect(calls.indexOf("new-session -d -P -F #{session_id} -s gjc_lc_abc123 sh -c")).toBeGreaterThanOrEqual(0);

		fs.rmSync(root, { recursive: true, force: true });
	});
	it("daemonResumeSession rejects a live session when its tmux server cannot be proven safe", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-resume-live-unverifiable-"));
		const callsFile = path.join(root, "tmux-calls.log");
		const tmux = path.join(root, "fake-tmux.sh");
		fs.writeFileSync(
			tmux,
			[
				"#!/usr/bin/env bash",
				'printf \'%s\\n\' "$*" >> "$TMUX_CALLS"',
				'if [ "$1" = "display-message" ]; then echo "not-a-pid"; exit 0; fi',
				"exit 0",
				"",
			].join("\n"),
		);
		fs.chmodSync(tmux, 0o755);
		const liveSession = tmuxStatus("gjc_lc_live123", "live123");

		await expect(
			daemonResumeSession(
				{ ...process.env, GJC_TMUX_COMMAND: tmux, TMUX_CALLS: callsFile },
				{
					listSessions: () => [liveSession],
					ownerIsolationProbe: {
						readCallerCgroup: async () => null,
						probeServer: async () => ({ state: "unverifiable" }),
					},
				},
			)({ sessionIdOrPrefix: "live123" }),
		).rejects.toThrow("gjc_lifecycle_owner_server_unverifiable");
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("daemonResumeSession rejects a live session when its target server is unsafe", async () => {
		const liveSession = tmuxStatus("gjc_lc_live-unsafe", "live-unsafe");
		await expect(
			daemonResumeSession(process.env, {
				listSessions: () => [liveSession],
				ownerIsolationProbe: {
					readCallerCgroup: async () => null,
					probeServer: async () => ({ state: "unsafe" }),
				},
			})({ sessionIdOrPrefix: "live-unsafe" }),
		).rejects.toThrow("gjc_lifecycle_owner_server_unsafe");
	});
	it("awaits daemon force-close before determining processGone", async () => {
		const closed = Promise.withResolvers<void>();
		let findCalls = 0;
		const result = daemonCloseSession(process.env, {
			forceClose: async () => await closed.promise,
			findSession: () => {
				findCalls++;
				return tmuxStatus("gjc_lc_close-1", "close-1");
			},
		})({ sessionId: "close-1", tmuxSession: "gjc_lc_close-1" });
		await Bun.sleep(0);
		expect(findCalls).toBe(0);
		closed.resolve();

		expect(await result).toEqual({ processGone: false });
		expect(findCalls).toBe(1);
	});

	it("propagates daemon force-close dispatch failures without a false processGone success", async () => {
		let findCalls = 0;
		await expect(
			daemonCloseSession(process.env, {
				forceClose: async () => {
					throw new Error("owner_term_verdict_timeout");
				},
				findSession: () => {
					findCalls++;
					return undefined;
				},
			})({ sessionId: "close-2" }),
		).rejects.toThrow("owner_term_verdict_timeout");
		expect(findCalls).toBe(0);
	});
	it("daemon create propagates one generation into canonical lifecycle state and the resident child", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-create-owner-"));
		const proj = path.join(root, "project");
		const callsFile = path.join(root, "tmux-calls.log");
		const tmux = path.join(root, "fake-tmux.sh");
		fs.mkdirSync(proj, { recursive: true });
		fs.writeFileSync(
			tmux,
			[
				"#!/usr/bin/env bash",
				'printf \'%s\\n\' "$*" >> "$TMUX_CALLS"',
				'if [ "$3" = "display-message" ]; then printf \'$42\\tgjc_lc_owner-123\\n\'; exit 0; fi',
				'if [ "$3" = "if-shell" ]; then printf "__gjc_lifecycle_metadata_ok__\\n"; exit 0; fi',

				'if [ "$1" = "new-session" ]; then printf \'$42\\n\'; fi',
				"exit 0",
				"",
			].join("\n"),
		);
		fs.chmodSync(tmux, 0o755);
		let probeCalls = 0;
		const result = await daemonSpawnCreate(
			{ ...process.env, GJC_TMUX_COMMAND: tmux, TMUX_CALLS: callsFile },
			{
				ownerIsolationProbe: {
					readCallerCgroup: async () => "/gjc-lifecycle-test.scope\n",
					probeServer: async () =>
						++probeCalls === 1
							? { state: "absent" }
							: {
									state: "safe",
									pid: process.pid,
									startTime: "1",
									cgroup: { classification: "safe", scope: "/gjc-lifecycle-test.scope" },
									sessionNames: ["gjc_lc_owner-123"],
								},
				},
			},
		)(createFrame({ target: { kind: "existing_path", path: proj } }), {
			lifecycleRequestId: "lc-owner",
			intendedSessionId: "owner-123",
		});

		expect(probeCalls).toBe(8);
		expect(result.sessionStateFile).toBe(
			path.join(proj, ".gjc", "_session-owner-123", "runtime", "tmux-sessions", "gjc-lc-owner-123.json"),
		);
		const generation = JSON.parse(
			fs.readFileSync(
				path.join(path.dirname(result.sessionStateFile!), "owner-123", "owner-lifecycle", "generation.json"),
				"utf8",
			),
		).generation;
		expect(generation).toMatch(/^[0-9a-f-]{36}$/);
		const calls = fs.readFileSync(callsFile, "utf8");
		expect(calls).toContain(`GJC_TMUX_OWNER_GENERATION='${generation}'`);
		expect(calls).toContain(`GJC_TMUX_OWNER_STATE_DIR='${path.dirname(result.sessionStateFile!)}'`);
		expect(calls).toContain("GJC_TMUX_OWNER_SERVER_KEY='default'");
		expect(calls).toContain("@gjc-owner-generation");
		expect(calls).toContain("@gjc-owner-server-key");
		expect(calls).not.toContain("GJC_OWNER_");
		expect(calls).toContain(`GJC_COORDINATOR_SESSION_STATE_FILE='${result.sessionStateFile}'`);
		expect(calls).not.toContain("gjc-lifecycle-owner-isolation");
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("cleans the immutable spawned session after post-spawn generation proof fails", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-lifecycle-stale-generation-"));
		const project = path.join(root, "project");
		const tmux = path.join(root, "fake-tmux.sh");
		const callsFile = path.join(root, "tmux-calls.log");
		const sessionId = "stale-123";
		const stateDir = path.join(project, ".gjc", `_session-${sessionId}`, "runtime", "tmux-sessions");
		const generationFile = path.join(stateDir, sessionId, "owner-lifecycle", "generation.json");
		fs.mkdirSync(project, { recursive: true });
		fs.mkdirSync(path.dirname(generationFile), { recursive: true });
		fs.writeFileSync(
			generationFile,
			JSON.stringify({
				schema_version: 1,
				generation: "prior",
				session_id: sessionId,
				published_at: "2026-07-11T00:00:00.000Z",
			}),
		);
		fs.writeFileSync(
			tmux,
			[
				"#!/usr/bin/env bash",
				'printf "%s\\n" "$*" >> "$TMUX_CALLS"',
				'if [ "$3" = "display-message" ]; then printf \'$42\\tgjc_lc_stale-123\\n\'; exit 0; fi',
				'if [[ "$*" == *"__gjc_lifecycle_cleanup_ok__"* ]]; then printf "__gjc_lifecycle_cleanup_ok__\\n"; exit 0; fi',
				'if [ "$3" = "if-shell" ]; then printf "__gjc_lifecycle_metadata_ok__\\n"; exit 0; fi',

				'if [ "$1" = "new-session" ]; then',
				'  printf \'{"schema_version":1,"generation":"replacement","session_id":"stale-123","published_at":"2026-07-11T00:00:00.000Z"}\\n\' > "$GENERATION_FILE"',
				"  printf '$42\\n'",
				"fi",
				"exit 0",
				"",
			].join("\n"),
		);
		fs.chmodSync(tmux, 0o755);
		let probeCalls = 0;
		try {
			await expect(
				daemonSpawnCreate(
					{
						...process.env,
						GJC_TMUX_COMMAND: tmux,
						TMUX_CALLS: callsFile,
						GENERATION_FILE: generationFile,
					},
					{
						ownerIsolationProbe: {
							readCallerCgroup: async () => "/gjc-lifecycle-test.scope\n",
							probeServer: async () =>
								++probeCalls === 1
									? { state: "absent" }
									: {
											state: "safe",
											pid: process.pid,
											startTime: "1",
											cgroup: { classification: "safe", scope: "/gjc-lifecycle-test.scope" },
											sessionNames: [`gjc_lc_${sessionId}`],
										},
						},
					},
				)(createFrame({ target: { kind: "existing_path", path: project } }), {
					lifecycleRequestId: "stale-generation",
					intendedSessionId: sessionId,
				}),
			).rejects.toThrow("gjc_lifecycle_owner_generation_changed");
			const calls = fs.readFileSync(callsFile, "utf8").trim().split("\n");
			expect(calls.filter(call => call.startsWith("new-session "))).toHaveLength(1);
			expect(
				calls.filter(
					call => call.startsWith("-L default if-shell ") && call.includes("__gjc_lifecycle_cleanup_ok__"),
				),
			).toHaveLength(1);
			expect(calls).not.toContain("-L default kill-session -t =$42");
			expect(JSON.parse(fs.readFileSync(generationFile, "utf8"))).toMatchObject({ generation: "replacement" });
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("fails create when required tmux owner metadata cannot be written", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-create-metadata-failure-"));
		const proj = path.join(root, "project");
		const tmux = path.join(root, "fake-tmux.sh");
		fs.mkdirSync(proj, { recursive: true });
		fs.writeFileSync(
			tmux,
			[
				"#!/usr/bin/env bash",
				'if [ "$3" = "display-message" ]; then printf \'$42\\tgjc_lc_metadata-123\\n\'; exit 0; fi',

				'if [ "$1" = "new-session" ]; then printf \'$42\\n\'; fi',
				'if [ "$1" = "set-option" ]; then exit 1; fi',
				'if [[ "$*" == *"__gjc_lifecycle_cleanup_ok__"* ]]; then printf "__gjc_lifecycle_cleanup_ok__\\n"; exit 0; fi',
				"exit 0",
				"",
			].join("\n"),
		);
		fs.chmodSync(tmux, 0o755);
		let probeCalls = 0;

		await expect(
			daemonSpawnCreate(
				{ ...process.env, GJC_TMUX_COMMAND: tmux },
				{
					ownerIsolationProbe: {
						readCallerCgroup: async () => "/gjc-lifecycle-test.scope\n",
						probeServer: async () =>
							++probeCalls === 1
								? { state: "absent" }
								: {
										state: "safe",
										pid: process.pid,
										startTime: "1",
										cgroup: { classification: "safe", scope: "/gjc-lifecycle-test.scope" },
										sessionNames: ["gjc_lc_metadata-123"],
									},
					},
				},
			)(createFrame({ target: { kind: "existing_path", path: proj } }), {
				lifecycleRequestId: "lc-metadata",
				intendedSessionId: "metadata-123",
			}),
		).rejects.toThrow("gjc_lifecycle_metadata_write_failed");
		fs.rmSync(root, { recursive: true, force: true });
	});
	it("refuses unsafe or unverifiable servers before daemon create or cold-resume can mutate tmux", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-pre-mutation-refusal-"));
		const project = path.join(root, "project");
		const callsFile = path.join(root, "tmux-calls.log");
		const tmux = path.join(root, "fake-tmux.sh");
		fs.mkdirSync(project, { recursive: true });
		await writeManagedSession(root, project, "resume-123");
		fs.writeFileSync(tmux, ["#!/usr/bin/env bash", 'printf "%s\\n" "$*" >> "$TMUX_CALLS"', "exit 0", ""].join("\n"));
		fs.chmodSync(tmux, 0o755);
		try {
			for (const state of ["unsafe", "unverifiable"] as const) {
				const probe = {
					readCallerCgroup: async () => "/gjc-lifecycle-test.scope\n",
					probeServer: async () => ({ state }),
				};
				await expect(
					daemonSpawnCreate(
						{ ...process.env, GJC_TMUX_COMMAND: tmux, TMUX_CALLS: callsFile },
						{ ownerIsolationProbe: probe },
					)(createFrame({ target: { kind: "existing_path", path: project } }), {
						lifecycleRequestId: `create-${state}`,
						intendedSessionId: `create-${state}`,
					}),
				).rejects.toThrow(`gjc_lifecycle_owner_server_${state}`);
				const uncreatedPlainDir = path.join(root, `plain-${state}`);
				await expect(
					daemonSpawnCreate(
						{ ...process.env, GJC_TMUX_COMMAND: tmux, TMUX_CALLS: callsFile },
						{ ownerIsolationProbe: probe },
					)(createFrame({ target: { kind: "plain_dir", path: uncreatedPlainDir } }), {
						lifecycleRequestId: `plain-${state}`,
						intendedSessionId: `plain-${state}`,
					}),
				).rejects.toThrow(`gjc_lifecycle_owner_server_${state}`);
				expect(fs.existsSync(uncreatedPlainDir)).toBe(false);
				await expect(
					daemonResumeSession(
						{ ...process.env, GJC_TMUX_COMMAND: tmux, TMUX_CALLS: callsFile },
						{ sessionsRoot: root, listSessions: () => [], ownerIsolationProbe: probe },
					)({ sessionIdOrPrefix: "resume-123", path: project }),
				).rejects.toThrow(`gjc_lifecycle_owner_server_${state}`);
			}
			expect(fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8") : "").toBe("");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("writes no create ownership tags when a replacement server reuses the native session before the guarded metadata queue", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-required-metadata-"));
		const project = path.join(root, "project");
		const callsFile = path.join(root, "tmux-calls.log");
		const tmux = path.join(root, "fake-tmux.sh");
		fs.mkdirSync(project, { recursive: true });
		fs.writeFileSync(
			tmux,
			[
				"#!/usr/bin/env bash",
				'printf "%s\\n" "$*" >> "$TMUX_CALLS"',
				'if [ "$3" = "display-message" ]; then printf \'$42\\tgjc_lc_metadata-refusal\\n\'; exit 0; fi',
				'if [ "$1" = "new-session" ]; then printf \'$42\\n\'; exit 0; fi',
				'if [ "$3" = "if-shell" ]; then printf "__gjc_lifecycle_metadata_refused__\\n"; exit 0; fi',
				"exit 0",
				"",
			].join("\n"),
		);
		fs.chmodSync(tmux, 0o755);
		let probeCalls = 0;
		try {
			await expect(
				daemonSpawnCreate(
					{ ...process.env, GJC_TMUX_COMMAND: tmux, TMUX_CALLS: callsFile },
					{
						ownerIsolationProbe: {
							readCallerCgroup: async () => "/gjc-lifecycle-test.scope\n",
							probeServer: async () => {
								probeCalls++;
								return {
									state: "safe" as const,
									pid: probeCalls > 6 ? process.pid + 1 : process.pid,
									startTime: "1",
									cgroup: { classification: "safe" as const },
									sessionNames: ["gjc_lc_metadata-refusal"],
								};
							},
						},
					},
				)(createFrame({ target: { kind: "existing_path", path: project } }), {
					lifecycleRequestId: "metadata-refusal",
					intendedSessionId: "metadata-refusal",
				}),
			).rejects.toThrow("gjc_lifecycle_cleanup_uncertain");
			const calls = fs.readFileSync(callsFile, "utf8").trim().split("\n");
			const guarded = calls.filter(call => call.startsWith("-L default if-shell "));
			expect(guarded).toHaveLength(1);
			expect(calls.filter(call => call.startsWith("set-option "))).toEqual([]);
			expect(calls.filter(call => call === "-L default kill-session -t =$42")).toEqual([]);
			expect(guarded[0]).toContain(`#{pid},${process.pid}`);
			expect(guarded[0]).toContain("#{session_id},$42");
			expect(guarded[0]).toContain("#{session_name},gjc_lc_metadata-refusal");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("writes no cold-resume ownership tags when a replacement server reuses the native session before metadata", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-cold-resume-metadata-"));
		const project = path.join(root, "project");
		const callsFile = path.join(root, "tmux-calls.log");
		const tmux = path.join(root, "fake-tmux.sh");
		fs.mkdirSync(project, { recursive: true });
		await writeManagedSession(root, project, "resume-replacement");
		fs.writeFileSync(
			tmux,
			[
				"#!/usr/bin/env bash",
				'printf "%s\\n" "$*" >> "$TMUX_CALLS"',
				'if [ "$3" = "display-message" ]; then printf \'$42\\tgjc_lc_resume-replacement\\n\'; exit 0; fi',
				'if [ "$1" = "new-session" ]; then printf \'$42\\n\'; exit 0; fi',
				"# Simulate the replacement server rejecting the guarded predicates before any tag command executes.",
				'if [ "$3" = "if-shell" ]; then printf "__gjc_lifecycle_metadata_refused__\\n"; exit 0; fi',
				"exit 0",
				"",
			].join("\n"),
		);
		fs.chmodSync(tmux, 0o755);
		let probeCalls = 0;
		try {
			await expect(
				daemonResumeSession(
					{ ...process.env, GJC_TMUX_COMMAND: tmux, TMUX_CALLS: callsFile },
					{
						sessionsRoot: root,
						listSessions: () => [],
						ownerIsolationProbe: {
							readCallerCgroup: async () => "/gjc-lifecycle-test.scope\n",
							probeServer: async () => {
								probeCalls++;
								return {
									state: "safe" as const,
									pid: probeCalls > 6 ? process.pid + 1 : process.pid,
									startTime: "1",
									cgroup: { classification: "safe" as const },
									sessionNames: ["gjc_lc_resume-replacement"],
								};
							},
						},
					},
				)({ sessionIdOrPrefix: "resume-replacement", path: project }),
			).rejects.toThrow("gjc_lifecycle_cleanup_uncertain");
			const calls = fs.readFileSync(callsFile, "utf8").trim().split("\n");
			const guarded = calls.filter(call => call.startsWith("-L default if-shell "));
			expect(guarded).toHaveLength(1);
			expect(guarded[0]).toContain(`#{pid},${process.pid}`);
			expect(guarded[0]).toContain("#{session_id},$42");
			expect(guarded[0]).toContain("#{session_name},gjc_lc_resume-replacement");
			expect(calls.filter(call => call.startsWith("set-option "))).toEqual([]);
			expect(calls.filter(call => call === "-L default kill-session -t =$42")).toEqual([]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses psmux before create or cold-resume can mutate lifecycle state", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-lifecycle-psmux-"));
		const project = path.join(root, "project");
		const psmux = path.join(root, "psmux");
		const plain = path.join(root, "plain");
		fs.mkdirSync(project, { recursive: true });
		await writeManagedSession(root, project, "resume-123");
		fs.writeFileSync(psmux, "#!/usr/bin/env bash\nexit 99\n");
		fs.chmodSync(psmux, 0o755);
		const env = { ...process.env, GJC_TMUX_COMMAND: psmux, GJC_PSMUX_COMMAND: psmux };
		try {
			await expect(
				daemonSpawnCreate(env)(createFrame({ target: { kind: "plain_dir", path: plain } }), {
					lifecycleRequestId: "psmux-create",
					intendedSessionId: "psmux-create",
				}),
			).rejects.toThrow("gjc_lifecycle_psmux_unsupported");
			let listSessionsCalled = false;
			await expect(
				daemonResumeSession(env, {
					sessionsRoot: root,
					listSessions: () => {
						listSessionsCalled = true;
						return [];
					},
				})({
					sessionIdOrPrefix: "resume-123",
					path: project,
				}),
			).rejects.toThrow("gjc_lifecycle_psmux_unsupported");
			expect(listSessionsCalled).toBe(false);
			await expect(
				daemonResumeSession(env, {
					sessionsRoot: root,
					listSessions: () => {
						listSessionsCalled = true;
						return [];
					},
				})({
					sessionIdOrPrefix: "resume-123",
				}),
			).rejects.toThrow("gjc_lifecycle_psmux_unsupported");
			expect(listSessionsCalled).toBe(false);
			expect(fs.existsSync(plain)).toBe(false);
			expect(fs.existsSync(path.join(project, ".gjc"))).toBe(false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects missing or noisy native receipts with cleanup uncertainty and no generation publication", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-lifecycle-receipt-"));
		const project = path.join(root, "project");
		const tmux = path.join(root, "fake-tmux.sh");
		const calls = path.join(root, "calls.log");
		fs.mkdirSync(project, { recursive: true });
		fs.writeFileSync(
			tmux,
			[
				"#!/usr/bin/env bash",
				'printf "%s\\n" "$*" >> "$TMUX_CALLS"',
				'if [ "$3" = "display-message" ]; then printf \'$43\\tgjc_lc_receipt-123\\n\'; exit 0; fi',

				'if [ "$1" = "new-session" ]; then printf "$RECEIPT"; fi',
				"exit 0",
				"",
			].join("\n"),
		);
		fs.chmodSync(tmux, 0o755);
		try {
			for (const receipt of ["", "$42\n", " $42\n", "$42\n\n", "$42\nnoise"]) {
				fs.rmSync(calls, { force: true });
				await expect(
					daemonSpawnCreate(
						{ ...process.env, GJC_TMUX_COMMAND: tmux, TMUX_CALLS: calls, RECEIPT: receipt },
						{
							ownerIsolationProbe: {
								readCallerCgroup: async () => "/gjc-lifecycle-test.scope\n",
								probeServer: async () => ({
									state: "safe" as const,
									pid: process.pid,
									startTime: "1",
									cgroup: { classification: "safe" as const },
									sessionNames: ["gjc_lc_receipt-123"],
								}),
							},
						},
					)(createFrame({ target: { kind: "existing_path", path: project } }), {
						lifecycleRequestId: "receipt",
						intendedSessionId: "receipt-123",
					}),
				).rejects.toThrow("gjc_lifecycle_cleanup_uncertain");
				const logged = fs.readFileSync(calls, "utf8");
				expect(logged).toContain("new-session");
				expect(logged).not.toContain("kill-session");
				expect(logged).not.toContain("set-option");
			}
			expect(fs.existsSync(path.join(project, ".gjc"))).toBe(false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("combines required metadata failure with cleanup preproof or guarded-mutation uncertainty", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-lifecycle-cleanup-"));
		const project = path.join(root, "project");
		const tmux = path.join(root, "fake-tmux.sh");
		const calls = path.join(root, "calls.log");
		fs.mkdirSync(project, { recursive: true });
		fs.writeFileSync(
			tmux,
			[
				"#!/usr/bin/env bash",
				'printf "%s\\n" "$*" >> "$TMUX_CALLS"',
				'if [ "$3" = "display-message" ]; then printf \'$42\\tgjc_lc_cleanup-123\\n\'; exit 0; fi',
				'if [ "$1" = "new-session" ]; then printf \'$42\\n\'; fi',
				'if [ "$1" = "set-option" ]; then exit 1; fi',
				'if [[ "$*" == *"__gjc_lifecycle_cleanup_ok__"* ]] && [ "$KILL_FAIL" = "1" ]; then exit 1; fi',
				"exit 0",
				"",
			].join("\n"),
		);
		fs.chmodSync(tmux, 0o755);
		try {
			for (const cleanup of ["proof", "kill"] as const) {
				fs.rmSync(calls, { force: true });
				let probeCalls = 0;
				await expect(
					daemonSpawnCreate(
						{
							...process.env,
							GJC_TMUX_COMMAND: tmux,
							TMUX_CALLS: calls,
							KILL_FAIL: cleanup === "kill" ? "1" : "0",
						},
						{
							ownerIsolationProbe: {
								readCallerCgroup: async () => "/gjc-lifecycle-test.scope\n",
								probeServer: async () => {
									probeCalls += 1;
									if (cleanup === "proof" && probeCalls >= 6) throw new Error("probe lost");
									return {
										state: "safe" as const,
										pid: process.pid,
										startTime: "1",
										cgroup: { classification: "safe" as const },
										sessionNames: ["gjc_lc_cleanup-123"],
									};
								},
							},
						},
					)(createFrame({ target: { kind: "existing_path", path: project } }), {
						lifecycleRequestId: `cleanup-${cleanup}`,
						intendedSessionId: "cleanup-123",
					}),
				).rejects.toThrow("gjc_lifecycle_cleanup_uncertain");
				const logged = fs.readFileSync(calls, "utf8");
				const guarded = logged
					.split("\n")
					.filter(
						call => call.startsWith("-L default if-shell ") && call.includes("__gjc_lifecycle_cleanup_ok__"),
					);
				expect(guarded).toHaveLength(cleanup === "kill" ? 1 : 0);
				expect(logged).not.toContain("-L default kill-session -t =$42");
			}
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses cleanup when a replacement arrives between external preproof and the guarded mutation", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-lifecycle-cleanup-replacement-"));
		const project = path.join(root, "project");
		const tmux = path.join(root, "fake-tmux.sh");
		const calls = path.join(root, "calls.log");
		fs.mkdirSync(project, { recursive: true });
		fs.writeFileSync(
			tmux,
			[
				"#!/usr/bin/env bash",
				'printf "%s\\n" "$*" >> "$TMUX_CALLS"',
				'if [ "$3" = "display-message" ]; then printf \'$42\\tgjc_lc_cleanup-replacement\\n\'; exit 0; fi',
				'if [ "$1" = "new-session" ]; then printf \'$42\\n\'; exit 0; fi',
				"# The external proof passed, but the replacement server rejects cleanup atomically.",
				'if [[ "$*" == *"__gjc_lifecycle_cleanup_ok__"* ]]; then printf "__gjc_lifecycle_cleanup_refused__\\n"; exit 0; fi',
				'if [ "$3" = "if-shell" ]; then printf "__gjc_lifecycle_metadata_refused__\\n"; exit 0; fi',
				"exit 0",
				"",
			].join("\n"),
		);
		fs.chmodSync(tmux, 0o755);
		try {
			await expect(
				daemonSpawnCreate(
					{ ...process.env, GJC_TMUX_COMMAND: tmux, TMUX_CALLS: calls },
					{
						ownerIsolationProbe: {
							readCallerCgroup: async () => "/gjc-lifecycle-test.scope\n",
							probeServer: async () => ({
								state: "safe" as const,
								pid: process.pid,
								startTime: "1",
								cgroup: { classification: "safe" as const },
								sessionNames: ["gjc_lc_cleanup-replacement"],
							}),
						},
					},
				)(createFrame({ target: { kind: "existing_path", path: project } }), {
					lifecycleRequestId: "cleanup-replacement",
					intendedSessionId: "cleanup-replacement",
				}),
			).rejects.toThrow("gjc_lifecycle_cleanup_uncertain");
			const logged = fs.readFileSync(calls, "utf8").trim().split("\n");
			const guarded = logged.filter(
				call => call.startsWith("-L default if-shell ") && call.includes("__gjc_lifecycle_cleanup_ok__"),
			);
			expect(guarded).toHaveLength(1);
			expect(guarded[0]).toContain(`#{pid},${process.pid}`);
			expect(guarded[0]).toContain("#{session_id},$42");
			expect(guarded[0]).toContain("#{session_name},gjc_lc_cleanup-replacement");
			expect(logged).not.toContain("-L default kill-session -t =$42");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not publish generation when the tmux server changes during metadata writes", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-lifecycle-metadata-race-"));
		const project = path.join(root, "project");
		const tmux = path.join(root, "fake-tmux.sh");
		fs.mkdirSync(project, { recursive: true });
		fs.writeFileSync(
			tmux,
			[
				"#!/usr/bin/env bash",
				'if [ "$3" = "display-message" ]; then printf \'$42\\tgjc_lc_metadata-race\\n\'; exit 0; fi',
				'if [ "$1" = "new-session" ]; then printf \'$42\\n\'; fi',
				"exit 0",
				"",
			].join("\n"),
		);
		fs.chmodSync(tmux, 0o755);
		let probeCalls = 0;
		try {
			await expect(
				daemonSpawnCreate(
					{ ...process.env, GJC_TMUX_COMMAND: tmux },
					{
						ownerIsolationProbe: {
							readCallerCgroup: async () => "/gjc-lifecycle-test.scope\n",
							probeServer: async () => {
								probeCalls += 1;
								return {
									state: "safe" as const,
									pid: probeCalls > 5 ? process.pid + 1 : process.pid,
									startTime: "1",
									cgroup: { classification: "safe" as const },
									sessionNames: ["gjc_lc_metadata-race"],
								};
							},
						},
					},
				)(createFrame({ target: { kind: "existing_path", path: project } }), {
					lifecycleRequestId: "metadata-race",
					intendedSessionId: "metadata-race",
				}),
			).rejects.toThrow("gjc_lifecycle_cleanup_uncertain");
			expect(
				fs.existsSync(
					path.join(
						project,
						".gjc",
						"_session-metadata-race",
						"runtime",
						"tmux-sessions",
						"metadata-race",
						"owner-lifecycle",
						"generation.json",
					),
				),
			).toBe(false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("forwards exact daemon force-close provenance without defaulting a target", async () => {
		const received: unknown[][] = [];
		const env = { TEST_OWNER: "private", GJC_TMUX_SESSION: "not-a-default" };
		await daemonCloseSession(env, {
			forceClose: async (...args) => {
				received.push(args);
			},
			findSession: () => undefined,
		})({ sessionId: "exact-id", tmuxSession: "gjc_lc_exact-id", sessionStateFile: "/private/exact.json" });
		expect(received).toEqual([["gjc_lc_exact-id", env, "exact-id", "/private/exact.json"]]);
	});
});
