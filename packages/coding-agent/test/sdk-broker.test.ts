import { describe, expect, it, vi } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import * as native from "@gajae-code/natives";
import { getSessionsDir } from "@gajae-code/utils";

import { lifecycleArgs } from "../src/commands/sdk";
import { Broker, type BrokerResponse, setPublicationObservationForTest } from "../src/sdk/broker/broker";
import * as brokerDiscovery from "../src/sdk/broker/discovery";
import {
	type BrokerDiscovery,
	brokerDiscoveryPath,
	publishBrokerDiscovery,
	readBrokerDiscovery,
	redactBrokerDiscovery,
	writeBrokerDiscovery,
} from "../src/sdk/broker/discovery";
import {
	brokerOwnerForTest,
	brokerSpawnEnvironmentForTest,
	ensureBroker,
	reapSpawnedBrokerForTest,
	registerBrokerOwnerForTest,
	startFixtureBrokerWithLeaseForTest,
} from "../src/sdk/broker/ensure";
import { getBrokerIdentityKey } from "../src/sdk/broker/identity";
import { completeBrokerProcess } from "../src/sdk/broker/internal";
import {
	deriveLifecycleDeadlines,
	readSessionLifecycleLaunchRequest,
	type SessionLifecycleLaunchRequest,
	terminalUncertainStartupMessage,
	waitForChildSpawn,
} from "../src/sdk/broker/lifecycle";
import { LifecycleLedger } from "../src/sdk/broker/lifecycle-ledger";
import { resolveSdkInternalSpawnCommand, resolveSdkInternalSpawnCommandForTest } from "../src/sdk/broker/runtime";
import { readBrokerStartupFailureMarker, writeBrokerStartupFailureMarker } from "../src/sdk/broker/startup-failure";
import { prepareManagedSessionScopeForWrite, resolveManagedScope } from "../src/session/internal/managed-session-scope";
import { SessionManager } from "../src/session/session-manager";
import {
	FileSessionStorage,
	SessionDeleteVerificationError,
	type VerifiedSessionDeleteTarget,
} from "../src/session/session-storage";

const temp = () => fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-"));

it("does not disclose launch paths when cleanup remains uncertain", () => {
	const executable = "/private/runtime/gjc-secret";
	const message = terminalUncertainStartupMessage({
		ok: false,
		error: { code: "spawn_failed", message: `spawn ${executable} ENOENT` },
	});
	expect(message).toBe(
		"Lifecycle startup cleanup could not be proven; retained artifacts require reconciliation. Original launch failure: SDK internal process could not be started.",
	);
	expect(message).not.toContain(executable);
});

it("retains an error handler after a child reports successful spawn", async () => {
	const child = new EventEmitter();
	const postSpawnErrors: string[] = [];
	const spawned = waitForChildSpawn(child as unknown as Pick<ChildProcess, "off" | "on" | "once">, error =>
		postSpawnErrors.push(error.message),
	);
	child.emit("spawn");
	await spawned;
	expect(child.listenerCount("error")).toBe(1);
	child.emit("error", new Error("late child failure"));
	expect(postSpawnErrors).toEqual(["late child failure"]);
});
async function managedSessionPath(agentDir: string, cwd: string, sessionId: string): Promise<string> {
	await fs.mkdir(cwd, { recursive: true });
	const sessionsRoot = getSessionsDir(agentDir);
	const resolved = resolveManagedScope({ cwd, agentDir, sessionsRoot });
	if (resolved.kind !== "resolved") throw new Error(resolved.message);
	const prepared = await prepareManagedSessionScopeForWrite(resolved.scope);
	if (prepared.kind !== "resolved") throw new Error(prepared.message);
	return path.join(prepared.scope.directoryPath, `${sessionId}.jsonl`);
}
async function settleRetainedTranscriptForTest(
	broker: Broker,
	input: { sessionId: string; sessionPath: string; cwd: string },
	key: string,
	response: BrokerResponse,
	fallbackExactUnlink?: typeof native.exactUnlink,
): Promise<BrokerResponse> {
	let current = response;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		if (current.ok || current.error.code !== "cleanup_pending" || current.error.cleanup?.phase !== "transcript")
			return current;
		const cleanup = current.error.cleanup;
		if (cleanup.retainedTranscriptPlaceholderPath && syncFs.existsSync(cleanup.retainedTranscriptPlaceholderPath)) {
			const placeholder = syncFs.lstatSync(cleanup.retainedTranscriptPlaceholderPath, { bigint: true });
			const parent = syncFs.lstatSync(path.dirname(cleanup.retainedTranscriptPlaceholderPath), { bigint: true });
			if (
				!placeholder.isFile() ||
				placeholder.nlink !== 1n ||
				placeholder.size !== 0n ||
				!cleanup.transcriptParentIdentity ||
				parent.dev.toString() !== cleanup.transcriptParentIdentity.dev ||
				parent.ino.toString() !== cleanup.transcriptParentIdentity.ino
			)
				throw new Error("Broker test placeholder lacks exact native authority");
			syncFs.rmSync(cleanup.retainedTranscriptPlaceholderPath);
		}
		const previousExactUnlink = fallbackExactUnlink ?? native.exactUnlink.bind(native);
		const unlink = vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
			if (path.dirname(pathname) !== path.dirname(input.sessionPath)) return previousExactUnlink(pathname, identity);
			const parent = syncFs.lstatSync(path.dirname(pathname), { bigint: true });
			const stat = syncFs.lstatSync(pathname, { bigint: true });
			if (
				identity.parentDev === undefined ||
				identity.parentIno === undefined ||
				parent.dev !== identity.parentDev ||
				parent.ino !== identity.parentIno ||
				stat.dev !== identity.dev ||
				stat.ino !== identity.ino ||
				(identity.nlink !== undefined && stat.nlink !== identity.nlink) ||
				stat.size > identity.size
			)
				throw new Error("Broker test cleanup lacks exact native authority");
			if (identity.sha256 && stat.size !== 0n) {
				const digest = createHash("sha256").update(syncFs.readFileSync(pathname)).digest("hex");
				if (digest !== identity.sha256) throw new Error("Broker test cleanup digest changed");
			}
			syncFs.rmSync(pathname, { force: true });
			return { ok: true };
		});
		try {
			current = await broker.handleRequest("session.delete", input, key);
		} finally {
			unlink.mockRestore();
		}
	}
	return current;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const brokerEntrypoint = path.resolve(import.meta.dir, "../src/cli.ts");
const BROKER_PROCESS_STARTUP_TIMEOUT_MS = 10_000;

it("isolates source SDK children and preserves compiled self-spawn", () => {
	const sourceEnvironment = {
		...process.env,
		BUN_OPTIONS: "--inspect",
		PI_COMPILED: "1",
		GJC_COMPILED: "1",
	};
	const source = resolveSdkInternalSpawnCommandForTest("broker-internal", { environment: sourceEnvironment });
	expect(source.kind).toBe("bun-source");
	expect(source.file).toBe(process.execPath);
	expect(source.args).toEqual([
		"--no-env-file",
		`--config=${path.resolve(import.meta.dir, "../src/sdk/broker/internal-source.bunfig.toml")}`,
		path.resolve(import.meta.dir, "../src/cli.ts"),
		"sdk",
		"broker-internal",
	]);
	expect(source.env.BUN_OPTIONS).toBeUndefined();
	expect(source.env.PI_COMPILED).toBeUndefined();
	expect(source.env.GJC_COMPILED).toBeUndefined();
	expect(source.cwd).toBe(path.resolve(import.meta.dir, "../src/sdk/broker"));
	expect(resolveSdkInternalSpawnCommand("broker-internal")).toMatchObject({
		kind: "bun-source",
		file: process.execPath,
	});

	const environment = { PATH: process.env.PATH, BUN_OPTIONS: "--inspect", PI_COMPILED: "spoofed" };
	const markerPath = "/$bunfs/root/internal-source-marker-2178-abcd.txt";
	const compiled = resolveSdkInternalSpawnCommandForTest("session-host-internal", {
		execPath: process.execPath,
		environment,
		markerPath,
		embeddedFiles: [{ name: path.basename(markerPath) }],
	});
	expect(compiled).toEqual({
		kind: "compiled",
		file: process.execPath,
		args: ["sdk", "session-host-internal"],
		env: { PATH: process.env.PATH, PI_COMPILED: "spoofed" },
		generation: expect.any(String),
		packageVersion: expect.any(String),
		installationIdentity: process.execPath,
	});
	expect(compiled.env.BUN_OPTIONS).toBeUndefined();
	const windowsMarkerPath = "C:/~BUN/root/internal-source-marker-2178-abcd.txt";
	expect(
		resolveSdkInternalSpawnCommandForTest("broker-internal", {
			execPath: process.execPath,
			environment,
			markerPath: windowsMarkerPath,
			embeddedFiles: [{ name: path.basename(windowsMarkerPath) }],
		}),
	).toEqual({
		kind: "compiled",
		file: process.execPath,
		args: ["sdk", "broker-internal"],
		env: { PATH: process.env.PATH, PI_COMPILED: "spoofed" },
		generation: expect.any(String),
		packageVersion: expect.any(String),
		installationIdentity: process.execPath,
	});
});

it("uses the native current executable for exact compiled-marker-authorized Bun virtual executable paths", () => {
	const markerPath = "/$bunfs/root/internal-source-marker-2178-abcd.txt";
	const executable = native.currentExecutablePath();
	if (!executable) throw new Error("Expected native current executable identity.");
	expect(
		resolveSdkInternalSpawnCommandForTest("session-host-internal", {
			execPath: "/$bunfs/root/gjc",
			markerPath,
			embeddedFiles: [{ name: path.basename(markerPath) }],
		}),
	).toMatchObject({ kind: "compiled", file: executable });
});

it("treats explicit broker env as a complete allowlist and still scrubs runtime options", () => {
	const command = resolveSdkInternalSpawnCommandForTest("broker-internal", {
		environment: { AMBIENT_SENTINEL: "must-not-leak" },
	});
	const environment = brokerSpawnEnvironmentForTest(command, {
		PATH: process.env.PATH,
		OWNED_SENTINEL: "kept",
		BUN_OPTIONS: "--inspect",
		PI_COMPILED: "spoofed",
		GJC_COMPILED: "spoofed",
	});
	expect(environment).toEqual({ PATH: process.env.PATH, OWNED_SENTINEL: "kept" });
	expect(environment.AMBIENT_SENTINEL).toBeUndefined();
});

it("fails closed when compiled marker evidence disagrees", () => {
	expect(() =>
		resolveSdkInternalSpawnCommandForTest("broker-internal", {
			markerPath: "/$bunfs/root/internal-source-marker-2178-abcd.txt",
			embeddedFiles: [],
		}),
	).toThrow("compiled-runtime marker evidence is inconsistent");
	expect(() =>
		resolveSdkInternalSpawnCommandForTest("broker-internal", {
			markerPath: path.join(import.meta.dir, "../src/sdk/broker/internal-source-marker-2178.txt"),
			embeddedFiles: [{ name: "internal-source-marker-2178.txt" }],
		}),
	).toThrow("compiled-runtime marker evidence is inconsistent");
	for (const evidence of [
		{
			markerPath: "/$bunfs/root/nested/internal-source-marker-2178-abcd.txt",
			embeddedFiles: [{ name: "internal-source-marker-2178-abcd.txt" }],
		},
		{
			markerPath: "/$bunfs/root/internal-source-marker-2178.txt",
			embeddedFiles: [{ name: "internal-source-marker-2178.txt" }],
		},
		{
			markerPath: "C:/project/~BUN/root/internal-source-marker-2178-abcd.txt",
			embeddedFiles: [{ name: "internal-source-marker-2178-abcd.txt" }],
		},
		{
			markerPath: "/$bunfs/root/internal-source-marker-2178-abcd.txt",
			embeddedFiles: [
				{ name: "internal-source-marker-2178-abcd.txt" },
				{ name: "internal-source-marker-2178-abcd.txt" },
			],
		},
	]) {
		expect(() => resolveSdkInternalSpawnCommandForTest("broker-internal", evidence)).toThrow(
			"compiled-runtime marker evidence is inconsistent",
		);
	}
});

it("SDK lifecycle model presets reach the session host parser", async () => {
	const agentDir = await temp();
	const cwd = path.join(agentDir, "repo");
	await fs.mkdir(cwd);
	const request = readSessionLifecycleLaunchRequest(
		JSON.stringify({
			operation: "session.create",
			sessionId: "session-1",
			stateRoot: path.join(cwd, ".gjc", "state"),
			cwd,
			modelPreset: "codex-eco",
			...deriveLifecycleDeadlines(Date.now(), 10_000),
		}),
	);
	try {
		expect((await lifecycleArgs(request, cwd, agentDir)).mpreset).toBe("codex-eco");
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

it("SDK lifecycle explicit model pins reach the session host parser and validate shape", async () => {
	const agentDir = await temp();
	const cwd = path.join(agentDir, "repo");
	await fs.mkdir(cwd);
	const request = readSessionLifecycleLaunchRequest(
		JSON.stringify({
			operation: "session.create",
			sessionId: "session-1",
			stateRoot: path.join(cwd, ".gjc", "state"),
			cwd,
			modelId: "cursor/claude-fable-5-xhigh",
			...deriveLifecycleDeadlines(Date.now(), 10_000),
		}),
	);
	try {
		expect(request.modelId).toBe("cursor/claude-fable-5-xhigh");
		expect((await lifecycleArgs(request, cwd, agentDir)).model).toBe("cursor/claude-fable-5-xhigh");
		expect(() =>
			readSessionLifecycleLaunchRequest(
				JSON.stringify({
					...request,
					modelId: "   ",
				}),
			),
		).toThrow("GJC_SDK_LIFECYCLE_REQUEST is invalid.");
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

it("SDK broker resolves explicit model pins at the host boundary", async () => {
	const agentDir = await temp();
	await fs.mkdir(agentDir, { recursive: true });
	await fs.writeFile(
		path.join(agentDir, "models.yml"),
		"providers:\n  fixture:\n    baseUrl: http://127.0.0.1:1/v1\n    apiKey: fixture-key\n    api: openai-completions\n    models:\n      - id: broker-model\n        name: Broker Model\n        contextWindow: 32768\n        maxTokens: 4096\n",
	);
	const broker = new Broker({ agentDir });
	try {
		await expect(broker.handleRequest("model.resolve", { model: "fixture/broker-model" })).resolves.toMatchObject({
			ok: true,
			result: { ok: true, model: "fixture/broker-model" },
		});
		await expect(broker.handleRequest("model.resolve", { model: "cursor/default" })).resolves.toMatchObject({
			ok: true,
			result: { ok: true, model: "cursor/default" },
		});
		await expect(broker.handleRequest("model.resolve", { model: "cursor:not-a-model" })).resolves.toMatchObject({
			ok: true,
			result: { ok: false, reason: "unknown_model", model: "cursor:not-a-model" },
		});
	} finally {
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

it("SDK broker scopes canonical alias ranking to its agent directory settings", async () => {
	const agentDir = await temp();
	await fs.mkdir(agentDir, { recursive: true });
	await fs.writeFile(
		path.join(agentDir, "models.yml"),
		"providers:\n  fixture-a:\n    baseUrl: http://127.0.0.1:1/v1\n    apiKey: fixture-key\n    api: openai-completions\n    models:\n      - id: shared\n        name: shared\n        contextWindow: 32768\n        maxTokens: 4096\n  fixture-b:\n    baseUrl: http://127.0.0.1:1/v1\n    apiKey: fixture-key\n    api: openai-completions\n    models:\n      - id: shared\n        name: shared\n        contextWindow: 32768\n        maxTokens: 4096\n",
	);
	await fs.writeFile(path.join(agentDir, "config.yml"), "modelProviderOrder:\n  - fixture-b\n");
	const broker = new Broker({ agentDir });
	try {
		await expect(broker.handleRequest("model.resolve", { model: "shared" })).resolves.toMatchObject({
			ok: true,
			result: { ok: true, model: "fixture-b/shared" },
		});
	} finally {
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

it("SDK lifecycle launch requests preserve validated ACP MCP transports", async () => {
	const agentDir = await temp();
	const cwd = path.join(agentDir, "repo");
	await fs.mkdir(cwd);
	const request: SessionLifecycleLaunchRequest = {
		operation: "session.create",
		sessionId: "session-1",
		stateRoot: path.join(cwd, ".gjc", "state"),
		cwd,
		mcpServers: [
			{
				name: "Air",
				command: "/Applications/Air.app/Contents/bin/mcp-proxy",
				args: ["--stdio"],
				env: { AIR_MODE: "acp" },
			},
			{
				type: "http",
				name: "remote",
				url: "https://mcp.example.test/api",
				headers: { Authorization: "Bearer test" },
			},
			{ type: "sse", name: "legacy", url: "http://127.0.0.1:7337/events" },
		],
		...deriveLifecycleDeadlines(Date.now(), 10_000),
	};
	try {
		expect(readSessionLifecycleLaunchRequest(JSON.stringify(request)).mcpServers).toEqual(request.mcpServers);
		expect(() =>
			readSessionLifecycleLaunchRequest(
				JSON.stringify({
					...request,
					mcpServers: [{ name: "Air", command: "relative-command", args: [] }],
				}),
			),
		).toThrow("GJC_SDK_LIFECYCLE_REQUEST is invalid.");
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

it("initializes the managed target scope before lifecycle fork arguments expose it", async () => {
	const agentDir = await temp();
	const cwd = path.join(agentDir, "fork-target");
	await fs.mkdir(cwd);
	const request: SessionLifecycleLaunchRequest = {
		operation: "session.fork",
		sessionId: "fork-destination",
		cwd,
		stateRoot: path.join(cwd, ".gjc", "state"),
		...deriveLifecycleDeadlines(Date.now(), 10_000),
		sourceCwd: cwd,
		sourceSessionId: "source-session",
		sourceSessionPath: path.join(cwd, "source.jsonl"),
		sourceSessionIdentity: { dev: "1", ino: "2", size: 3, mtimeMs: 4, mtimeNs: "5", sha256: "a".repeat(64) },
	};
	try {
		const args = await lifecycleArgs(request, cwd, agentDir);
		expect(args.sessionDir).toEqual(expect.any(String));
		expect(syncFs.existsSync(path.join(args.sessionDir!, ".gjc-managed-session-scope.v2.json"))).toBe(true);
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

it("exposes the same prepared managed fork scope on repeated lifecycle argument creation", async () => {
	const agentDir = await temp();
	const cwd = path.join(agentDir, "repeated-fork-target");
	await fs.mkdir(cwd);
	const request: SessionLifecycleLaunchRequest = {
		operation: "session.fork",
		sessionId: "fork-destination",
		cwd,
		stateRoot: path.join(cwd, ".gjc", "state"),
		...deriveLifecycleDeadlines(Date.now(), 10_000),
		sourceCwd: cwd,
		sourceSessionId: "source-session",
		sourceSessionPath: path.join(cwd, "source.jsonl"),
		sourceSessionIdentity: { dev: "1", ino: "2", size: 3, mtimeMs: 4, mtimeNs: "5", sha256: "a".repeat(64) },
	};
	try {
		const first = await lifecycleArgs(request, cwd, agentDir);
		const second = await lifecycleArgs(request, cwd, agentDir);
		expect(first.sessionDir).toBe(second.sessionDir);
		expect(first.sessionDir).toEqual(expect.any(String));
		expect(syncFs.existsSync(path.join(first.sessionDir!, ".gjc-managed-session-scope.v2.json"))).toBe(true);
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

it("SDK lifecycle launch requests require a worktree identity", () => {
	expect(() =>
		readSessionLifecycleLaunchRequest(
			JSON.stringify({ operation: "session.create", sessionId: "session-1", stateRoot: "/state" }),
		),
	).toThrow("GJC_SDK_LIFECYCLE_REQUEST is invalid.");
});

it("SDK lifecycle launch requests retain Coordinator verifier metadata but reject private signing keys", () => {
	const cwd = "/workspace/repo";
	const request = {
		operation: "session.create",
		sessionId: "session-1",
		stateRoot: path.join(cwd, ".gjc", "state"),
		cwd,
		...deriveLifecycleDeadlines(Date.now(), 10_000),
	};
	const publicRequest = {
		...request,
		coordinatorStateDir: "/coordinator/state",
		coordinatorSidecarKeyId: "a".repeat(64),
	};
	expect(readSessionLifecycleLaunchRequest(JSON.stringify(request))).toMatchObject(request);
	expect(readSessionLifecycleLaunchRequest(JSON.stringify(publicRequest))).toMatchObject(publicRequest);
	for (const target of [
		{ coordinatorStateDir: "/coordinator/state" },
		{ coordinatorSidecarSigningKey: "private-key", coordinatorSidecarKeyId: "a".repeat(64) },
	])
		expect(() => readSessionLifecycleLaunchRequest(JSON.stringify({ ...request, ...target }))).toThrow(
			"GJC_SDK_LIFECYCLE_REQUEST is invalid.",
		);
});
it("SDK lifecycle transcript authority requires and preserves a full sha256 identity", () => {
	const cwd = "/workspace/repo";
	const request = {
		operation: "session.resume",
		sessionId: "session-1",
		stateRoot: path.join(cwd, ".gjc", "state"),
		cwd,
		sessionPath: "/agent/sessions/session-1.jsonl",
		sessionIdentity: {
			dev: "1",
			ino: "2",
			size: 3,
			mtimeMs: 4,
			mtimeNs: "5",
			sha256: "a".repeat(64),
		},
		...deriveLifecycleDeadlines(Date.now(), 10_000),
	};
	expect(readSessionLifecycleLaunchRequest(JSON.stringify(request)).sessionIdentity?.sha256).toBe("a".repeat(64));
	const { sha256: _sha256, ...withoutHash } = request.sessionIdentity;
	expect(() =>
		readSessionLifecycleLaunchRequest(JSON.stringify({ ...request, sessionIdentity: withoutHash })),
	).toThrow("GJC_SDK_LIFECYCLE_REQUEST is invalid.");
});

async function waitForDiscovery(agentDir: string, children?: Bun.Subprocess[]) {
	const deadline = Date.now() + BROKER_PROCESS_STARTUP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const discovery = await readBrokerDiscovery(agentDir);
		if (discovery) return discovery;
		if (children?.every(child => child.exitCode !== null)) {
			throw new Error(
				`All broker contenders exited before discovery (codes=${children.map(child => child.exitCode).join(",")}).`,
			);
		}
		await sleep(20);
	}
	throw new Error("Timed out waiting for broker discovery.");
}
describe("broker process completion", () => {
	it("exits zero only after successful broker completion", async () => {
		const exit = vi.fn((code: number): never => {
			throw new Error(`exit:${code}`);
		});
		await expect(completeBrokerProcess({ completion: Promise.resolve() } as Broker, exit)).rejects.toThrow("exit:0");
		expect(exit).toHaveBeenCalledWith(0);
	});

	it("propagates broker completion failure without invoking success exit", async () => {
		const failure = new Error("broker teardown failed");
		const exit = vi.fn((_code: number): never => {
			throw new Error("unexpected exit");
		});
		await expect(completeBrokerProcess({ completion: Promise.reject(failure) } as Broker, exit)).rejects.toBe(
			failure,
		);
		expect(exit).not.toHaveBeenCalled();
	});
});

it("keeps unresolved session cleanup authority through lifecycle ledger compaction", async () => {
	const dir = await temp();
	const ledger = await new LifecycleLedger(dir, { maxRows: 2 }).open();
	const deleteTarget = {
		sessionId: "compacted-session",
		sessionsRoot: "/sessions",
		transcriptPath: "/sessions/compacted-session.jsonl",
		cwd: "/workspace/a",
	};
	const pendingResponse = {
		ok: false,
		error: {
			code: "cleanup_pending",
			message: "retained cleanup",
			cleanup: { phase: "artifacts", ...deleteTarget },
		},
	};
	await ledger.begin("cleanup-a", "hash-a");
	await ledger.transition("cleanup-a", "effect_started", {
		intendedSessionId: "compacted-session",
		response: pendingResponse,
	});
	await ledger.transition("cleanup-a", "terminal_uncertain", {
		response: { ok: false, error: { code: "terminal_uncertain", message: "reproof failed" } },
	});
	const retained = ledger.findCleanupPendingByDeleteTarget(deleteTarget, "cleanup-b");
	expect(retained?.response).toEqual(pendingResponse);
	expect(
		ledger.findCleanupPendingByDeleteTarget({ ...deleteTarget, sessionId: "other-session" }, "cleanup-b"),
	).toBeUndefined();
	expect(
		ledger.findCleanupPendingByDeleteTarget(
			{ ...deleteTarget, transcriptPath: "/sessions/duplicate/compacted-session.jsonl" },
			"cleanup-b",
		),
	).toBeUndefined();
	expect(
		ledger.findCleanupPendingByDeleteTarget({ ...deleteTarget, cwd: "/workspace/b" }, "cleanup-b"),
	).toBeUndefined();
	const persisted = await fs.readFile(path.join(dir, "sdk", "lifecycle-ledger.jsonl"), "utf8");
	expect(persisted.trim().split("\n")).toHaveLength(2);
	expect(persisted).toContain('"unresolvedCleanupResponse"');
	expect(persisted).toContain('"unresolvedCleanupResponseDigest"');
	const compactedRows = persisted
		.trim()
		.split("\n")
		.map(line => JSON.parse(line) as Record<string, unknown>);
	compactedRows[compactedRows.length - 1]!.intendedSessionId = "other-session";
	await fs.writeFile(
		path.join(dir, "sdk", "lifecycle-ledger.jsonl"),
		`${compactedRows.map(row => JSON.stringify(row)).join("\n")}\n`,
	);
	const tamperedLedger = await new LifecycleLedger(dir, { maxRows: 2 }).open();
	expect(await tamperedLedger.begin("cleanup-a", "hash-a")).toMatchObject({ kind: "terminal_uncertain" });
	expect(tamperedLedger.hasUncertainCleanupForSession("compacted-session", "fresh-delete")).toBe(true);
	expect(tamperedLedger.hasUncertainCleanupForSession("other-session", "fresh-delete")).toBe(true);
	expect(tamperedLedger.hasUncertainCleanupForSession("unrelated-session", "fresh-delete")).toBe(true);
	const startupLedger = await new LifecycleLedger(path.join(dir, "startup")).open();
	await startupLedger.begin("startup-a", "startup-hash");
	await startupLedger.transition("startup-a", "effect_started", {
		intendedSessionId: "compacted-session",
		response: {
			ok: false,
			error: {
				code: "cleanup_pending",
				message: "startup cleanup",
				cleanup: { phase: "lifecycle", ...deleteTarget },
			},
		},
	});
	expect(startupLedger.findCleanupPendingByDeleteTarget(deleteTarget, "delete-b")).toBeUndefined();
	await startupLedger.begin("mismatched-cleanup", "mismatched-hash");
	await expect(
		startupLedger.transition("mismatched-cleanup", "effect_started", {
			intendedSessionId: "other-session",
			response: pendingResponse,
		}),
	).rejects.toThrow("Cleanup response session does not match its outer lifecycle fence");
	await fs.rm(dir, { recursive: true, force: true });
});
describe("SDK broker identity and discovery", () => {
	it("atomically publishes one identity key for concurrent callers", async () => {
		const dir = await temp();
		const keys = await Promise.all(Array.from({ length: 16 }, () => getBrokerIdentityKey(dir)));
		expect(new Set(keys)).toEqual(new Set([keys[0]]));
		expect(await fs.readFile(path.join(dir, "sdk", "broker.identity"), "utf8")).toBe(`${keys[0]}\n`);
	});

	it("persists identity and writes a redacted private discovery record", async () => {
		const dir = await temp();
		const a = await getBrokerIdentityKey(dir);
		expect(await getBrokerIdentityKey(dir)).toBe(a);
		const d = {
			version: 1 as const,
			protocolVersion: 3 as const,
			packageGeneration: "test",
			ownerId: "x",
			pid: process.pid,
			host: "127.0.0.1" as const,
			port: 1,
			url: "ws://127.0.0.1:1",
			token: "secret",
			startedAt: 1,
			heartbeatAt: Date.now(),
		};
		await writeBrokerDiscovery(dir, d);
		const persisted = await readBrokerDiscovery(dir);
		expect(persisted).not.toBeNull();
		expect(redactBrokerDiscovery(persisted!).token).toBe("[redacted]");
		if (process.platform !== "win32")
			expect((await fs.stat(path.join(dir, "sdk", "broker.json"))).mode & 0o777).toBe(0o600);
	});

	it("keeps the temp broker.json fsync fail-closed even for EPERM (not shared with the directory barrier)", async () => {
		const dir = await temp();
		const realOpen = fs.open.bind(fs);
		const spy = vi.spyOn(fs, "open").mockImplementation((async (p: string, ...rest: unknown[]) => {
			const handle = await (realOpen as (p: string, ...r: unknown[]) => Promise<fs.FileHandle>)(p, ...rest);
			if (String(p).endsWith(".tmp"))
				(handle as unknown as { sync: () => Promise<void> }).sync = async () => {
					throw Object.assign(new Error("EPERM file fsync"), { code: "EPERM" });
				};
			return handle;
		}) as typeof fs.open);
		try {
			await expect(
				writeBrokerDiscovery(dir, {
					version: 1,
					protocolVersion: 3,
					packageGeneration: "test",
					ownerId: "x",
					pid: process.pid,
					host: "127.0.0.1",
					port: 1,
					url: "ws://127.0.0.1:1",
					token: "secret",
					startedAt: 1,
					heartbeatAt: Date.now(),
				}),
			).rejects.toMatchObject({ code: "EPERM" });
		} finally {
			spy.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("opens, syncs, and closes the discovery temp file with Windows-safe r+ access", async () => {
		const dir = await temp();
		const realOpen = fs.open.bind(fs);
		const tempModes: unknown[] = [];
		let syncs = 0;
		let closes = 0;
		const spy = vi.spyOn(fs, "open").mockImplementation((async (p: string, ...rest: unknown[]) => {
			const handle = await (realOpen as (p: string, ...r: unknown[]) => Promise<fs.FileHandle>)(p, ...rest);
			if (!String(p).endsWith(".tmp")) return handle;
			tempModes.push(rest[0]);
			const sync = handle.sync.bind(handle);
			const close = handle.close.bind(handle);
			(handle as unknown as { sync: () => Promise<void> }).sync = async () => {
				syncs++;
				await sync();
			};
			(handle as unknown as { close: () => Promise<void> }).close = async () => {
				closes++;
				await close();
			};
			return handle;
		}) as typeof fs.open);
		try {
			await writeBrokerDiscovery(dir, {
				version: 1,
				protocolVersion: 3,
				packageGeneration: "test",
				ownerId: "x",
				pid: process.pid,
				host: "127.0.0.1",
				port: 1,
				url: "ws://127.0.0.1:1",
				token: "secret",
				startedAt: 1,
				heartbeatAt: Date.now(),
			});

			expect(tempModes).toEqual(["r+"]);
			expect(syncs).toBe(1);
			expect(closes).toBe(1);
		} finally {
			spy.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("does not blanket-tolerate directory fsync failures (tolerance is win32-scoped only)", async () => {
		if (process.platform === "win32") return;
		const dir = await temp();
		const sdkDir = path.dirname(brokerDiscoveryPath(dir));
		const realOpen = fs.open.bind(fs);
		const spy = vi.spyOn(fs, "open").mockImplementation((async (p: string, ...rest: unknown[]) => {
			const handle = await (realOpen as (p: string, ...r: unknown[]) => Promise<fs.FileHandle>)(p, ...rest);
			if (path.resolve(String(p)) === path.resolve(sdkDir))
				(handle as unknown as { sync: () => Promise<void> }).sync = async () => {
					throw Object.assign(new Error("EIO dir fsync"), { code: "EIO" });
				};
			return handle;
		}) as typeof fs.open);
		try {
			await expect(
				writeBrokerDiscovery(dir, {
					version: 1,
					protocolVersion: 3,
					packageGeneration: "test",
					ownerId: "x",
					pid: process.pid,
					host: "127.0.0.1",
					port: 1,
					url: "ws://127.0.0.1:1",
					token: "secret",
					startedAt: 1,
					heartbeatAt: Date.now(),
				}),
			).rejects.toMatchObject({ code: "EIO" });
		} finally {
			spy.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects discovery bound to a different process incarnation", async () => {
		const dir = await temp();
		await writeBrokerDiscovery(dir, {
			version: 1,
			protocolVersion: 3,
			packageGeneration: "test",
			ownerId: "stale",
			pid: process.pid,
			incarnation: "different-incarnation",
			host: "127.0.0.1",
			port: 1,
			url: "ws://127.0.0.1:1",
			token: "secret",
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
		});

		expect(await readBrokerDiscovery(dir)).toBeNull();
		await fs.rm(dir, { recursive: true, force: true });
	});
	it("treats a truncated discovery record as unavailable", async () => {
		const dir = await temp();
		await fs.mkdir(path.dirname(brokerDiscoveryPath(dir)), { recursive: true });
		await fs.writeFile(brokerDiscoveryPath(dir), '{"version":1,"pid":');
		expect(await readBrokerDiscovery(dir)).toBeNull();
		await fs.rm(dir, { recursive: true, force: true });
	});
	it("rolls back its publication when retained authority acquisition fails", async () => {
		if (process.platform === "win32") return;
		const dir = await temp();
		const retain = vi.spyOn(native, "retainBrokerPublication").mockImplementation(() => {
			throw new Error("retain failed");
		});
		try {
			await expect(
				publishBrokerDiscovery(dir, {
					version: 1,
					protocolVersion: 3,
					packageGeneration: "test",
					ownerId: "failed-owner",
					pid: process.pid,
					host: "127.0.0.1",
					port: 1,
					url: "ws://127.0.0.1:1",
					token: "failed-token",
					startedAt: Date.now(),
					heartbeatAt: Date.now(),
				}),
			).rejects.toThrow("retain failed");
			expect(await fs.stat(brokerDiscoveryPath(dir)).catch(() => null)).toBeNull();
		} finally {
			retain.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("names the redirected publication object when authority is withheld", async () => {
		// A shared multi-account layout that symlinks the agent directory's `sdk`
		// entry is refused by the no-follow open, and the native layer reports only
		// one opaque failure. The broker must still fail closed, but the operator
		// needs the responsible object named.
		// win32 takes the legacy publication path and never reaches native retention;
		// creating the symlink there also needs a privilege the runner may not hold.
		if (process.platform === "win32") return;
		const host = await temp();
		const dir = await temp();
		try {
			await fs.mkdir(path.join(host, "sdk"), { recursive: true, mode: 0o700 });
			await fs.symlink(path.join(host, "sdk"), path.join(dir, "sdk"));
			const refusal = await publishBrokerDiscovery(dir, {
				version: 1,
				protocolVersion: 3,
				packageGeneration: "test",
				ownerId: "redirected-owner",
				pid: process.pid,
				host: "127.0.0.1",
				port: 1,
				url: "ws://127.0.0.1:1",
				token: "redirected-token",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
			}).then(
				() => undefined,
				(error: unknown) => error as Error,
			);
			expect(refusal?.message).toContain("Retained broker publication authority is unavailable.");
			// The native refusal stays authoritative and is retained verbatim as cause.
			expect((refusal?.cause as Error | undefined)?.message).toContain(
				"Retained broker publication authority is unavailable.",
			);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
			await fs.rm(host, { recursive: true, force: true });
		}
	});
	it("names a missing publication object when authority is withheld", async () => {
		// Exercises the real native refusal (no mock) for an object other than the
		// redirected-directory case, so the naming path is pinned end to end.
		if (process.platform === "win32") return;
		const dir = await temp();
		try {
			await fs.mkdir(path.join(dir, "sdk", "broker.lock"), { recursive: true, mode: 0o700 });
			await expect(
				publishBrokerDiscovery(dir, {
					version: 1,
					protocolVersion: 3,
					packageGeneration: "test",
					ownerId: "recordless-owner",
					pid: process.pid,
					host: "127.0.0.1",
					port: 1,
					url: "ws://127.0.0.1:1",
					token: "recordless-token",
					startedAt: Date.now(),
					heartbeatAt: Date.now(),
				}),
			).rejects.toThrow(/owner\.json is missing/);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("names an unreadable publication object when authority is withheld", async () => {
		// Root bypasses the permission bits this fixture depends on, and so does any
		// runner holding DAC_OVERRIDE or a permissive ACL, so the fixture proves it
		// is actually denied before asserting on the denial.
		if (process.platform === "win32" || process.getuid?.() === 0) return;
		const dir = await temp();
		const owner = path.join(dir, "sdk", "broker.lock", "owner.json");
		const discovery = {
			version: 1 as const,
			protocolVersion: 3 as const,
			packageGeneration: "unreadable-owner",
			ownerId: "unreadable-owner",
			pid: process.pid,
			host: "127.0.0.1" as const,
			port: 1,
			url: "ws://127.0.0.1:1",
			token: "unreadable-token",
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
			incarnation: "unreadable-incarnation",
		};
		try {
			await fs.mkdir(path.dirname(owner), { recursive: true, mode: 0o700 });
			await fs.writeFile(owner, "owner", { mode: 0o600 });
			await writeBrokerDiscovery(dir, discovery);
			await fs.chmod(owner, 0o000);
			const denial = await fs.open(owner, "r").then(
				async handle => {
					await handle.close();
					return undefined;
				},
				(error: NodeJS.ErrnoException) => error.code,
			);
			if (!denial) return;
			await expect(publishBrokerDiscovery(dir, discovery)).rejects.toThrow(
				new RegExp(`owner\\.json could not be opened \\(${denial}\\)`),
			);
		} finally {
			await fs.chmod(owner, 0o600).catch(() => {});
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("leaves a withheld-authority failure unexplained when every precondition holds", async () => {
		// Naming a condition must never invent one: with all four publication
		// objects intact the native message is surfaced verbatim.
		if (process.platform === "win32") return;
		const dir = await temp();
		const lock = path.join(dir, "sdk", "broker.lock");
		await fs.mkdir(lock, { recursive: true, mode: 0o700 });
		await fs.writeFile(path.join(lock, "owner.json"), JSON.stringify({ version: 1, pid: process.pid }), {
			mode: 0o600,
		});
		const retain = vi.spyOn(native, "retainBrokerPublication").mockImplementation(() => {
			throw new Error("retain failed");
		});
		try {
			await expect(
				publishBrokerDiscovery(dir, {
					version: 1,
					protocolVersion: 3,
					packageGeneration: "test",
					ownerId: "intact-owner",
					pid: process.pid,
					host: "127.0.0.1",
					port: 1,
					url: "ws://127.0.0.1:1",
					token: "intact-token",
					startedAt: Date.now(),
					heartbeatAt: Date.now(),
				}),
			).rejects.toThrow(/^retain failed$/);
		} finally {
			retain.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("names a published record whose heartbeat field cannot be edited in place", async () => {
		// The native layer's last precondition is a fixed-width heartbeat it can
		// overwrite in place. A record replaced between publication and retention
		// (the race the precondition exists for) must be named, the foreign record
		// must survive the exact rollback, and the native error must stay the cause.
		if (process.platform === "win32") return;
		const dir = await temp();
		const lock = path.join(dir, "sdk", "broker.lock");
		const foreign = '{"heartbeatAt":12}\n';
		await fs.mkdir(lock, { recursive: true, mode: 0o700 });
		await fs.writeFile(path.join(lock, "owner.json"), JSON.stringify({ version: 1, pid: process.pid }), {
			mode: 0o600,
		});
		const nativeRefusal = new Error("Retained broker publication authority is unavailable.");
		const retain = vi.spyOn(native, "retainBrokerPublication").mockImplementation(() => {
			syncFs.writeFileSync(brokerDiscoveryPath(dir), foreign);
			throw nativeRefusal;
		});
		try {
			const refusal = await publishBrokerDiscovery(dir, {
				version: 1,
				protocolVersion: 3,
				packageGeneration: "test",
				ownerId: "malformed-heartbeat-owner",
				pid: process.pid,
				host: "127.0.0.1",
				port: 1,
				url: "ws://127.0.0.1:1",
				token: "malformed-heartbeat-token",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
			}).then(
				() => undefined,
				(error: unknown) => error as Error,
			);
			expect(refusal?.message).toMatch(/broker\.json heartbeatAt is not a fixed-width 13-digit timestamp/);
			expect(refusal?.cause).toBe(nativeRefusal);
			// Rollback is exact: a record this publication does not own is left alone.
			expect(await fs.readFile(brokerDiscoveryPath(dir), "utf8")).toBe(foreign);

			retain.mockImplementation(() => {
				syncFs.writeFileSync(brokerDiscoveryPath(dir), '{"ownerId":"foreign"}\n');
				throw nativeRefusal;
			});
			await expect(
				publishBrokerDiscovery(dir, {
					version: 1,
					protocolVersion: 3,
					packageGeneration: "test",
					ownerId: "fieldless-owner",
					pid: process.pid,
					host: "127.0.0.1",
					port: 1,
					url: "ws://127.0.0.1:1",
					token: "fieldless-token",
					startedAt: Date.now(),
					heartbeatAt: Date.now(),
				}),
			).rejects.toThrow(/broker\.json has no heartbeatAt field/);

			const emptyHeartbeatRecord = JSON.stringify({ ownerId: "foreign", padding: "" });
			const exactFillRecord = JSON.stringify({
				ownerId: "foreign",
				padding: "x".repeat(4096 - Buffer.byteLength(emptyHeartbeatRecord)),
			});
			expect(Buffer.byteLength(exactFillRecord)).toBe(4096);
			retain.mockImplementation(() => {
				syncFs.writeFileSync(brokerDiscoveryPath(dir), exactFillRecord);
				throw nativeRefusal;
			});
			await expect(
				publishBrokerDiscovery(dir, {
					version: 1,
					protocolVersion: 3,
					packageGeneration: "exact-fill-owner",
					ownerId: "exact-fill-owner",
					pid: process.pid,
					host: "127.0.0.1",
					port: 1,
					url: "ws://127.0.0.1:1",
					token: "exact-fill-token",
					startedAt: Date.now(),
					heartbeatAt: Date.now(),
				}),
			).rejects.toThrow(/broker\.json has no heartbeatAt field/);
		} finally {
			retain.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("does not blame a lock record the native layer only opens read-only", async () => {
		// `RetainedPublication::open` opens `owner.json` read-only and only
		// `broker.json` read/write. A readable-but-unwritable lock record is
		// therefore not an obstruction, and must not mask the real later one.
		if (process.platform === "win32") return;
		const dir = await temp();
		const lock = path.join(dir, "sdk", "broker.lock");
		const owner = path.join(lock, "owner.json");
		await fs.mkdir(lock, { recursive: true, mode: 0o700 });
		await fs.writeFile(owner, JSON.stringify({ version: 1, pid: process.pid }), { mode: 0o600 });
		await fs.chmod(owner, 0o400);
		const retain = vi.spyOn(native, "retainBrokerPublication").mockImplementation(() => {
			syncFs.writeFileSync(brokerDiscoveryPath(dir), '{"heartbeatAt":12}\n');
			throw new Error("Retained broker publication authority is unavailable.");
		});
		try {
			const refusal = await publishBrokerDiscovery(dir, {
				version: 1,
				protocolVersion: 3,
				packageGeneration: "test",
				ownerId: "read-only-owner-record",
				pid: process.pid,
				host: "127.0.0.1",
				port: 1,
				url: "ws://127.0.0.1:1",
				token: "read-only-owner-token",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
			}).then(
				() => undefined,
				(error: unknown) => error as Error,
			);
			expect(refusal?.message).toMatch(/broker\.json heartbeatAt is not a fixed-width 13-digit timestamp/);
			expect(refusal?.message).not.toMatch(/owner\.json/);
		} finally {
			retain.mockRestore();
			await fs.chmod(owner, 0o600).catch(() => {});
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("rejects a non-regular owner record before granting publication authority", async () => {
		// Retained publication acquisition validates the owner descriptor kind before
		// returning authority, preventing a special-file admission window.
		if (process.platform === "win32") return;
		const dir = await temp();
		await fs.mkdir(path.join(dir, "sdk", "broker.lock", "owner.json"), { recursive: true, mode: 0o700 });
		const discovery = {
			version: 1 as const,
			protocolVersion: 3 as const,
			packageGeneration: "test",
			ownerId: "directory-owner-record",
			pid: process.pid,
			host: "127.0.0.1" as const,
			port: 1,
			url: "ws://127.0.0.1:1",
			token: "directory-owner-token",
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
		};
		try {
			const refusal = await publishBrokerDiscovery(dir, discovery).then(
				() => undefined,
				(error: unknown) => error as Error,
			);
			expect(refusal?.message).toContain("Retained broker publication authority is unavailable.");
			expect((refusal?.cause as Error | undefined)?.message).toContain("owner.json");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("names a native-rejected wrong-kind publication object", async () => {
		if (process.platform === "win32") return;
		const dir = await temp();
		const nativeRefusal = new Error("Retained broker publication authority is unavailable.");
		try {
			await fs.mkdir(path.join(dir, "sdk"), { recursive: true, mode: 0o700 });
			await fs.writeFile(path.join(dir, "sdk", "broker.lock"), "not a directory", { mode: 0o600 });
			const refusal = await publishBrokerDiscovery(dir, {
				version: 1,
				protocolVersion: 3,
				packageGeneration: "wrong-kind-owner",
				ownerId: "wrong-kind-owner",
				pid: process.pid,
				host: "127.0.0.1",
				port: 1,
				url: "ws://127.0.0.1:1",
				token: "wrong-kind-token",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
			}).then(
				() => undefined,
				(error: unknown) => error as Error,
			);
			expect(refusal?.message).toContain("Retained broker publication authority is unavailable.");
			expect((refusal?.cause as Error | undefined)?.message).toContain(nativeRefusal.message);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("names the acquisition stage the native layer refused, not always the open", async () => {
		// The native reason carries the stage that refused. Rendering every reason as
		// a failed open would state something the native layer never reported -- a
		// read of an already-open descriptor, or an fstat, is not an open failure --
		// and the whole point of this diagnostic is that its claim is exact.
		if (process.platform === "win32") return;
		const cases: [string, RegExp][] = [
			["errno-EPERM", /sdk\/broker\.json could not be opened \(EPERM\)/],
			["read-operation would block", /sdk\/broker\.json could not be read \(operation would block\)/],
			["clone-too many open files", /sdk\/broker\.json could not be inspected \(too many open files\)/],
			["metadata", /sdk\/broker\.json could not be inspected(?!\s*\()/],
			["metadata-permission denied", /sdk\/broker\.json could not be inspected \(permission denied\)/],
			["io-other error", /sdk\/broker\.json could not be opened \(other error\)/],
			["future-reason", /sdk\/broker\.json withheld publication authority \(future-reason\)/],
		];
		// `unsupported-platform` is the Windows acquisition refusal: the object in
		// the native message is the directory authority targets, and the rendering
		// must name the unimplemented platform, never a stage that did not run.
		const platformCases: [string, string, RegExp][] = [
			["sdk", "unsupported-platform", /retained publication authority is not implemented on this platform/],
		];
		for (const [object, reason, expected] of platformCases) {
			const dir = await temp();
			const nativeFailure = new Error(
				`Retained broker publication authority is unavailable. [retained-publication object=${object}; reason=${reason}]`,
			);
			const retain = vi.spyOn(native, "retainBrokerPublication").mockImplementation(() => {
				throw nativeFailure;
			});
			try {
				const refusal = await publishBrokerDiscovery(dir, {
					version: 1,
					protocolVersion: 3,
					packageGeneration: "unsupported-platform",
					ownerId: "unsupported-platform",
					pid: process.pid,
					host: "127.0.0.1",
					port: 1,
					url: "ws://127.0.0.1:1",
					token: "unsupported-platform-token",
					startedAt: Date.now(),
					heartbeatAt: Date.now(),
				}).then(
					() => undefined,
					(error: unknown) => error as Error,
				);
				expect(refusal?.message).toMatch(expected);
				expect(refusal?.message).not.toContain("could not be opened");
				expect(refusal?.message).not.toContain("current observed state");
				expect(refusal?.cause).toBe(nativeFailure);
			} finally {
				retain.mockRestore();
				await fs.rm(dir, { recursive: true, force: true });
			}
		}
		for (const [reason, expected] of cases) {
			const dir = await temp();
			const nativeFailure = new Error(
				`Retained broker publication authority is unavailable. [retained-publication object=sdk/broker.json; reason=${reason}]`,
			);
			const retain = vi.spyOn(native, "retainBrokerPublication").mockImplementation(() => {
				throw nativeFailure;
			});
			try {
				const refusal = await publishBrokerDiscovery(dir, {
					version: 1,
					protocolVersion: 3,
					packageGeneration: "stage-named",
					ownerId: "stage-named",
					pid: process.pid,
					host: "127.0.0.1",
					port: 1,
					url: "ws://127.0.0.1:1",
					token: "stage-named-token",
					startedAt: Date.now(),
					heartbeatAt: Date.now(),
				}).then(
					() => undefined,
					(error: unknown) => error as Error,
				);
				expect(refusal?.message).toMatch(expected);
				expect(refusal?.message).not.toContain("current observed state");
				expect(refusal?.cause).toBe(nativeFailure);
			} finally {
				retain.mockRestore();
				await fs.rm(dir, { recursive: true, force: true });
			}
		}
	});
	it("escapes control and bidi characters in the diagnostic agent directory", async () => {
		if (process.platform === "win32") return;
		const root = await temp();
		const host = await temp();
		const dir = path.join(root, "agent\n\u001b[31m\u202e");
		try {
			await fs.mkdir(dir, { recursive: true });
			await fs.mkdir(path.join(host, "sdk"), { recursive: true, mode: 0o700 });
			await fs.symlink(path.join(host, "sdk"), path.join(dir, "sdk"));
			const refusal = await publishBrokerDiscovery(dir, {
				version: 1,
				protocolVersion: 3,
				packageGeneration: "sanitized-agent-dir",
				ownerId: "sanitized-agent-dir",
				pid: process.pid,
				host: "127.0.0.1",
				port: 1,
				url: "ws://127.0.0.1:1",
				token: "sanitized-agent-dir-token",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
			}).then(
				() => undefined,
				(error: unknown) => error as Error,
			);
			expect(refusal?.message).toMatch(/agent directory .*\\u000a.*\\u001b.*\\u202e/);
			expect(refusal?.message).not.toContain("\n");
			expect(refusal?.message).not.toContain("\u001b");
			expect(refusal?.message).not.toContain("\u202e");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
			await fs.rm(host, { recursive: true, force: true });
		}
	});
	it("keeps the named object inside the persisted startup-failure reason bound", async () => {
		// Broker startup persists a 512-character reason. An unbounded agent
		// directory ahead of the obstruction would truncate away the very object
		// this diagnostic exists to report.
		if (process.platform === "win32") return;
		const host = await temp();
		const root = await temp();
		let dir = root;
		for (let depth = 0; depth < 4; depth += 1) dir = path.join(dir, `d${"e".repeat(198)}p`);
		try {
			expect(dir.length).toBeGreaterThan(512);
			await fs.mkdir(dir, { recursive: true });
			await fs.mkdir(path.join(host, "sdk"), { recursive: true, mode: 0o700 });
			await fs.symlink(path.join(host, "sdk"), path.join(dir, "sdk"));
			const refusal = await publishBrokerDiscovery(dir, {
				version: 1,
				protocolVersion: 3,
				packageGeneration: "test",
				ownerId: "long-path-owner",
				pid: process.pid,
				host: "127.0.0.1",
				port: 1,
				url: "ws://127.0.0.1:1",
				token: "long-path-token",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
			}).then(
				() => undefined,
				(error: unknown) => error as Error,
			);
			expect(refusal?.message.slice(0, 512)).toContain("Retained broker publication authority is unavailable.");
			// The bound only matters because this message is what the durable startup
			// marker persists, so assert through the marker rather than the throw.
			await writeBrokerStartupFailureMarker(root, {
				reason: refusal?.message ?? "",
				exitCode: 1,
				signal: null,
				pid: process.pid,
			});
			expect((await readBrokerStartupFailureMarker(root))?.reason).toContain(
				"Retained broker publication authority is unavailable.",
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
			await fs.rm(host, { recursive: true, force: true });
		}
	});
	it("keeps the named object in the persisted reason when rollback also fails", async () => {
		// A failed rollback replaces the thrown error with an AggregateError, and
		// the startup marker persists only `message` -- `AggregateError.errors` is
		// not serialized -- so the named object has to survive into that message.
		if (process.platform === "win32") return;
		const host = await temp();
		const dir = await temp();
		const readFile = fs.readFile;
		const rollbackFailure = Object.assign(new Error("EIO rollback read"), { code: "EIO" });
		const spy = vi.spyOn(fs, "readFile").mockImplementation((async (file: string, ...rest: unknown[]) => {
			if (String(file).endsWith("broker.json")) throw rollbackFailure;
			return (readFile as (f: string, ...r: unknown[]) => Promise<unknown>)(file, ...rest);
		}) as typeof fs.readFile);
		try {
			await fs.mkdir(path.join(host, "sdk"), { recursive: true, mode: 0o700 });
			await fs.symlink(path.join(host, "sdk"), path.join(dir, "sdk"));
			const refusal = await publishBrokerDiscovery(dir, {
				version: 1,
				protocolVersion: 3,
				packageGeneration: "test",
				ownerId: "rollback-failure-owner",
				pid: process.pid,
				host: "127.0.0.1",
				port: 1,
				url: "ws://127.0.0.1:1",
				token: "rollback-failure-token",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
			}).then(
				() => undefined,
				(error: unknown) => error as AggregateError,
			);
			expect(refusal).toBeInstanceOf(AggregateError);
			expect(refusal?.errors?.[1]).toBe(rollbackFailure);
			spy.mockRestore();
			await writeBrokerStartupFailureMarker(dir, {
				reason: refusal?.message ?? "",
				exitCode: 1,
				signal: null,
				pid: process.pid,
			});
			expect((await readBrokerStartupFailureMarker(dir))?.reason).toContain(
				"Retained broker publication authority is unavailable.",
			);
		} finally {
			spy.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
			await fs.rm(host, { recursive: true, force: true });
		}
	});
	it("names the heartbeat, not the file kind, for a published record the native only refuses on read", async () => {
		// `RetainedPublication::open` puts no kind constraint on a successfully
		// opened published record: it reads the descriptor and refuses for the
		// missing heartbeat. A directory is refused earlier, by the read/write open
		// itself (EISDIR), and only that stage may be named as a kind.
		if (process.platform === "win32") return;
		const dir = await temp();
		const lock = path.join(dir, "sdk", "broker.lock");
		await fs.mkdir(lock, { recursive: true, mode: 0o700 });
		await fs.writeFile(path.join(lock, "owner.json"), JSON.stringify({ version: 1, pid: process.pid }), {
			mode: 0o600,
		});
		const record = {
			version: 1 as const,
			protocolVersion: 3 as const,
			packageGeneration: "test",
			ownerId: "published-kind-owner",
			pid: process.pid,
			host: "127.0.0.1" as const,
			port: 1,
			url: "ws://127.0.0.1:1",
			token: "published-kind-token",
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
		};
		const retain = vi.spyOn(native, "retainBrokerPublication").mockImplementation(() => {
			syncFs.rmSync(brokerDiscoveryPath(dir), { force: true });
			syncFs.mkdirSync(brokerDiscoveryPath(dir));
			throw new Error("Retained broker publication authority is unavailable.");
		});
		try {
			// A directory is the one kind the native's own read/write open rejects.
			await expect(publishBrokerDiscovery(dir, record)).rejects.toThrow(/broker\.json is not a regular file/);
		} finally {
			retain.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("fences failed heartbeats until a later retained heartbeat succeeds", async () => {
		const dir = await temp();
		let watchdog: (() => void) | undefined;
		let heartbeatAttempts = 0;
		const realSetInterval = globalThis.setInterval;
		const interval = vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
			watchdog = callback;
			return realSetInterval(() => {}, 2 ** 31 - 1);
		}) as typeof setInterval);
		const retain = vi.spyOn(native, "retainBrokerPublication").mockReturnValue({
			observe: () => ({ kind: "owned" }),
			observeAsync: () => Promise.resolve({ kind: "owned" }),
			heartbeatAsync: () => Promise.resolve({ kind: ++heartbeatAttempts === 1 ? "failed" : "written" }),
			syncAsync: () => Promise.resolve({ kind: "synced" }),
			close: () => ({ kind: "closed" }),
		} as never);
		const broker = new Broker({ agentDir: dir });
		try {
			await broker.start();
			await broker.heartbeat();
			expect(await broker.handleRequest("session.list", {})).toEqual({
				ok: false,
				error: { code: "unavailable", message: "broker publication is unavailable" },
			});
			watchdog!();
			await sleep(0);
			expect(await broker.handleRequest("session.list", {})).toMatchObject({ ok: true });
		} finally {
			interval.mockRestore();
			retain.mockRestore();
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("fences ambiguous publication observations without self-exit and recovers only after an owned heartbeat succeeds", async () => {
		const dir = await temp();
		let watchdog: (() => void) | undefined;
		let observation: "owned" | "ambiguous" = "owned";
		let heartbeatAttempts = 0;
		const realSetInterval = globalThis.setInterval;
		const interval = vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
			watchdog = callback;
			return realSetInterval(() => {}, 2 ** 31 - 1);
		}) as typeof setInterval);
		const retain = vi.spyOn(native, "retainBrokerPublication").mockReturnValue({
			observe: () => ({ kind: observation }),
			observeAsync: () => Promise.resolve({ kind: observation }),
			heartbeatAsync: () => Promise.resolve({ kind: ++heartbeatAttempts === 1 ? "failed" : "written" }),
			syncAsync: () => Promise.resolve({ kind: "synced" }),
			close: () => ({ kind: "closed" }),
		} as never);
		const broker = new Broker({ agentDir: dir });
		try {
			await broker.start();
			expect(watchdog).toBeDefined();

			observation = "ambiguous";
			watchdog!();
			await sleep(0);
			expect(await broker.handleRequest("session.list", {})).toEqual({
				ok: false,
				error: { code: "unavailable", message: "broker publication is unavailable" },
			});
			expect(await Promise.race([broker.completion.then(() => true), sleep(25).then(() => false)])).toBe(false);

			observation = "owned";
			watchdog!();
			await sleep(0);
			expect(heartbeatAttempts).toBe(1);
			expect(await broker.handleRequest("session.list", {})).toEqual({
				ok: false,
				error: { code: "unavailable", message: "broker publication is unavailable" },
			});
			expect(await Promise.race([broker.completion.then(() => true), sleep(25).then(() => false)])).toBe(false);

			watchdog!();
			await sleep(0);
			expect(heartbeatAttempts).toBe(2);
			expect(await broker.handleRequest("session.list", {})).toMatchObject({ ok: true });
		} finally {
			interval.mockRestore();
			retain.mockRestore();
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("refreshes discovery heartbeat, removes it on stop, and can restart", async () => {
		const dir = await temp();
		const broker = new Broker({ agentDir: dir, heartbeatTtlMs: 45 });
		const first = await broker.start();
		const deadline = Date.now() + 6_500;
		let refreshed = await readBrokerDiscovery(dir);
		while ((!refreshed || refreshed.heartbeatAt <= first.heartbeatAt) && Date.now() < deadline) {
			await sleep(10);
			refreshed = await readBrokerDiscovery(dir);
		}
		expect(refreshed?.heartbeatAt).toBeGreaterThan(first.heartbeatAt);
		await broker.stop();
		await expect(fs.stat(brokerDiscoveryPath(dir))).rejects.toThrow();
		const restarted = await ensureBroker({ agentDir: dir });
		expect(restarted.token).not.toBe(first.token);
		const owner = (await import("../src/sdk/broker/ensure")).brokerOwnerForTest(dir);
		await owner?.stop();
	}, 15_000);
	it("refuses concurrent launches when a live lock owner has not published discovery", async () => {
		const dir = await temp();
		const lock = path.join(dir, "sdk", "broker.lock");
		await fs.mkdir(lock, { recursive: true, mode: 0o700 });
		await fs.writeFile(
			path.join(lock, "owner.json"),
			JSON.stringify({ version: 1, ownerId: "live-unpublished-owner", pid: process.pid, acquiredAt: Date.now() }),
			{ mode: 0o600 },
		);
		const contenders = Array.from({ length: 3 }, () => new Broker({ agentDir: dir }));
		try {
			const outcomes = await Promise.allSettled(contenders.map(broker => broker.start()));

			expect(outcomes.map(outcome => outcome.status)).toEqual(["rejected", "rejected", "rejected"]);
			for (const outcome of outcomes) {
				if (outcome.status === "rejected")
					expect(String(outcome.reason)).toContain(`Broker lock is held by a live owner (pid ${process.pid})`);
			}
			expect(await readBrokerDiscovery(dir)).toBeNull();
			expect(contenders.map(broker => broker.status())).toEqual([null, null, null]);
			expect(JSON.parse(await fs.readFile(path.join(lock, "owner.json"), "utf8"))).toMatchObject({
				ownerId: "live-unpublished-owner",
				pid: process.pid,
			});
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}, 5_000);
	it("preserves legacy Windows publication and heartbeat when retained self-reap is unsupported", async () => {
		const dir = await temp();
		const now = Date.now();
		const publication = await publishBrokerDiscovery(
			dir,
			{
				version: 1,
				protocolVersion: 3,
				packageGeneration: "windows-compat",
				ownerId: "windows-owner",
				pid: process.pid,
				host: "127.0.0.1",
				port: 1,
				url: "ws://127.0.0.1:1",
				token: "windows-token",
				startedAt: now,
				heartbeatAt: now,
			},
			"win32",
		);
		try {
			expect(publication.observe()).toBe("owned");
			expect(await publication.heartbeat(now + 1)).toBe(true);
			expect((await readBrokerDiscovery(dir))?.heartbeatAt).toBe(now + 1);
		} finally {
			publication.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("reinitializes completion and teardown state when the same broker instance restarts", async () => {
		const dir = await temp();
		const broker = new Broker({ agentDir: dir, heartbeatTtlMs: 90 });
		const first = await broker.start();
		await broker.stop();
		const second = await broker.start();
		try {
			expect(second.token).not.toBe(first.token);
			expect(await broker.handleRequest("session.list", {})).toMatchObject({ ok: true });
		} finally {
			await broker.stop();
		}
		await expect(fs.stat(brokerDiscoveryPath(dir))).rejects.toMatchObject({ code: "ENOENT" });
		await fs.rm(dir, { recursive: true, force: true });
	});
	it("fences admission on definitive root loss and reopens only when the retained objects return", async () => {
		const dir = await temp();
		let watchdog: (() => void) | undefined;
		const realSetInterval = globalThis.setInterval;
		const interval = vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
			watchdog = callback;
			return realSetInterval(() => {}, 2 ** 31 - 1);
		}) as typeof setInterval);
		const broker = new Broker({ agentDir: dir });
		try {
			await broker.start();
			expect(watchdog).toBeDefined();
			expect(await broker.handleRequest("session.list", {})).toMatchObject({ ok: true });

			const retainedRoot = path.join(dir, "retained-sdk");
			await fs.rename(path.join(dir, "sdk"), retainedRoot);
			// The filesystem rename is real; force the native-equivalent observation so
			// this test does not race the blocking-pool descriptor check on a loaded CI
			// runner. The fail-closed admission transition remains the behavior under test.
			setPublicationObservationForTest(broker, "absent");
			watchdog!();
			await Bun.sleep(0);
			expect(await broker.handleRequest("session.list", {})).toEqual({
				ok: false,
				error: { code: "unavailable", message: "broker publication is unavailable" },
			});

			await fs.rename(retainedRoot, path.join(dir, "sdk"));
			setPublicationObservationForTest(broker, "owned");
			watchdog!();
			await Bun.sleep(0);
			expect(await broker.handleRequest("session.list", {})).toMatchObject({ ok: true });
		} finally {
			setPublicationObservationForTest(broker, undefined);
			interval.mockRestore();
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("recovers request admission after the watchdog observation, not after the heartbeat write", async () => {
		// Regression: #watchPublication must restore the cached publicationState
		// after its off-thread observation and before the awaited heartbeat IO.
		const dir = await temp();
		let watchdog: (() => void) | undefined;
		const realSetInterval = globalThis.setInterval;
		const interval = vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
			watchdog = callback;
			return realSetInterval(() => {}, 2 ** 31 - 1);
		}) as typeof setInterval);
		const broker = new Broker({ agentDir: dir });
		try {
			await broker.start();

			const retainedRoot = path.join(dir, "retained-sdk");
			await fs.rename(path.join(dir, "sdk"), retainedRoot);
			watchdog!();
			await new Promise(r => setTimeout(r, 10));
			expect(await broker.handleRequest("session.list", {})).toMatchObject({ ok: false });

			await fs.rename(retainedRoot, path.join(dir, "sdk"));
			watchdog!();
			await new Promise(resolve => setTimeout(resolve, 0));
			expect(await broker.handleRequest("session.list", {})).toMatchObject({ ok: true });
		} finally {
			interval.mockRestore();
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("terminates and reaps the spawned broker when discovery times out", async () => {
		const dir = await temp();
		// Force ensureBroker's discovery reads to never resolve a live record so the
		// discovery wait is doomed from the start. The real broker still spawns and
		// stays alive as a detached daemon, which is exactly the orphan path the reap
		// must close. Capture its pid from the discovery file (bypassing the spy)
		// before ensureBroker times out and reaps it.
		const spy = vi.spyOn(brokerDiscovery, "readBrokerDiscovery").mockResolvedValue(null);
		try {
			const { promise: gotPid, resolve: onPid } = Promise.withResolvers<number | undefined>();
			void (async () => {
				const deadline = Date.now() + 12_000;
				while (Date.now() < deadline) {
					try {
						const raw = JSON.parse(await fs.readFile(brokerDiscovery.brokerDiscoveryPath(dir), "utf8")) as {
							pid?: number;
						};
						if (typeof raw.pid === "number") return onPid(raw.pid);
					} catch {}
					await sleep(25);
				}
				onPid(undefined);
			})();
			await expect(ensureBroker({ agentDir: dir })).rejects.toThrow(
				"Timed out waiting for detached SDK broker discovery.",
			);
			const brokerPid = await gotPid;
			// The spawned detached broker must have been terminated + reaped, not orphaned.
			expect(typeof brokerPid).toBe("number");
			expect(brokerDiscovery.isPidAlive(brokerPid!)).toBe(false);
			// No owner handle leaked for the failed agent dir.
			expect(brokerOwnerForTest(dir)).toBeUndefined();
		} finally {
			spy.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
	it("fails fast and reaps the spawned broker when it exits before discovery", async () => {
		const dir = await temp();
		// Plant an unsupported session-index snapshot so the spawned broker's start()
		// rejects immediately and it exits before publishing discovery. ensureBroker
		// must take the early-exit path (not the 10s timeout) and leave no orphan.
		await fs.mkdir(path.join(dir, "sdk", "sessions"), { recursive: true });
		await fs.writeFile(path.join(dir, "sdk", "sessions", "index.snapshot.json"), JSON.stringify({ version: 99 }));
		await expect(ensureBroker({ agentDir: dir })).rejects.toThrow(/exited before discovery/);
		// No owner handle leaked for the failed agent dir.
		expect(brokerOwnerForTest(dir)).toBeUndefined();
		// No discovery record was published: the broker exited before writing one.
		await expect(fs.stat(brokerDiscoveryPath(dir))).rejects.toThrow();
		await fs.rm(dir, { recursive: true, force: true });
	}, 15_000);
	it("escalates to SIGKILL and awaits verified exit when a live child emits error after SIGTERM", async () => {
		// Reproduces the PR #2157 review blocker: a still-live broker child emits
		// `error` during SIGTERM (e.g. a transient signal-delivery failure). The
		// reaper must treat that as diagnostic only, escalate to SIGKILL, and await
		// an actual exit/close — never resolve on `error` alone and orphan the child.
		// This condition is not deterministically reproducible with a real OS process,
		// so a controllable child surface drives the exact reap control flow. Before
		// the fix the `error` event resolved the wait as if the child had exited, so
		// SIGKILL was never reached and the process stayed alive.
		const signals: NodeJS.Signals[] = [];
		const child = Object.assign(new EventEmitter(), {
			pid: 4242,
			exitCode: null as number | null,
			signalCode: null as NodeJS.Signals | null,
			kill(sig: NodeJS.Signals): boolean {
				signals.push(sig);
				if (sig === "SIGTERM") {
					// Still-live child surfaces an error mid-teardown without exiting.
					queueMicrotask(() => child.emit("error", new Error("signal delivery failed during teardown")));
					return true;
				}
				if (sig === "SIGKILL") {
					queueMicrotask(() => {
						child.signalCode = "SIGKILL";
						child.emit("exit", null, "SIGKILL");
					});
					return true;
				}
				return false;
			},
		});
		// Production always retains ensureBroker's spawn-error listener on the child;
		// keep one here so emitting `error` matches that surface (and is not fatal).
		child.on("error", () => {});
		await expect(reapSpawnedBrokerForTest(child as unknown as ChildProcess)).resolves.toBeUndefined();
		// SIGTERM's emitted `error` must NOT count as exit: escalation reached SIGKILL.
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		// Termination was proven by an observed exit, not by the earlier `error`.
		expect(child.signalCode).toBe("SIGKILL");
	}, 10_000);

	it("does not signal a child whose exit is already authoritative", async () => {
		const signals: NodeJS.Signals[] = [];
		const child = Object.assign(new EventEmitter(), {
			pid: 4243,
			exitCode: 0 as number | null,
			signalCode: null as NodeJS.Signals | null,
			kill(sig: NodeJS.Signals): boolean {
				signals.push(sig);
				return true;
			},
		});

		await reapSpawnedBrokerForTest(child as unknown as ChildProcess, { gracefulMs: 1, killVerifyMs: 1 });

		expect(signals).toEqual([]);
	});
	it("reaps a spawn failure with no process as a no-op instead of waiting on SIGKILL", async () => {
		// A spawn failure (e.g. ENOENT) never created a kernel process: pid is
		// undefined and there is nothing to signal or await. Reaping must be a no-op
		// rather than running out the SIGKILL cap and reporting a stuck child that
		// never existed — the distinct failure this owner must keep closed.
		const child = Object.assign(new EventEmitter(), {
			pid: undefined,
			exitCode: null as number | null,
			signalCode: null as NodeJS.Signals | null,
			kill: (): boolean => false,
		});
		await expect(reapSpawnedBrokerForTest(child as unknown as ChildProcess)).resolves.toBeUndefined();
	}, 10_000);

	it("retains unverified broker authority and fences replacement startup", async () => {
		const dir = await temp();
		const signals: NodeJS.Signals[] = [];
		const child = Object.assign(new EventEmitter(), {
			pid: 4244,
			exitCode: null as number | null,
			signalCode: null as NodeJS.Signals | null,
			kill(sig: NodeJS.Signals): boolean {
				signals.push(sig);
				return true;
			},
		});
		const owner = registerBrokerOwnerForTest(dir, child as unknown as ChildProcess, {
			gracefulMs: 1,
			killVerifyMs: 1,
		});
		const competingDiscovery: BrokerDiscovery = {
			version: 1,
			protocolVersion: 3,
			packageGeneration: "test",
			ownerId: "competitor",
			pid: process.pid,
			incarnation: "competing-incarnation",
			host: "127.0.0.1",
			port: 1,
			url: "ws://127.0.0.1:1",
			token: "competitor-token",
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
		};
		const spy = vi.spyOn(brokerDiscovery, "readBrokerDiscovery").mockResolvedValue(competingDiscovery);
		try {
			await expect(owner.stop()).rejects.toThrow("did not exit after SIGKILL");
			expect(brokerOwnerForTest(dir)).toBe(owner);

			// A new ensure must retry the exact retained owner and reject; it may not
			// discard that authority handle and spawn a replacement.
			await expect(ensureBroker({ agentDir: dir })).rejects.toThrow("did not exit after SIGKILL");
			expect(brokerOwnerForTest(dir)).toBe(owner);
			expect(signals).toEqual(["SIGTERM", "SIGKILL", "SIGTERM", "SIGKILL"]);

			child.signalCode = "SIGKILL";
			await owner.stop();
			expect(brokerOwnerForTest(dir)).toBeUndefined();
		} finally {
			spy.mockRestore();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("does not let a stale stop handle delete its successor owner", async () => {
		const dir = await temp();
		const exitedChild = (pid: number) =>
			Object.assign(new EventEmitter(), {
				pid,
				exitCode: 0 as number | null,
				signalCode: null as NodeJS.Signals | null,
				kill: (): boolean => true,
			});
		const first = registerBrokerOwnerForTest(dir, exitedChild(4245) as unknown as ChildProcess);
		const successor = registerBrokerOwnerForTest(dir, exitedChild(4246) as unknown as ChildProcess);

		await first.stop();
		expect(brokerOwnerForTest(dir)).toBe(successor);
		await successor.stop();
		expect(brokerOwnerForTest(dir)).toBeUndefined();
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("shares one in-process startup and owner across concurrent ensure calls", async () => {
		const dir = await temp();
		const first = ensureBroker({ agentDir: dir });
		const second = ensureBroker({ agentDir: dir });

		expect(second).toBe(first);
		const [left, right] = await Promise.all([first, second]);
		expect(right).toEqual(left);
		const owner = brokerOwnerForTest(dir);
		expect(owner).toBeDefined();
		await owner?.stop();
		expect(brokerOwnerForTest(dir)).toBeUndefined();
		await fs.rm(dir, { recursive: true, force: true });
	}, 20_000);
	it("leaves exactly one live detached broker after concurrent process startup", async () => {
		const dir = await temp();
		const children = [0, 1].map(() =>
			Bun.spawn([process.execPath, "run", brokerEntrypoint, "sdk", "broker-internal", "--agent-dir", dir], {
				stdout: "ignore",
				stderr: "ignore",
			}),
		);
		try {
			const discovery = await waitForDiscovery(dir, children);
			// The losing broker exits once it observes the winner's discovery record.
			// Poll instead of a fixed delay so the assertion is robust to CI scheduling
			// (the loser's exit can lag the discovery write under load).
			for (let attempt = 0; attempt < 200 && children.every(child => child.exitCode === null); attempt++)
				await sleep(25);
			const exited = children.filter(child => child.exitCode !== null);
			expect(exited).toHaveLength(1);
			const owner = children.find(child => child.exitCode === null);
			expect(owner).toBeDefined();
			expect(discovery.pid).toBe(owner!.pid!);
			owner!.kill("SIGTERM");
			await Promise.all(children.map(child => child.exited));
		} finally {
			for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
			await Promise.all(children.map(child => child.exited));
			await fs.rm(dir, { recursive: true, force: true });
		}
	}, 20_000);
	it("returns only an endpoint bound to the indexed incarnation", async () => {
		const dir = await temp();
		const stateRoot = path.join(dir, "state");
		const endpointPath = path.join(stateRoot, "sdk", "s.json");
		const broker = new Broker({ agentDir: dir });
		await broker.index.open();
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.writeFile(endpointPath, JSON.stringify({ sessionId: "s", pid: process.pid, token: "session-secret" }));
		const endpointMtimeMs = (await fs.stat(endpointPath)).mtimeMs;
		await broker.index.append({
			type: "host_registered",
			sessionId: "s",
			locator: { repo: "r", stateRoot },
			endpointGeneration: 3,
			pid: process.pid,
			endpointMtimeMs,
		});
		await broker.index.append({
			type: "host_heartbeat",
			sessionId: "s",
			locator: { repo: "r", stateRoot },
			endpointGeneration: 3,
			pid: process.pid,
		});
		const endpointIncarnation = createHash("sha256")
			.update(JSON.stringify({ endpointGeneration: 3, endpointMtimeMs, pid: process.pid, sessionId: "s" }))
			.digest("hex");
		expect(
			await broker.handleRequest("session.get_endpoint", {
				sessionId: "s",
				endpointGeneration: 3,
				endpointIncarnation,
			}),
		).toEqual({
			ok: true,
			result: { sessionId: "s", pid: process.pid, token: "session-secret" },
		});
		expect(
			await broker.handleRequest("session.get_endpoint", {
				sessionId: "s",
				endpointGeneration: 3,
				endpointIncarnation: "0".repeat(64),
			}),
		).toEqual({
			ok: false,
			error: { code: "endpoint_stale", message: "session endpoint is stale" },
		});
		expect(await broker.handleRequest("session.get_endpoint", { sessionId: "s", endpointGeneration: 2 })).toEqual({
			ok: false,
			error: { code: "endpoint_stale", message: "session endpoint is stale" },
		});
		await broker.index.append({
			type: "host_registered",
			sessionId: "s",
			locator: { repo: "r", stateRoot },
			endpointGeneration: 4,
			pid: process.pid,
			endpointMtimeMs: endpointMtimeMs + 1,
		});
		await broker.index.append({
			type: "host_heartbeat",
			sessionId: "s",
			locator: { repo: "r", stateRoot },
			endpointGeneration: 4,
			pid: process.pid,
		});
		expect(await broker.handleRequest("session.get_endpoint", { sessionId: "s", endpointGeneration: 4 })).toEqual({
			ok: false,
			error: { code: "endpoint_stale", message: "session endpoint is stale" },
		});
	});
	it("rejects a cross-scope live resume without returning the indexed endpoint", async () => {
		const dir = await temp();
		const liveCwd = path.join(dir, "live-workspace");
		const requestedCwd = path.join(dir, "requested-workspace");
		await fs.mkdir(liveCwd, { recursive: true });
		await fs.mkdir(requestedCwd, { recursive: true });
		const stateRoot = path.join(liveCwd, ".gjc", "state");
		const sessionId = "shared-live-session";
		const sessionDir = SessionManager.getDefaultSessionDir(liveCwd, dir);
		const sessionPath = path.join(sessionDir, `${sessionId}.jsonl`);
		const endpointPath = path.join(stateRoot, "sdk", `${sessionId}.json`);
		const broker = new Broker({ agentDir: dir });
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.mkdir(sessionDir, { recursive: true });
		await fs.writeFile(
			sessionPath,
			`${JSON.stringify({ type: "session", id: sessionId, timestamp: new Date().toISOString(), cwd: liveCwd })}\n`,
		);
		await fs.writeFile(
			endpointPath,
			JSON.stringify({ sessionId, pid: process.pid, token: "foreign-workspace-token" }),
		);
		await broker.start();
		try {
			await broker.index.append({
				type: "host_registered",
				sessionId,
				locator: { repo: liveCwd, stateRoot },
				endpointGeneration: 1,
				pid: process.pid,
				endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
			});
			await broker.index.append({
				type: "host_heartbeat",
				sessionId,
				locator: { repo: liveCwd, stateRoot },
				endpointGeneration: 1,
				pid: process.pid,
			});
			const result = await broker.handleRequest(
				"session.resume",
				{
					cwd: requestedCwd,
					target: { path: requestedCwd },
					sessionId,
					sessionPath,
				},
				"cross-scope-resume",
			);
			expect(result).toEqual({
				ok: false,
				error: {
					code: "endpoint_stale",
					message: "Live session does not match the requested resume scope.",
				},
			});
			expect(JSON.stringify(result)).not.toContain("foreign-workspace-token");
		} finally {
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("replays only the same lifecycle body and conflicts when a caller reuses its key for the same target", async () => {
		const dir = await temp();
		const broker = new Broker({ agentDir: dir });
		await broker.start();
		try {
			const input = { sessionId: "saved", sessionPath: path.join(dir, "missing.json"), trace: "first" };
			const first = await broker.handleRequest("session.delete", input, "caller-key");
			expect(await broker.handleRequest("session.delete", input, "caller-key")).toEqual(first);
			expect(await broker.handleRequest("session.delete", { ...input, trace: "changed" }, "caller-key")).toEqual({
				ok: false,
				error: { code: "idempotency_conflict", message: "idempotency key was used with a different request" },
			});
		} finally {
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("binds session.delete to the requested session header and configured storage root", async () => {
		const dir = await temp();
		const cwd = path.join(dir, "repo");
		const sessions = path.join(getSessionsDir(dir), "project");
		const requested = path.join(sessions, "requested.jsonl");
		const other = path.join(sessions, "other.jsonl");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(sessions, { recursive: true });
		await fs.writeFile(requested, `${JSON.stringify({ type: "session", id: "requested" })}\n`);
		await fs.writeFile(other, `${JSON.stringify({ type: "session", id: "other" })}\n`);
		const broker = new Broker({ agentDir: dir });
		await broker.start();
		try {
			expect(
				await broker.handleRequest(
					"session.delete",
					{ sessionId: "requested", sessionPath: other, cwd },
					"delete-cross-session",
				),
			).toEqual({
				ok: false,
				error: {
					code: "invalid_input",
					message: "session.delete path is not an owned managed session for the configured cwd.",
				},
			});
			expect(await fs.readFile(other, "utf8")).toContain('"other"');
			expect(
				await broker.handleRequest(
					"session.delete",
					{ sessionId: "requested", sessionPath: path.join(dir, "outside.jsonl"), cwd },
					"delete-outside-root",
				),
			).toEqual({
				ok: false,
				error: {
					code: "invalid_input",
					message: "session.delete path is not an owned managed session for the configured cwd.",
				},
			});
			expect(await fs.readFile(requested, "utf8")).toContain('"requested"');
			const external = path.join(dir, "external.jsonl");
			const externalArtifacts = external.slice(0, -6);
			const linked = path.join(sessions, "linked.jsonl");
			await fs.writeFile(external, `${JSON.stringify({ type: "session", id: "requested" })}\n`);
			await fs.mkdir(externalArtifacts);
			await fs.symlink(external, linked);
			expect(
				await broker.handleRequest(
					"session.delete",
					{ sessionId: "requested", sessionPath: linked, cwd },
					"delete-symlink-escape",
				),
			).toEqual({
				ok: false,
				error: {
					code: "invalid_input",
					message: "session.delete path is not an owned managed session for the configured cwd.",
				},
			});
			expect(await fs.readFile(external, "utf8")).toContain('"requested"');
			expect((await fs.stat(externalArtifacts)).isDirectory()).toBe(true);
			const legacyDirectory = path.join(getSessionsDir(dir), `--${cwd.replace(/^\//, "").replace(/[/:]/g, "-")}--`);
			const legacyReplayPath = path.join(legacyDirectory, "legacy-replay.jsonl");
			await fs.mkdir(legacyDirectory, { recursive: true });
			await fs.writeFile(
				legacyReplayPath,
				`${JSON.stringify({ type: "session", id: "legacy-replay", timestamp: new Date().toISOString(), cwd })}\n`,
			);
			const originalDelete = FileSessionStorage.prototype.deleteSessionVerified;
			let legacyReplayCalls = 0;
			FileSessionStorage.prototype.deleteSessionVerified = async target => {
				legacyReplayCalls += 1;
				return {
					kind: "cleanup_pending" as const,
					phase: "transcript" as const,
					error: new Error("legacy replay remains pending"),
					transcriptIdentity: target.transcriptIdentity,
					detachedTranscriptPath: target.plannedTranscriptPath,
					retainedUnknownPath: target.plannedTranscriptPath,
				};
			};
			try {
				const input = { sessionId: "legacy-replay", sessionPath: legacyReplayPath, cwd };
				expect(await broker.handleRequest("session.delete", input, "legacy-cleanup-key")).toMatchObject({
					ok: false,
					error: { code: "cleanup_pending", cleanup: { sessionsRoot: getSessionsDir(dir) } },
				});
				expect(await broker.handleRequest("session.delete", input, "legacy-cleanup-key-b")).toMatchObject({
					ok: false,
					error: { code: "cleanup_pending" },
				});
				expect(legacyReplayCalls).toBe(1);
			} finally {
				FileSessionStorage.prototype.deleteSessionVerified = originalDelete;
			}
		} finally {
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("rejects traversal and conflicting session-id aliases before lifecycle state access", async () => {
		const dir = await temp();
		const broker = new Broker({ agentDir: dir });
		try {
			expect(await broker.handleRequest("session.get_endpoint", { sessionId: "../escape" })).toEqual({
				ok: false,
				error: { code: "invalid_input", message: "sessionId must be a canonical safe identifier" },
			});
			expect(
				await broker.handleRequest("session.close", { sessionId: "session-a", id: "session-b" }, "alias-conflict"),
			).toEqual({ ok: false, error: { code: "invalid_input", message: "sessionId aliases conflict" } });
			await expect(fs.stat(path.join(dir, "sdk", "escape.json"))).rejects.toThrow();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("replays id and sessionId lifecycle aliases under one caller idempotency key", async () => {
		const dir = await temp();
		const broker = new Broker({ agentDir: dir });
		await broker.start();
		try {
			const first = await broker.handleRequest("session.close", { sessionId: "missing" }, "same-close");
			expect(await broker.handleRequest("session.close", { id: "missing" }, "same-close")).toEqual(first);
		} finally {
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects a non-default lifecycle state root at broker ingress", async () => {
		const dir = await temp();
		const broker = new Broker({ agentDir: dir });
		try {
			expect(
				await broker.handleRequest(
					"session.create",
					{ cwd: dir, stateRoot: path.join(dir, "alternate-state") },
					"alternate-state-root",
				),
			).toEqual({
				ok: false,
				error: { code: "invalid_input", message: "stateRoot must be the default .gjc/state for cwd." },
			});
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("fails closed on retained artifacts across retry without deleting transcript authority", async () => {
		const dir = await temp();
		const cwd = path.join(dir, "workspace");
		const stateRoot = path.join(cwd, ".gjc", "state");
		const sessionId = "verified-delete";
		const sessionPath = await managedSessionPath(dir, cwd, sessionId);
		const artifactsDir = sessionPath.slice(0, -6);
		const broker = new Broker({ agentDir: dir });
		await fs.mkdir(path.dirname(sessionPath), { recursive: true });
		await fs.writeFile(sessionPath, `${JSON.stringify({ type: "session", id: sessionId, cwd })}\n`);
		await fs.mkdir(artifactsDir);
		await fs.writeFile(path.join(artifactsDir, ".artifact.txt"), "artifact");
		await broker.start();
		try {
			await broker.index.append({
				type: "host_registered",
				sessionId,
				locator: { repo: cwd, stateRoot },
				endpointGeneration: 1,
				pid: 999_999_999,
			});
			const pending = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd },
				"verified-delete-key",
			);
			expect(pending).toMatchObject({
				ok: false,
				error: { code: "cleanup_pending", cleanup: { phase: "artifacts", sessionId } },
			});
			expect(await fs.readFile(sessionPath, "utf8")).toContain(sessionId);
			await expect(fs.stat(artifactsDir)).rejects.toThrow();
			const retainedPayloads = (await fs.readdir(path.dirname(sessionPath), { recursive: true })).filter(entry =>
				entry.endsWith(".artifact.txt"),
			);
			expect(retainedPayloads).toHaveLength(1);
			expect(await fs.readFile(path.join(path.dirname(sessionPath), retainedPayloads[0]!), "utf8")).toBe("");

			const retried = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd },
				"verified-delete-key",
			);
			expect(retried).toMatchObject({
				ok: false,
				error: { code: "cleanup_pending", cleanup: { phase: "artifacts", sessionId } },
			});
			expect(await fs.readFile(sessionPath, "utf8")).toContain(sessionId);
			const payloadsAfterRetry = (await fs.readdir(path.dirname(sessionPath), { recursive: true })).filter(entry =>
				entry.endsWith(".artifact.txt"),
			);
			expect(payloadsAfterRetry).toHaveLength(1);
			expect(await fs.readFile(path.join(path.dirname(sessionPath), payloadsAfterRetry[0]!), "utf8")).toBe("");
		} finally {
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("removes an authorized root-only artifact quarantine before transcript cleanup", async () => {
		const dir = await temp();
		const cwd = path.join(dir, "workspace");
		const stateRoot = path.join(cwd, ".gjc", "state");
		const sessionId = "root-only-retained-artifacts";
		const sessionPath = await managedSessionPath(dir, cwd, sessionId);
		const artifactsDir = sessionPath.slice(0, -6);
		const broker = new Broker({ agentDir: dir });
		const originalDelete = FileSessionStorage.prototype.deleteSessionVerified;
		let calls = 0;
		let transcriptPhase = false;
		await fs.mkdir(path.dirname(sessionPath), { recursive: true });
		await fs.writeFile(sessionPath, `${JSON.stringify({ type: "session", id: sessionId, cwd })}\n`);
		await fs.mkdir(artifactsDir);
		await broker.start();
		FileSessionStorage.prototype.deleteSessionVerified = async target => {
			calls++;
			if (calls === 1) {
				if (!target.plannedArtifactsPath || !target.expectedArtifactsIdentity)
					throw new Error("Expected preauthorized artifact quarantine");
				await fs.rename(artifactsDir, target.plannedArtifactsPath);
				const tree = native.snapshotDirectoryTree(target.plannedArtifactsPath);
				if (!tree.ok || !tree.snapshot) throw new Error("Expected authorized root tree snapshot");
				return {
					kind: "cleanup_pending",
					phase: "artifacts",
					error: new Error("authorized root-only quarantine"),
					artifactsIdentity: target.expectedArtifactsIdentity,
					artifactsTree: tree.snapshot,
					detachedArtifactsPath: target.plannedArtifactsPath,
					transcriptIdentity: target.transcriptIdentity,
				};
			}
			if (calls === 2) {
				if (!target.detachedArtifactsPath) throw new Error("Expected retained artifact root retry");
				await fs.rmdir(target.detachedArtifactsPath);
				return { kind: "artifacts_removed", phase: "artifacts", transcriptIdentity: target.transcriptIdentity };
			}
			transcriptPhase = target.artifactsRemoved === true;
			if (!transcriptPhase) throw new Error("Expected transcript-phase cleanup");
			await fs.unlink(target.transcriptPath);
			return { kind: "deleted" };
		};
		try {
			await broker.index.append({
				type: "host_registered",
				sessionId,
				locator: { repo: cwd, stateRoot },
				endpointGeneration: 1,
				pid: 999_999_999,
			});
			const pending = await broker.handleRequest("session.delete", { sessionId, sessionPath, cwd }, "root-only-key");
			expect(pending).toMatchObject({
				ok: false,
				error: { code: "cleanup_pending", cleanup: { phase: "artifacts", sessionId } },
			});
			expect(await fs.readFile(sessionPath, "utf8")).toContain(sessionId);
			expect(await broker.handleRequest("session.delete", { sessionId, sessionPath, cwd }, "root-only-key")).toEqual(
				{ ok: true, result: { sessionId } },
			);
			expect(calls).toBe(3);
			expect(transcriptPhase).toBe(true);
			await expect(fs.stat(sessionPath)).rejects.toThrow();
			await expect(fs.stat(artifactsDir)).rejects.toThrow();
		} finally {
			FileSessionStorage.prototype.deleteSessionVerified = originalDelete;
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps transcript authority when a sibling quarantine alias survives exact removal", async () => {
		const dir = await temp();
		const cwd = path.join(dir, "workspace");
		const sessionId = "artifact-sibling-after-removal";
		const sessionPath = await managedSessionPath(dir, cwd, sessionId);
		const artifactsDir = sessionPath.slice(0, -6);
		const broker = new Broker({ agentDir: dir });
		const originalDelete = FileSessionStorage.prototype.deleteSessionVerified;
		let calls = 0;
		let siblingAlias: string | undefined;
		await fs.mkdir(path.dirname(sessionPath), { recursive: true });
		await fs.writeFile(sessionPath, `${JSON.stringify({ type: "session", id: sessionId, cwd })}\n`);
		await fs.mkdir(artifactsDir);
		await broker.start();
		FileSessionStorage.prototype.deleteSessionVerified = async target => {
			calls++;
			if (calls === 1) {
				if (!target.plannedArtifactsPath || !target.expectedArtifactsIdentity)
					throw new Error("Expected preauthorized artifact quarantine");
				await fs.rename(artifactsDir, target.plannedArtifactsPath);
				const tree = native.snapshotDirectoryTree(target.plannedArtifactsPath);
				if (!tree.ok || !tree.snapshot) throw new Error("Expected root-only tree snapshot");
				return {
					kind: "cleanup_pending",
					phase: "artifacts",
					error: new Error("root-only pending"),
					artifactsIdentity: target.expectedArtifactsIdentity,
					artifactsTree: tree.snapshot,
					detachedArtifactsPath: target.plannedArtifactsPath,
					transcriptIdentity: target.transcriptIdentity,
				};
			}
			if (!target.detachedArtifactsPath) throw new Error("Expected retained artifact root");
			await fs.rmdir(target.detachedArtifactsPath);
			siblingAlias = `${target.detachedArtifactsPath}.removing`;
			await fs.mkdir(siblingAlias);
			await fs.writeFile(path.join(siblingAlias, ".payload"), "payload");
			return { kind: "artifacts_removed", phase: "artifacts", transcriptIdentity: target.transcriptIdentity };
		};
		try {
			expect(
				await broker.handleRequest("session.delete", { sessionId, sessionPath, cwd }, "artifact-sibling-key"),
			).toMatchObject({ ok: false, error: { code: "cleanup_pending", cleanup: { phase: "artifacts" } } });
			const replay = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd },
				"artifact-sibling-key",
			);
			expect(replay).toMatchObject({
				ok: false,
				error: { code: "cleanup_pending", cleanup: { phase: "artifacts", sessionId } },
			});
			expect(calls).toBe(2);
			expect(await fs.readFile(sessionPath, "utf8")).toContain(sessionId);
			if (!siblingAlias) throw new Error("Expected sibling quarantine alias");
			expect(await fs.readFile(path.join(siblingAlias, ".payload"), "utf8")).toBe("payload");
		} finally {
			FileSessionStorage.prototype.deleteSessionVerified = originalDelete;
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps transcript completion pending through canonical artifact reappearance", async () => {
		const dir = await temp();
		const cwd = path.join(dir, "workspace");
		const stateRoot = path.join(cwd, ".gjc", "state");
		const sessionId = "canonical-after-artifacts-removed";
		const sessionPath = await managedSessionPath(dir, cwd, sessionId);
		const artifactsDir = sessionPath.slice(0, -6);
		const broker = new Broker({ agentDir: dir });
		const originalDelete = FileSessionStorage.prototype.deleteSessionVerified;
		const transition = broker.ledger.transition.bind(broker.ledger);
		let calls = 0;
		let canonicalInjected = false;
		let plannedArtifactAlias: string | undefined;
		let postOperationArtifactAlias: string | undefined;
		await fs.mkdir(path.dirname(sessionPath), { recursive: true });
		await fs.writeFile(sessionPath, `${JSON.stringify({ type: "session", id: sessionId, cwd })}\n`);
		await fs.mkdir(artifactsDir);
		await broker.start();
		const transitionSpy = vi.spyOn(broker.ledger, "transition").mockImplementation(async (...args) => {
			const result = await transition(...args);
			if (!canonicalInjected && JSON.stringify(args[2]?.response).includes("artifacts were removed")) {
				canonicalInjected = true;
				await fs.mkdir(artifactsDir);
				await fs.writeFile(path.join(artifactsDir, ".reappeared"), "reappeared");
			}
			return result;
		});
		FileSessionStorage.prototype.deleteSessionVerified = async target => {
			calls++;
			if (calls === 1) {
				plannedArtifactAlias = target.plannedArtifactsPath;
				await fs.rmdir(artifactsDir);
				return { kind: "artifacts_removed", phase: "artifacts", transcriptIdentity: target.transcriptIdentity };
			}
			if (calls === 2)
				throw new SessionDeleteVerificationError(
					"artifacts",
					"Artifact path reappeared after durable artifact-phase completion",
				);
			await fs.unlink(target.transcriptPath);
			if (!postOperationArtifactAlias) throw new Error("Expected current planned artifact alias");
			await fs.mkdir(postOperationArtifactAlias);
			await fs.writeFile(path.join(postOperationArtifactAlias, ".post-delete-payload"), "payload");
			return { kind: "deleted" };
		};
		try {
			await broker.index.append({
				type: "host_registered",
				sessionId,
				locator: { repo: cwd, stateRoot },
				endpointGeneration: 1,
				pid: 999_999_999,
			});
			const pending = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd },
				"canonical-after-removed-key",
			);
			expect(pending).toMatchObject({
				ok: false,
				error: { code: "cleanup_pending", cleanup: { artifactsRemoved: true, phase: "transcript", sessionId } },
			});
			expect(JSON.stringify(pending)).not.toContain('"retainedArtifactsRootOnly":true');
			expect(await fs.readFile(path.join(artifactsDir, ".reappeared"), "utf8")).toBe("reappeared");
			const repeatedPending = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd },
				"canonical-after-removed-key",
			);
			expect(repeatedPending).toMatchObject({
				ok: false,
				error: { code: "cleanup_pending", cleanup: { artifactsRemoved: true, phase: "transcript", sessionId } },
			});
			expect(calls).toBe(1);
			await fs.rm(artifactsDir, { recursive: true, force: true });
			if (!plannedArtifactAlias) throw new Error("Expected planned artifact alias");
			await fs.mkdir(plannedArtifactAlias);
			await fs.writeFile(path.join(plannedArtifactAlias, ".payload"), "payload");
			const aliasPending = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd },
				"canonical-after-removed-key",
			);
			expect(aliasPending).toMatchObject({
				ok: false,
				error: { code: "cleanup_pending", cleanup: { artifactsRemoved: true, phase: "transcript", sessionId } },
			});
			expect(calls).toBe(1);
			expect(await fs.readFile(path.join(plannedArtifactAlias, ".payload"), "utf8")).toBe("payload");
			await fs.rm(plannedArtifactAlias, { recursive: true, force: true });
			const racedPending = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd },
				"canonical-after-removed-key",
			);
			expect(racedPending).toMatchObject({
				ok: false,
				error: { code: "cleanup_pending", cleanup: { artifactsRemoved: true, phase: "transcript", sessionId } },
			});
			if (racedPending.ok) throw new Error("Expected raced pending cleanup");
			postOperationArtifactAlias = racedPending.error.cleanup?.plannedArtifactsPath;
			if (!postOperationArtifactAlias) throw new Error("Expected persisted transcript-phase artifact plan");
			expect(calls).toBe(2);
			const postOperationPending = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd },
				"canonical-after-removed-key",
			);
			expect(syncFs.existsSync(postOperationArtifactAlias)).toBe(true);
			expect(postOperationPending).toMatchObject({
				ok: false,
				error: { code: "cleanup_pending", cleanup: { artifactsRemoved: true, phase: "transcript", sessionId } },
			});
			expect(calls).toBe(3);
			expect(await fs.readFile(path.join(postOperationArtifactAlias, ".post-delete-payload"), "utf8")).toBe(
				"payload",
			);
			await fs.rm(postOperationArtifactAlias, { recursive: true, force: true });
			expect(
				await broker.handleRequest(
					"session.delete",
					{ sessionId, sessionPath, cwd },
					"canonical-after-removed-key",
				),
			).toMatchObject({ ok: false, error: { code: "cleanup_pending", cleanup: { phase: "transcript" } } });
			expect(calls).toBe(3);
		} finally {
			transitionSpy.mockRestore();
			FileSessionStorage.prototype.deleteSessionVerified = originalDelete;
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("retains artifact side-path authority instead of promoting an empty detached root", async () => {
		const dir = await temp();
		const cwd = path.join(dir, "workspace");
		const cwdAlias = path.join(dir, "workspace-alias");
		const stateRoot = path.join(cwd, ".gjc", "state");
		const sessionId = "retained-artifact-side-path";
		const sessionPath = await managedSessionPath(dir, cwd, sessionId);
		const artifactsDir = sessionPath.slice(0, -6);
		const broker = new Broker({ agentDir: dir });
		const originalDelete = FileSessionStorage.prototype.deleteSessionVerified;
		let calls = 0;
		let retainedSidePath: string | undefined;
		await fs.mkdir(stateRoot, { recursive: true });
		await fs.symlink(cwd, cwdAlias, "dir");
		await fs.mkdir(path.dirname(sessionPath), { recursive: true });
		await fs.writeFile(sessionPath, `${JSON.stringify({ type: "session", id: sessionId, cwd })}\n`);
		await fs.mkdir(artifactsDir);
		await broker.start();
		FileSessionStorage.prototype.deleteSessionVerified = async target => {
			calls++;
			if (calls > 1) {
				await fs.unlink(target.transcriptPath);
				return { kind: "deleted" };
			}
			if (!target.plannedArtifactsPath || !target.expectedArtifactsIdentity)
				throw new Error("Expected preauthorized artifact quarantine");
			await fs.rename(artifactsDir, target.plannedArtifactsPath);
			retainedSidePath = `${target.plannedArtifactsPath}.unknown`;
			await fs.mkdir(retainedSidePath);
			await fs.writeFile(path.join(retainedSidePath, ".payload"), "payload");
			const tree = native.snapshotDirectoryTree(target.plannedArtifactsPath);
			if (!tree.ok || !tree.snapshot) throw new Error("Expected authorized root tree snapshot");
			return {
				kind: "cleanup_pending",
				phase: "artifacts",
				error: new Error("retained side authority"),
				artifactsIdentity: target.expectedArtifactsIdentity,
				artifactsTree: tree.snapshot,
				detachedArtifactsPath: target.plannedArtifactsPath,
				retainedUnknownPath: retainedSidePath,
				transcriptIdentity: target.transcriptIdentity,
			};
		};
		try {
			await broker.index.append({
				type: "host_registered",
				sessionId,
				locator: { repo: cwd, stateRoot },
				endpointGeneration: 1,
				pid: 999_999_999,
			});
			const response = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd },
				"retained-side-path-key",
			);
			expect(response).toMatchObject({
				ok: false,
				error: {
					code: "cleanup_pending",
					cleanup: { phase: "artifacts", sessionId, retainedArtifactsUnknownPath: retainedSidePath },
				},
			});
			expect(calls).toBe(1);
			expect(await fs.readFile(sessionPath, "utf8")).toContain(sessionId);
			if (!retainedSidePath) throw new Error("Expected retained side path");
			expect(await fs.readFile(path.join(retainedSidePath, ".payload"), "utf8")).toBe("payload");
			const crossKey = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd: cwdAlias },
				"retained-side-path-key-b",
			);
			expect(crossKey).toMatchObject({
				ok: false,
				error: {
					code: "cleanup_pending",
					cleanup: { retainedArtifactsUnknownPath: retainedSidePath },
				},
			});
			expect(calls).toBe(1);
			const replay = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd },
				"retained-side-path-key",
			);
			expect(replay).toMatchObject({
				ok: false,
				error: {
					code: "cleanup_pending",
					message:
						"Saved session cleanup is pending in artifacts: retained artifact side authority remains before transcript cleanup.",
					cleanup: { retainedArtifactsUnknownPath: retainedSidePath },
				},
			});
			expect(calls).toBe(1);
			await fs.rm(retainedSidePath, { recursive: true, force: true });
			const absentPathReplay = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd },
				"retained-side-path-key",
			);
			expect(absentPathReplay).toMatchObject({
				ok: false,
				error: {
					code: "cleanup_pending",
					cleanup: { retainedArtifactsUnknownPath: retainedSidePath },
				},
			});
			expect(calls).toBe(1);
			expect(await fs.readFile(sessionPath, "utf8")).toContain(sessionId);
			const rows = (await fs.readFile(path.join(dir, "sdk", "lifecycle-ledger.jsonl"), "utf8"))
				.trim()
				.split("\n")
				.map(line => JSON.parse(line) as { identity: string; intendedSessionId?: string; response?: unknown });
			const pendingIdentity = rows.findLast(
				row => row.intendedSessionId === sessionId && JSON.stringify(row.response).includes('"cleanup_pending"'),
			)?.identity;
			if (!pendingIdentity) throw new Error("Expected durable pending cleanup identity");
			const corruptResponse = JSON.parse(JSON.stringify(absentPathReplay)) as {
				ok: false;
				error: { cleanup: Record<string, unknown> };
			};
			corruptResponse.error.cleanup.retainedArtifactsSideAuthority = "corrupt";
			corruptResponse.error.cleanup.artifactsRemoved = true;
			await broker.ledger.transition(pendingIdentity, "effect_started", { response: corruptResponse });
			const corruptReplay = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd },
				"retained-side-path-key",
			);
			expect(corruptReplay).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
			const fencedAfterUncertainty = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd },
				"retained-side-path-key-c",
			);
			expect(fencedAfterUncertainty).toMatchObject({
				ok: false,
				error: {
					code: "terminal_uncertain",
					message: "Prior cleanup authority for this session is corrupt or incomplete.",
				},
			});
			expect(calls).toBe(1);
		} finally {
			FileSessionStorage.prototype.deleteSessionVerified = originalDelete;
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("refuses an out-of-plan root-only artifact quarantine across replay", async () => {
		const dir = await temp();
		const cwd = path.join(dir, "workspace");
		const stateRoot = path.join(cwd, ".gjc", "state");
		const sessionId = "foreign-root-only-artifacts";
		const sessionPath = await managedSessionPath(dir, cwd, sessionId);
		const artifactsDir = sessionPath.slice(0, -6);
		const foreignRoot = path.join(path.dirname(sessionPath), ".foreign-empty-artifacts");
		const broker = new Broker({ agentDir: dir });
		const originalDelete = FileSessionStorage.prototype.deleteSessionVerified;
		let calls = 0;
		await fs.mkdir(path.dirname(sessionPath), { recursive: true });
		await fs.writeFile(sessionPath, `${JSON.stringify({ type: "session", id: sessionId, cwd })}\n`);
		await fs.mkdir(artifactsDir);
		await fs.writeFile(path.join(artifactsDir, ".artifact.txt"), "artifact");
		await fs.mkdir(foreignRoot);
		await broker.start();
		FileSessionStorage.prototype.deleteSessionVerified = async target => {
			calls++;
			if (calls === 2) throw new SessionDeleteVerificationError("artifacts", "retained identity changed");
			const stat = await fs.lstat(foreignRoot, { bigint: true });
			const tree = native.snapshotDirectoryTree(foreignRoot);
			if (!tree.ok || !tree.snapshot) throw new Error("Expected foreign root tree snapshot");
			return {
				kind: "cleanup_pending",
				phase: "artifacts",
				error: new Error("foreign empty quarantine"),
				artifactsIdentity: {
					dev: stat.dev,
					ino: stat.ino,
					nlink: stat.nlink,
					size: Number(stat.size),
					mtimeNs: stat.mtimeNs,
					sha256: "",
				},
				artifactsTree: tree.snapshot,
				detachedArtifactsPath: foreignRoot,
				transcriptIdentity: target.transcriptIdentity,
			};
		};
		try {
			await broker.index.append({
				type: "host_registered",
				sessionId,
				locator: { repo: cwd, stateRoot },
				endpointGeneration: 1,
				pid: 999_999_999,
			});
			const first = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd },
				"foreign-root-only-key",
			);
			expect(first).toMatchObject({
				ok: false,
				error: { code: "cleanup_pending", cleanup: { phase: "artifacts", sessionId } },
			});
			const retried = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd },
				"foreign-root-only-key",
			);
			expect(retried).toMatchObject({
				ok: false,
				error: { code: "cleanup_pending", cleanup: { phase: "artifacts", sessionId } },
			});
			expect(calls).toBe(2);
			const crossKey = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd },
				"foreign-root-only-key-b",
			);
			expect(crossKey).toMatchObject({
				ok: false,
				error: { code: "cleanup_pending", cleanup: { phase: "artifacts", sessionId } },
			});
			expect(calls).toBe(2);
			expect(await fs.readFile(sessionPath, "utf8")).toContain(sessionId);
			expect(await fs.readFile(path.join(artifactsDir, ".artifact.txt"), "utf8")).toBe("artifact");
		} finally {
			FileSessionStorage.prototype.deleteSessionVerified = originalDelete;
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("preserves typed verified-delete partial-cleanup evidence", async () => {
		const dir = await temp();
		const cwd = path.join(dir, "workspace");
		const sessionId = "pending-delete";
		const sessionPath = await managedSessionPath(dir, cwd, sessionId);
		const broker = new Broker({ agentDir: dir });
		const originalDelete = FileSessionStorage.prototype.deleteSessionVerified;
		let detachedArtifactsPath: string | undefined;
		await fs.mkdir(path.dirname(sessionPath), { recursive: true });
		await fs.writeFile(sessionPath, `${JSON.stringify({ type: "session", id: sessionId, cwd })}\n`);
		await broker.start();
		FileSessionStorage.prototype.deleteSessionVerified = async target => {
			detachedArtifactsPath = target.plannedArtifactsPath;
			if (!detachedArtifactsPath) throw new Error("Missing planned artifact path");
			return {
				kind: "cleanup_pending" as const,
				phase: "artifacts" as const,
				error: new Error("artifact cleanup denied"),
				artifactsIdentity: { dev: 7n, ino: 8n, nlink: 1n, size: 9, mtimeNs: 10n, sha256: "a".repeat(64) },
				artifactsTree: { rootDev: "7", rootIno: "8", entries: [] },
				detachedArtifactsPath,
				transcriptIdentity: { dev: 5n, ino: 6n, nlink: 1n, size: 7, mtimeNs: 8n, sha256: "b".repeat(64) },
			};
		};
		try {
			const pending = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd },
				"pending-delete-key",
			);
			expect(pending).toMatchObject({
				ok: false,
				error: {
					code: "cleanup_pending",
					message: "Saved session cleanup is pending in artifacts: artifact cleanup denied",
					cleanup: {
						phase: "artifacts",
						sessionId,
						cwd,
						sessionsRoot: path.join(dir, "sessions"),
						transcriptPath: sessionPath,
						metadataRoot: path.join(cwd, ".gjc", "state"),
						artifactsIdentity: { dev: "7", ino: "8", nlink: "1", size: 9, mtimeNs: "10", sha256: "a".repeat(64) },
						transcriptIdentity: { dev: "5", ino: "6", nlink: "1", size: 7, mtimeNs: "8", sha256: "b".repeat(64) },
						detachedArtifactsPath,
					},
				},
			});
			if (!pending.ok) {
				expect(pending.error.cleanup?.plannedArtifactsPath).toMatch(/\.gjc-delete-[\w-]+-artifacts$/);
				expect(pending.error.cleanup?.plannedTranscriptPath).toMatch(/\.gjc-delete-[\w-]+-transcript$/);
			}
			const retried = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd },
				"pending-delete-key",
			);
			expect(retried).toMatchObject({ ok: false, error: { code: "cleanup_pending" } });
			if (!pending.ok && !retried.ok) {
				expect(retried.error.cleanup?.plannedArtifactsPath).not.toBe(pending.error.cleanup?.plannedArtifactsPath);
				expect(retried.error.cleanup?.detachedArtifactsPath).toBe(retried.error.cleanup?.plannedArtifactsPath);
			}
			expect(await fs.readFile(sessionPath, "utf8")).toContain(sessionId);
		} finally {
			FileSessionStorage.prototype.deleteSessionVerified = originalDelete;
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("replays transcript cleanup after artifact completion without reattaching completed artifact authority", async () => {
		const dir = await temp();
		const cwd = path.join(dir, "workspace");
		const stateRoot = path.join(cwd, ".gjc", "state");
		const sessionId = "artifacts-removed-replay";
		const sessionPath = await managedSessionPath(dir, cwd, sessionId);
		const artifactsDir = sessionPath.slice(0, -6);
		const broker = new Broker({ agentDir: dir });
		const originalDelete = FileSessionStorage.prototype.deleteSessionVerified;
		const transcriptIdentity = { dev: 5n, ino: 6n, nlink: 1n, size: 7, mtimeNs: 8n, sha256: "b".repeat(64) };
		const deleteTargets: VerifiedSessionDeleteTarget[] = [];
		let calls = 0;
		await fs.mkdir(path.dirname(sessionPath), { recursive: true });
		await fs.writeFile(sessionPath, `${JSON.stringify({ type: "session", id: sessionId, cwd })}\n`);
		await broker.start();
		await broker.index.append({
			type: "host_registered",
			sessionId,
			locator: { repo: cwd, stateRoot },
			endpointGeneration: 1,
			pid: 999_999_999,
		});
		FileSessionStorage.prototype.deleteSessionVerified = async target => {
			deleteTargets.push(target);
			calls++;
			if (calls === 1) return { kind: "artifacts_removed", phase: "artifacts", transcriptIdentity };
			if (calls === 2)
				return {
					kind: "cleanup_pending",
					phase: "transcript",
					error: new Error("transcript cleanup deferred"),
					transcriptIdentity,
				};
			return { kind: "deleted" };
		};
		try {
			const pending = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd },
				"artifacts-removed-replay-key",
			);
			expect(pending).toMatchObject({
				ok: false,
				error: {
					code: "cleanup_pending",
					cleanup: { artifactsRemoved: true, phase: "transcript" },
				},
			});
			await fs.unlink(sessionPath);
			await fs.mkdir(artifactsDir);
			await fs.writeFile(path.join(artifactsDir, ".reappeared"), "payload");
			const blocked = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd },
				"artifacts-removed-replay-key",
			);
			expect(blocked).toMatchObject({
				ok: false,
				error: { code: "cleanup_pending", cleanup: { artifactsRemoved: true, phase: "transcript" } },
			});
			expect(broker.index.listSessions().sessions.some(session => session.sessionId === sessionId)).toBe(true);
			expect(await fs.readFile(path.join(artifactsDir, ".reappeared"), "utf8")).toBe("payload");
			await fs.rm(artifactsDir, { recursive: true, force: true });
			const replayed = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd },
				"artifacts-removed-replay-key",
			);
			expect(replayed).toMatchObject({
				ok: false,
				error: { code: "cleanup_pending", cleanup: { phase: "transcript" } },
			});
			expect(broker.index.listSessions().sessions.some(session => session.sessionId === sessionId)).toBe(true);
			expect(deleteTargets).toHaveLength(2);
			expect(deleteTargets[1]).toMatchObject({ artifactsRemoved: true });
			expect(deleteTargets[1]?.expectedArtifactsIdentity).toBeUndefined();
			expect(deleteTargets[1]?.expectedArtifactsTree).toBeUndefined();
			expect(deleteTargets[1]?.detachedArtifactsPath).toBeUndefined();
		} finally {
			FileSessionStorage.prototype.deleteSessionVerified = originalDelete;
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps retained transcript side authority pending across same-key and cross-key replay", async () => {
		const dir = await temp();
		const cwd = path.join(dir, "workspace");
		const sessionId = "retained-transcript-side";
		const sessionPath = await managedSessionPath(dir, cwd, sessionId);
		const retainedSidePath = path.join(path.dirname(sessionPath), ".gjc-transcript-retained-unknown");
		const retainedHardlinkPath = path.join(
			path.dirname(sessionPath),
			".retained-hardlink-nested",
			"deeper",
			"link.jsonl",
		);
		const transcriptParentAlias = path.join(dir, "transcript-parent-alias");
		const aliasedSessionPath = path.join(transcriptParentAlias, path.basename(sessionPath));
		const broker = new Broker({ agentDir: dir });
		const originalDelete = FileSessionStorage.prototype.deleteSessionVerified;
		let calls = 0;
		await fs.mkdir(path.dirname(sessionPath), { recursive: true });
		await fs.writeFile(sessionPath, `${JSON.stringify({ type: "session", id: sessionId, cwd })}\n`);
		await fs.mkdir(path.dirname(retainedHardlinkPath), { recursive: true });
		if (process.platform !== "win32") await fs.symlink(path.dirname(sessionPath), transcriptParentAlias, "dir");
		await broker.start();
		FileSessionStorage.prototype.deleteSessionVerified = async target => {
			calls++;
			if (calls === 1)
				return { kind: "artifacts_removed", phase: "artifacts", transcriptIdentity: target.transcriptIdentity };
			if (!syncFs.existsSync(retainedHardlinkPath)) syncFs.linkSync(target.transcriptPath, retainedHardlinkPath);
			await fs.unlink(target.transcriptPath);
			await fs.mkdir(retainedSidePath);
			await fs.writeFile(path.join(retainedSidePath, ".payload"), "payload");
			return {
				kind: "cleanup_pending",
				phase: "transcript",
				error: new Error("retained transcript side authority"),
				transcriptIdentity: target.transcriptIdentity,
				detachedTranscriptPath: target.plannedTranscriptPath,
				retainedUnknownPath: retainedSidePath,
			};
		};
		try {
			const pending = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd },
				"retained-transcript-side-key",
			);
			expect(pending).toMatchObject({
				ok: false,
				error: {
					code: "cleanup_pending",
					cleanup: { phase: "transcript", retainedTranscriptUnknownPath: retainedSidePath },
				},
			});
			expect(calls).toBe(2);
			if (process.platform !== "win32") {
				const aliasReplay = await broker.handleRequest(
					"session.delete",
					{ sessionId, sessionPath: aliasedSessionPath, cwd },
					"retained-transcript-side-key",
				);
				expect(aliasReplay).toMatchObject({
					ok: false,
					error: { code: "cleanup_pending", cleanup: { retainedTranscriptUnknownPath: retainedSidePath } },
				});
				expect(calls).toBe(2);
			}
			const reconnectReplay = await broker.handleRequest(
				"session.delete",
				{ sessionId },
				"retained-transcript-side-key",
			);
			expect(reconnectReplay).toMatchObject({
				ok: false,
				error: { code: "cleanup_pending", cleanup: { retainedTranscriptUnknownPath: retainedSidePath } },
			});
			expect(calls).toBe(2);
			const replay = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd },
				"retained-transcript-side-key",
			);
			expect(replay).toMatchObject({
				ok: false,
				error: { code: "cleanup_pending", cleanup: { retainedTranscriptUnknownPath: retainedSidePath } },
			});
			expect(calls).toBe(2);
			const transcriptParent = path.dirname(sessionPath);
			const renamedTranscriptParent = `${transcriptParent}.renamed`;
			await fs.rename(transcriptParent, renamedTranscriptParent);
			await fs.mkdir(transcriptParent);
			const replacedParentReplay = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd },
				"retained-transcript-side-key",
			);
			expect(replacedParentReplay).toMatchObject({
				ok: false,
				error: { code: "cleanup_pending", cleanup: { phase: "transcript" } },
			});
			expect(calls).toBe(2);
			await fs.rm(transcriptParent, { recursive: true, force: true });
			await fs.rename(renamedTranscriptParent, transcriptParent);
			expect(await fs.readFile(path.join(retainedSidePath, ".payload"), "utf8")).toBe("payload");
			await fs.rm(retainedSidePath, { recursive: true, force: true });
			const importedReplay = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd },
				"retained-transcript-side-key-b",
			);
			expect(importedReplay).toMatchObject({
				ok: false,
				error: { code: "cleanup_pending", cleanup: { retainedTranscriptUnknownPath: retainedSidePath } },
			});
			const nestedHardlinkReplay = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd },
				"retained-transcript-side-key-b",
			);
			expect(nestedHardlinkReplay).toMatchObject({
				ok: false,
				error: { code: "cleanup_pending", cleanup: { phase: "transcript" } },
			});
			expect(calls).toBe(2);
			await fs.rm(path.join(path.dirname(sessionPath), ".retained-hardlink-nested"), {
				recursive: true,
				force: true,
			});
			expect(
				await broker.handleRequest(
					"session.delete",
					{ sessionId, sessionPath, cwd },
					"retained-transcript-side-key-b",
				),
			).toMatchObject({ ok: false, error: { code: "cleanup_pending", cleanup: { phase: "transcript" } } });
			expect(calls).toBe(2);
		} finally {
			FileSessionStorage.prototype.deleteSessionVerified = originalDelete;
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("retries cleanup pending after restart, then reopens and exactly replays successful metadata cleanup", async () => {
		const dir = await temp();
		const cwd = path.join(dir, "workspace");
		const stateRoot = path.join(cwd, ".gjc", "state");
		const sessionId = "metadata-cleanup-pending";
		const sessionPath = await managedSessionPath(dir, cwd, sessionId);
		const markerPath = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`);
		let broker = new Broker({ agentDir: dir });
		const originalUnlink = native.exactUnlink;
		let detachedQ1: string | undefined;
		await fs.mkdir(path.dirname(sessionPath), { recursive: true });
		await fs.writeFile(sessionPath, `${JSON.stringify({ type: "session", id: sessionId, cwd })}\n`);
		await fs.mkdir(path.dirname(markerPath), { recursive: true });
		await fs.writeFile(
			markerPath,
			JSON.stringify({ pid: 2_147_483_647, effectMarker: "metadata", incarnation: "test" }),
		);
		await broker.start();
		const metadataUnlink: typeof native.exactUnlink = (pathname, identity) => {
			if (pathname === markerPath) {
				detachedQ1 = path.join(path.dirname(markerPath), identity.quarantineName!);
				syncFs.renameSync(markerPath, detachedQ1);
				return { ok: false, code: "io_error", detachedPath: detachedQ1 };
			}
			return originalUnlink(pathname, identity);
		};
		try {
			const deleteInput = { sessionId, sessionPath, cwd };
			const pending = await settleRetainedTranscriptForTest(
				broker,
				deleteInput,
				"metadata-cleanup-pending-key",
				await broker.handleRequest("session.delete", deleteInput, "metadata-cleanup-pending-key"),
				metadataUnlink,
			);
			expect(structuredClone(pending)).toMatchObject({ ok: true, result: { sessionId } });
			expect(await fs.stat(markerPath).catch(() => undefined)).toBeUndefined();
			vi.restoreAllMocks();
			await broker.stop();
			broker = new Broker({ agentDir: dir });
			await broker.start();
			expect(
				await broker.handleRequest(
					"session.delete",
					{ sessionId, sessionPath, cwd },
					"metadata-cleanup-pending-key",
				),
			).toMatchObject({ ok: true, result: { sessionId } });
		} finally {
			vi.restoreAllMocks();
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("advances typed retained cleanup authority to completion and exactly replays it", async () => {
		const dir = await temp();
		const cwd = path.join(dir, "workspace");
		const stateRoot = path.join(cwd, ".gjc", "state");
		const sessionId = "retained-authority";
		const sessionPath = await managedSessionPath(dir, cwd, sessionId);
		const markerPath = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`);
		const broker = new Broker({ agentDir: dir });
		await fs.mkdir(path.dirname(sessionPath), { recursive: true });
		await fs.writeFile(sessionPath, `${JSON.stringify({ type: "session", id: sessionId, cwd })}\n`);
		await fs.mkdir(path.dirname(markerPath), { recursive: true });
		await fs.writeFile(
			markerPath,
			JSON.stringify({ pid: 2_147_483_647, effectMarker: "metadata", incarnation: "test" }),
		);
		await broker.start();
		try {
			const deleteInput = { sessionId, sessionPath, cwd };
			const response = await settleRetainedTranscriptForTest(
				broker,
				deleteInput,
				"retained-authority-key",
				await broker.handleRequest("session.delete", deleteInput, "retained-authority-key"),
			);
			expect(response).toMatchObject({ ok: true, result: { sessionId } });
			// Canonical objects are durably absent.
			expect(await fs.stat(sessionPath).catch(() => undefined)).toBeUndefined();
			expect(await fs.stat(markerPath).catch(() => undefined)).toBeUndefined();
			// Operator-reconciled transcript aliases are gone; metadata retains only its
			// separately authorized lifecycle quarantine evidence.
			for (const entry of await fs.readdir(path.dirname(sessionPath))) {
				if (!entry.endsWith("-transcript")) continue;
				const candidate = path.join(path.dirname(sessionPath), entry);
				const stat = await fs.lstat(candidate);
				if (!stat.isFile() || stat.size !== 0 || stat.nlink !== 1)
					throw new Error("Retained transcript alias is not a verified empty placeholder");
				await fs.unlink(candidate);
			}
			const sessionEntries = await fs.readdir(path.dirname(sessionPath));
			const retainedTranscript = sessionEntries.filter(entry => entry.endsWith("-transcript"));
			expect(retainedTranscript).toHaveLength(0);
			const sdkEntries = await fs.readdir(path.dirname(markerPath));
			const retainedMetadata = sdkEntries.filter(entry => entry.endsWith(".lifecycle.json"));
			expect(retainedMetadata).toHaveLength(1);
			expect(retainedMetadata.every(entry => entry.startsWith(".gjc-delete-"))).toBe(true);
			// The typed retained authority is durable in the broker ledger.
			const ledgerRows = (await fs.readFile(path.join(dir, "sdk", "lifecycle-ledger.jsonl"), "utf8"))
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line) as Record<string, unknown>);
			expect(
				ledgerRows.some(
					row => row.state === "effect_started" && JSON.stringify(row.response).includes('"cleanup_pending"'),
				),
			).toBe(true);
			// The terminal response replays exactly.
			expect(
				await broker.handleRequest("session.delete", { sessionId, sessionPath, cwd }, "retained-authority-key"),
			).toEqual(response);
		} finally {
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("refuses retained cleanup evidence outside the authorized quarantine plan", async () => {
		const dir = await temp();
		const cwd = path.join(dir, "workspace");
		const sessionId = "forged-retained-authority";
		const sessionPath = await managedSessionPath(dir, cwd, sessionId);
		const broker = new Broker({ agentDir: dir });
		await fs.mkdir(path.dirname(sessionPath), { recursive: true });
		await fs.writeFile(sessionPath, `${JSON.stringify({ type: "session", id: sessionId, cwd })}\n`);
		await broker.start();
		const originalUnlink = native.exactUnlink;
		const forged = vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
			if (pathname === sessionPath) {
				return {
					ok: false,
					code: "cleanup_pending",
					detachedPath: path.join(path.dirname(sessionPath), ".gjc-delete-forged-transcript"),
				};
			}
			return originalUnlink(pathname, identity);
		});
		try {
			const response = await broker.handleRequest(
				"session.delete",
				{ sessionId, sessionPath, cwd },
				"forged-retained-authority-key",
			);
			expect(response).toMatchObject({
				ok: false,
				error: { code: "cleanup_pending", cleanup: { phase: "transcript" } },
			});
			expect(await fs.readFile(sessionPath, "utf8")).toContain(sessionId);
		} finally {
			forged.mockRestore();
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("returns endpoint_stale without dispatching close after endpoint generation rotation", async () => {
		const dir = await temp();
		const stateRoot = path.join(dir, ".gjc", "state");
		const sessionId = "rotating";
		const endpointPath = path.join(stateRoot, "sdk", `${sessionId}.json`);
		const broker = new Broker({ agentDir: dir });
		let controlRequests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, httpServer) {
				if (httpServer.upgrade(request)) return;
				return new Response("WebSocket required", { status: 426 });
			},
			websocket: {
				open(ws) {
					void (async () => {
						await fs.writeFile(
							endpointPath,
							JSON.stringify({
								sessionId,
								pid: process.pid,
								url: `ws://127.0.0.1:${server.port}`,
								token: "replacement-token",
							}),
						);
						await broker.index.append({
							type: "host_registered",
							sessionId,
							locator: { repo: dir, stateRoot },
							endpointGeneration: 2,
							pid: process.pid,
							endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
						});
						ws.send(JSON.stringify({ type: "hello" }));
					})();
				},
				message(ws, message) {
					const frame = JSON.parse(String(message)) as { id?: string; type?: string };
					if (frame.type === "control_request") controlRequests++;
					if (frame.id) ws.send(JSON.stringify({ id: frame.id, ok: true }));
				},
			},
		});
		await broker.start();
		try {
			await fs.mkdir(path.dirname(endpointPath), { recursive: true });
			await fs.writeFile(
				endpointPath,
				JSON.stringify({
					sessionId,
					pid: process.pid,
					url: `ws://127.0.0.1:${server.port}`,
					token: "initial-token",
				}),
			);
			await broker.index.append({
				type: "host_registered",
				sessionId,
				locator: { repo: dir, stateRoot },
				endpointGeneration: 1,
				pid: process.pid,
				endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
			});
			await broker.index.append({
				type: "host_heartbeat",
				sessionId,
				locator: { repo: dir, stateRoot },
				endpointGeneration: 1,
				pid: process.pid,
			});
			expect(await broker.handleRequest("session.close", { sessionId }, "rotating-close")).toEqual({
				ok: false,
				error: { code: "endpoint_stale", message: "session endpoint is stale" },
			});
			expect(controlRequests).toBe(0);
		} finally {
			server.stop(true);
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("preserves a typed session-host close failure without signal fallback", async () => {
		const dir = await temp();
		const stateRoot = path.join(dir, ".gjc", "state");
		const sessionId = "flush-failure";
		const endpointPath = path.join(stateRoot, "sdk", `${sessionId}.json`);
		const broker = new Broker({ agentDir: dir });
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, httpServer) {
				if (httpServer.upgrade(request)) return;
				return new Response("WebSocket required", { status: 426 });
			},
			websocket: {
				open(ws) {
					ws.send(JSON.stringify({ type: "hello" }));
				},
				message(ws, message) {
					const frame = JSON.parse(String(message)) as { id?: string };
					if (frame.id)
						ws.send(
							JSON.stringify({
								id: frame.id,
								ok: false,
								error: { code: "flush_failed", message: "session flush failed" },
							}),
						);
				},
			},
		});
		await broker.start();
		try {
			await fs.mkdir(path.dirname(endpointPath), { recursive: true });
			await fs.writeFile(
				endpointPath,
				JSON.stringify({
					sessionId,
					pid: process.pid,
					url: `ws://127.0.0.1:${server.port}`,
					token: "flush-token",
				}),
			);
			await broker.index.append({
				type: "host_registered",
				sessionId,
				locator: { repo: dir, stateRoot },
				endpointGeneration: 1,
				pid: process.pid,
				endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
				lifecycleRequestId: "flush-close-capability",
			});
			await broker.index.append({
				type: "host_heartbeat",
				sessionId,
				locator: { repo: dir, stateRoot },
				endpointGeneration: 1,
				pid: process.pid,
			});
			expect(await broker.handleRequest("session.close", { sessionId }, "flush-close")).toEqual({
				ok: false,
				error: { code: "flush_failed", message: "session flush failed" },
			});
		} finally {
			server.stop(true);
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("fixture broker lease authority", () => {
	it("mints one lease for a fresh child and never mints one from an existing owner", async () => {
		const dir = await temp();
		try {
			const started = await startFixtureBrokerWithLeaseForTest({ agentDir: dir });
			expect(typeof started.discovery.pid).toBe("number");
			await expect(startFixtureBrokerWithLeaseForTest({ agentDir: dir })).rejects.toThrow(
				"fixture_broker_lease_unavailable",
			);
			const firstClose = started.lease.close();
			const secondClose = started.lease.close();
			expect(secondClose).toBe(firstClose);
			await firstClose;
			await started.lease.close();
			expect(brokerOwnerForTest(dir)).toBeUndefined();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}, 15_000);

	it("rejects a fixture lease that joins discovery-mode startup without claiming its owner", async () => {
		const dir = await temp();
		try {
			const discovery = ensureBroker({ agentDir: dir });
			await expect(startFixtureBrokerWithLeaseForTest({ agentDir: dir })).rejects.toThrow(
				"fixture_broker_lease_unavailable",
			);
			await discovery;
			const owner = brokerOwnerForTest(dir);
			expect(owner).toBeDefined();
			await owner?.stop();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}, 15_000);

	it("rejects a concurrent second fixture lease and keeps independent roots isolated", async () => {
		const leftDir = await temp();
		const rightDir = await temp();
		try {
			const leftStart = startFixtureBrokerWithLeaseForTest({ agentDir: leftDir });
			await expect(startFixtureBrokerWithLeaseForTest({ agentDir: leftDir })).rejects.toThrow(
				"fixture_broker_lease_unavailable",
			);
			const [left, right] = await Promise.all([
				leftStart,
				startFixtureBrokerWithLeaseForTest({ agentDir: rightDir }),
			]);
			await left.lease.close();
			expect(await readBrokerDiscovery(rightDir)).toMatchObject({
				pid: right.discovery.pid,
				incarnation: right.discovery.incarnation,
			});
			expect(brokerOwnerForTest(rightDir)).toBeDefined();
			await right.lease.close();
		} finally {
			await brokerOwnerForTest(leftDir)?.stop();
			await brokerOwnerForTest(rightDir)?.stop();
			await fs.rm(leftDir, { recursive: true, force: true });
			await fs.rm(rightDir, { recursive: true, force: true });
		}
	}, 15_000);

	it("rejects external discovery without changing its broker", async () => {
		const dir = await temp();
		const broker = new Broker({ agentDir: dir });
		await broker.start();
		try {
			await expect(startFixtureBrokerWithLeaseForTest({ agentDir: dir })).rejects.toThrow(
				"fixture_broker_lease_unavailable",
			);
			expect((await readBrokerDiscovery(dir))?.pid).toBe(process.pid);
		} finally {
			await broker.stop();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
