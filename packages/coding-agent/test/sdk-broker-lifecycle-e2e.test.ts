import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { NotificationServer } from "@gajae-code/natives";
import { openLifecycleSessionManager, runSessionHost } from "../src/commands/sdk";
import { planLaunchWorktree } from "../src/gjc-runtime/launch-worktree";
import { AcpAgent } from "../src/modes/acp/acp-agent";
import { Broker, type BrokerResponse } from "../src/sdk/broker/broker";
import { brokerOwnerForTest } from "../src/sdk/broker/ensure";
import {
	deriveLifecycleDeadlines,
	hasValidLifecycleDeadlines,
	parseDarwinProcessIncarnation,
	processIncarnation,
	setLifecycleCleanupHookForTest,
	setLifecycleCommandResolverForTest,
	setProcessIncarnationForTest,
	writeSessionLifecycleFailure,
} from "../src/sdk/broker/lifecycle";
import { LifecycleLedger } from "../src/sdk/broker/lifecycle-ledger";
import { SessionIndex } from "../src/sdk/broker/session-index";
import { runSdkSessionCli } from "../src/sdk/cli";
import { SdkClient } from "../src/sdk/client";
import { readSdkBrokerDiscovery } from "../src/sdk/client/discovery";
import { createSdkMcpServer } from "../src/sdk/mcp";
import { sanitizeSdkStartupMessage } from "../src/sdk/startup-capability";
import { SessionManager } from "../src/session/session-manager";

const cliEntrypoint = path.resolve(import.meta.dir, "../src/cli.ts");
const spawned: Array<ReturnType<typeof Bun.spawn>> = [];
const brokerDirs: string[] = [];

afterEach(async () => {
	for (const process of spawned.splice(0)) {
		if (process.exitCode === null) process.kill("SIGTERM");
		await process.exited;
	}
	for (const agentDir of brokerDirs.splice(0)) await brokerOwnerForTest(agentDir)?.stop();
});

async function waitFor<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const result = await read();
		if (result !== undefined) return result;
		await Bun.sleep(25);
	}
	throw new Error(`Timed out waiting for ${label}`);
}
async function incarnation(pid: number): Promise<string> {
	const value = processIncarnation(pid);
	if (!value) throw new Error(`Process ${pid} has no readable incarnation.`);
	return value;
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

test("startup diagnostics redact identifier-prefixed assignment secrets before bounded truncation", () => {
	const secret = "credential-value";
	const message = sanitizeSdkStartupMessage(
		`OPENAI_API_KEY=${secret} GJC_NOTIFICATIONS_TOKEN=${secret} SERVICE-password=${secret} ${"x".repeat(600)}０`,
	);
	expect(message).not.toContain(secret);
	expect(message.match(/\[redacted-secret\]/g)?.length).toBe(3);
	expect(new TextEncoder().encode(message).byteLength).toBeLessThanOrEqual(512);
});

test("ledger restart quarantines terminal response and durable-effect digest corruption", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-ledger-digest-"));
	try {
		const ledger = await new LifecycleLedger(agentDir).open();
		const responseIdentity = "response-digest-corruption";
		await ledger.begin(responseIdentity, "response-request");
		const response = { ok: true, result: { sessionId: responseIdentity } };
		await ledger.transition(responseIdentity, "terminal_ok", { response, responseDigest: "corrupt" });
		const effectsIdentity = "effects-digest-corruption";
		await ledger.begin(effectsIdentity, "effects-request");
		await ledger.transition(effectsIdentity, "terminal_ok", {
			response,
			responseDigest: createHash("sha256").update(canonicalJson(response)).digest("hex"),
			durableEffects: {
				worktree: { cwdDigest: "a", created: true, reused: false },
				digest: "corrupt",
			},
		});
		const reopened = await new LifecycleLedger(agentDir).open();
		expect(await reopened.begin(responseIdentity, "response-request")).toMatchObject({ kind: "terminal_uncertain" });
		expect(await reopened.begin(effectsIdentity, "effects-request")).toMatchObject({ kind: "terminal_uncertain" });
		expect(await fs.readFile(path.join(agentDir, "sdk", "lifecycle-ledger.jsonl.corrupt"), "utf8")).toContain(
			"digest-corruption",
		);
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

async function stopDiscoveredBroker(agentDir: string): Promise<void> {
	const discovery = await readSdkBrokerDiscovery(agentDir);
	if (!discovery) return;
	const stillOwned = (): boolean => processIncarnation(discovery.pid) === discovery.incarnation;
	const waitForExit = async (timeoutMs: number): Promise<boolean> => {
		const deadline = Date.now() + timeoutMs;
		while (stillOwned() && Date.now() < deadline) await Bun.sleep(10);
		return !stillOwned();
	};
	if (!stillOwned()) return;
	process.kill(discovery.pid, "SIGTERM");
	if (await waitForExit(2_000)) return;
	if (!stillOwned()) return;
	process.kill(discovery.pid, "SIGKILL");
	if (!(await waitForExit(2_000))) throw new Error(`Test broker ${discovery.pid} did not exit after SIGKILL.`);
}

async function liveLifecycleSession(root: string, agentDir: string, sessionId: string, staleMarkerFirst = false) {
	const stateRoot = path.join(root, ".gjc", "state");
	const request = {
		operation: "session.create",
		sessionId,
		cwd: root,
		stateRoot,
		effectMarker: "subprocess-proof",
		...deriveLifecycleDeadlines(Date.now(), 10_000),
	} as const;
	const child = Bun.spawn([process.execPath, "run", cliEntrypoint, "sdk", "session-host-internal"], {
		cwd: root,
		env: {
			...process.env,
			HOME: root,
			GJC_AGENT_DIR: agentDir,
			GJC_CODING_AGENT_DIR: agentDir,
			GJC_SESSION_ID: sessionId,
			GJC_LIFECYCLE_REQUEST_ID: "subprocess-proof",
			GJC_SDK_LIFECYCLE_REQUEST: JSON.stringify(request),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	spawned.push(child);
	if (!child.pid) throw new Error("session host has no pid");
	const childIncarnation = await incarnation(child.pid);
	await fs.mkdir(path.join(stateRoot, "sdk"), { recursive: true });
	if (staleMarkerFirst) {
		await fs.writeFile(
			path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`),
			JSON.stringify({ pid: child.pid, effectMarker: "stale-effect", incarnation: childIncarnation }),
		);
		await Bun.sleep(25);
	}
	await fs.writeFile(
		path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`),
		JSON.stringify({ pid: child.pid, effectMarker: "subprocess-proof", incarnation: childIncarnation }),
	);
	try {
		const endpoint = await waitFor(async () => {
			try {
				return JSON.parse(await fs.readFile(path.join(stateRoot, "sdk", `${sessionId}.json`), "utf8")) as {
					url: string;
					token: string;
				};
			} catch {
				return undefined;
			}
		}, "session endpoint");
		return { child, endpoint };
	} catch (error) {
		if (child.exitCode === null) child.kill("SIGTERM");
		await child.exited;
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}; child exit=${child.exitCode}; stdout=${await new Response(child.stdout).text()}; stderr=${await new Response(child.stderr).text()}`,
		);
	}
}

test("lifecycle child ignores a stale marker until its current effect marker replaces it", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-stale-marker-"));
	const agentDir = path.join(root, "agent");
	try {
		const { child, endpoint } = await liveLifecycleSession(root, agentDir, "stale-marker", true);
		expect(endpoint.url).toStartWith("ws://");
		child.kill("SIGTERM");
		await child.exited;
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);

test("lifecycle host rejects a transcript replaced after strict authorization before it can be consumed", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-lifecycle-transcript-race-"));
	const agentDir = path.join(root, "agent");
	const session = SessionManager.create(root, SessionManager.getDefaultSessionDir(root, agentDir));
	try {
		await session.ensureOnDisk();
		const sessionPath = session.getSessionFile();
		if (!sessionPath) throw new Error("Expected saved session path.");
		const inventory = SessionManager.inventorySessionsStrict(root, {
			sessionDir: SessionManager.getDefaultSessionDir(root, agentDir),
		});
		if (inventory.kind !== "complete") throw new Error("Expected strict session inventory.");
		const candidate = inventory.candidates.find(item => item.path === sessionPath);
		if (!candidate) throw new Error("Expected strict session candidate.");
		const replacementPath = `${sessionPath}.replacement`;
		await fs.writeFile(replacementPath, `${await fs.readFile(sessionPath, "utf8")}\n`);
		const originalCapture = SessionManager.captureTranscriptStrict;
		let replaced = false;
		const replaceAfterAuthorization: typeof SessionManager.captureTranscriptStrict = (filePath, storage) => {
			const result = originalCapture(filePath, storage);
			if (!replaced) {
				replaced = true;
				renameSync(replacementPath, sessionPath);
			}
			return result;
		};
		SessionManager.captureTranscriptStrict = replaceAfterAuthorization;
		const authorizedDigest = createHash("sha256")
			.update(await fs.readFile(sessionPath))
			.digest("hex");
		try {
			await expect(
				openLifecycleSessionManager(
					{
						operation: "session.resume",
						sessionId: candidate.id,
						cwd: root,
						stateRoot: path.join(root, ".gjc", "state"),
						sessionPath,
						...deriveLifecycleDeadlines(Date.now(), 4_000),
						sessionIdentity: {
							dev: candidate.identity.dev.toString(),
							ino: candidate.identity.ino.toString(),
							size: candidate.identity.size,
							mtimeMs: candidate.identity.mtimeMs,
							mtimeNs: candidate.identity.mtimeNs.toString(),
							sha256: authorizedDigest,
						},
					},
					root,
					agentDir,
				),
			).rejects.toThrow("Lifecycle saved session authority changed while the session host opened it.");
			expect(replaced).toBe(true);
		} finally {
			SessionManager.captureTranscriptStrict = originalCapture;
		}
	} finally {
		await session.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("lifecycle fork rejects a source replaced after capture without destination residue", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-lifecycle-fork-race-"));
	const agentDir = path.join(root, "agent");
	const sourceCwd = path.join(root, "source");
	const targetCwd = path.join(root, "target");
	await fs.mkdir(sourceCwd, { recursive: true });
	await fs.mkdir(targetCwd, { recursive: true });
	const source = SessionManager.create(sourceCwd, SessionManager.getDefaultSessionDir(sourceCwd, agentDir));
	try {
		await source.ensureOnDisk();
		const sourcePath = source.getSessionFile();
		if (!sourcePath) throw new Error("Expected saved source session path.");
		const inventory = SessionManager.inventorySessionsStrict(sourceCwd, {
			sessionDir: SessionManager.getDefaultSessionDir(sourceCwd, agentDir),
		});
		if (inventory.kind !== "complete") throw new Error("Expected strict source session inventory.");
		const candidate = inventory.candidates.find(item => item.path === sourcePath);
		if (!candidate) throw new Error("Expected strict source session candidate.");
		const replacementPath = `${sourcePath}.replacement`;
		await fs.writeFile(replacementPath, await fs.readFile(sourcePath));
		const destinationSessionDir = SessionManager.getDefaultSessionDirReadOnly(targetCwd, agentDir);
		const originalCapture = SessionManager.captureTranscriptStrict;
		let replaced = false;
		const replaceAfterCapture: typeof SessionManager.captureTranscriptStrict = (filePath, storage) => {
			const captured = originalCapture(filePath, storage);
			if (!replaced && filePath === sourcePath && captured.kind === "captured") {
				replaced = true;
				renameSync(replacementPath, sourcePath);
			}
			return captured;
		};
		SessionManager.captureTranscriptStrict = replaceAfterCapture;
		const sourceDigest = createHash("sha256")
			.update(await fs.readFile(sourcePath))
			.digest("hex");
		try {
			await expect(
				openLifecycleSessionManager(
					{
						operation: "session.fork",
						sessionId: "fork-destination",
						cwd: targetCwd,
						stateRoot: path.join(targetCwd, ".gjc", "state"),
						...deriveLifecycleDeadlines(Date.now(), 4_000),
						sourceCwd,
						sourceSessionId: candidate.id,
						sourceSessionPath: sourcePath,
						sourceSessionIdentity: {
							dev: candidate.identity.dev.toString(),
							ino: candidate.identity.ino.toString(),
							size: candidate.identity.size,
							mtimeMs: candidate.identity.mtimeMs,
							mtimeNs: candidate.identity.mtimeNs.toString(),
							sha256: sourceDigest,
						},
					},
					targetCwd,
					agentDir,
				),
			).rejects.toThrow("Lifecycle saved session authority changed while the session host forked it.");
			expect(replaced).toBe(true);
			const initializedEntries = await fs.readdir(destinationSessionDir);
			expect(initializedEntries).toContain(".gjc-managed-session-scope.v2.json");
			expect(initializedEntries.filter(entry => entry.endsWith(".jsonl"))).toEqual([]);
		} finally {
			SessionManager.captureTranscriptStrict = originalCapture;
		}
	} finally {
		await source.close();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("broker derives and validates the exact five-timestamp lifecycle windows", () => {
	const receivedAt = 1_000_000;
	const deadlines = deriveLifecycleDeadlines(receivedAt, 4_000);
	expect(deadlines).toEqual({
		receivedAt,
		requestedReadinessTimeoutMs: 4_000,
		semanticReadyDeadlineAt: receivedAt + 2_000,
		terminationStartDeadlineAt: receivedAt + 3_000,
		lifecycleCleanupDeadlineAt: receivedAt + 4_000,
	});
	expect(hasValidLifecycleDeadlines(deadlines, receivedAt)).toBe(true);
	expect(
		hasValidLifecycleDeadlines(
			{ ...deadlines, terminationStartDeadlineAt: deadlines.terminationStartDeadlineAt - 1 },
			receivedAt,
		),
	).toBe(false);
	expect(() => deriveLifecycleDeadlines(receivedAt, 3_999)).toThrow();
	expect(() => deriveLifecycleDeadlines(Number.MAX_SAFE_INTEGER, 4_000)).toThrow("overflow");
	expect(
		hasValidLifecycleDeadlines({ ...deadlines, lifecycleCleanupDeadlineAt: Number.MAX_SAFE_INTEGER }, receivedAt),
	).toBe(false);
});

test("session host exact cutoff writes proven pre-session absence", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-lifecycle-exact-cutoff-"));
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const sessionId = "exact-cutoff";
	const effectMarker = "exact-cutoff-marker";
	const deadlines = deriveLifecycleDeadlines(1_000, 4_000);
	const names = ["GJC_AGENT_DIR", "GJC_STATE_ROOT", "GJC_LIFECYCLE_REQUEST_ID", "GJC_SDK_LIFECYCLE_REQUEST"] as const;
	const previous = names.map(name => process.env[name]);
	try {
		await fs.mkdir(path.join(stateRoot, "sdk"), { recursive: true });
		await fs.writeFile(
			path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`),
			JSON.stringify({ pid: process.pid, effectMarker, incarnation: "test-incarnation" }),
		);
		process.env.GJC_AGENT_DIR = agentDir;
		process.env.GJC_STATE_ROOT = stateRoot;
		process.env.GJC_LIFECYCLE_REQUEST_ID = effectMarker;
		process.env.GJC_SDK_LIFECYCLE_REQUEST = JSON.stringify({
			operation: "session.create",
			sessionId,
			cwd: root,
			stateRoot,
			effectMarker,
			...deadlines,
		});
		await expect(
			runSessionHost({
				now: () => deadlines.semanticReadyDeadlineAt,
				sleep: async () => {},
				cwd: root,
				processIncarnation: () => "test-incarnation",
			}),
		).rejects.toThrow("readiness cutoff");
		const artifact = JSON.parse(
			await fs.readFile(path.join(stateRoot, "sdk", `${sessionId}.lifecycle.failure.${effectMarker}.json`), "utf8"),
		) as { rollback: Record<string, unknown>; reason: string };
		expect(artifact.reason).toBe("pending");
		expect(artifact.rollback).toEqual({
			endpointGeneration: null,
			fenced: true,
			runtimeRemoved: true,
			hostStopped: true,
			brokerRegistrationReleased: true,
		});
	} finally {
		names.forEach((name, index) => {
			const value = previous[index];
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		});
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("startup failure artifacts reject symlink and oversize collisions while accepting byte-identical owner evidence", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-lifecycle-artifact-"));
	const id = "artifact-session";
	const marker = "artifact-marker";
	const artifactPath = path.join(root, "sdk", `${id}.lifecycle.failure.${marker}.json`);
	const rollback = {
		endpointGeneration: 1,
		fenced: true,
		runtimeRemoved: true,
		hostStopped: true,
		brokerRegistrationReleased: true,
	};
	try {
		await writeSessionLifecycleFailure(
			root,
			id,
			marker,
			{ phase: "startup", reason: "failed", message: "owned startup failure" },
			rollback,
		);

		const original = await fs.readFile(artifactPath);
		await writeSessionLifecycleFailure(
			root,
			id,
			marker,
			{ phase: "startup", reason: "failed", message: "owned startup failure" },
			rollback,
		);

		expect(await fs.readFile(artifactPath)).toEqual(original);
		expect((await fs.stat(artifactPath)).mode & 0o777).toBe(0o600);

		await fs.rm(artifactPath);
		await fs.symlink(path.join(root, "missing"), artifactPath);
		await expect(
			writeSessionLifecycleFailure(
				root,
				id,
				marker,
				{ phase: "startup", reason: "failed", message: "owned startup failure" },
				rollback,
			),
		).rejects.toThrow();

		await fs.rm(artifactPath);
		await fs.writeFile(artifactPath, "x".repeat(4097));
		await expect(
			writeSessionLifecycleFailure(
				root,
				id,
				marker,
				{ phase: "startup", reason: "failed", message: "owned startup failure" },
				rollback,
			),
		).rejects.toThrow();
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("broker parses Darwin kernel process start timestamps with microsecond precision", () => {
	const bsdInfo = new Uint8Array(136);
	const view = new DataView(bsdInfo.buffer);
	view.setBigUint64(120, 1_700_000_000n, true);
	view.setBigUint64(128, 123_456n, true);
	const sameSecondSuccessor = new Uint8Array(bsdInfo);
	new DataView(sameSecondSuccessor.buffer).setBigUint64(128, 123_457n, true);
	expect(parseDarwinProcessIncarnation(bsdInfo)).toBe("darwin:1700000000:123456");
	expect(parseDarwinProcessIncarnation(sameSecondSuccessor)).toBe("darwin:1700000000:123457");
});
test("broker reads Windows process incarnations as canonical FILETIME ticks with 100ns continuity", () => {
	let invoked = false;
	const result = processIncarnation(4_242, {
		platform: "win32",
		runCommand(command, args) {
			invoked = true;
			expect(command).toBe("powershell.exe");
			expect(args).toEqual([
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"$ErrorActionPreference = 'Stop'; $OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $process = Get-Process -Id 4242 -ErrorAction Stop; $filetime = [UInt64]($process.StartTime.ToUniversalTime().ToFileTimeUtc()); [Console]::Out.WriteLine((\"{0}`t{1}\" -f $process.Id, $filetime))",
			]);
			return { exitCode: 0, stdout: "4242\t133830291061234567\r\n" };
		},
	});
	expect(invoked).toBe(true);
	expect(result).toBe("windows:133830291061234567");
	expect(
		processIncarnation(4_242, {
			platform: "win32",
			runCommand: () => ({ exitCode: 0, stdout: "4242\t133830291061234568\n" }),
		}),
	).toBe("windows:133830291061234568");
});

test("broker fails closed for failed or malformed Windows FILETIME process-incarnation output", () => {
	const options = {
		platform: "win32" as const,
		runCommand: () => ({ exitCode: 1, stdout: "4242\t133830291061234567\n" }),
	};
	expect(processIncarnation(4_242, options)).toBeUndefined();
	expect(
		processIncarnation(4_242, {
			platform: "win32",
			runCommand() {
				throw new Error("PowerShell unavailable");
			},
		}),
	).toBeUndefined();
	for (const stdout of [
		"",
		"4242\t-1\n",
		"4242\t0133830291061234567\n",
		"4242\t18446744073709551616\n",
		"4243\t133830291061234567\n",
		"4242\t133830291061234567\r",
		"4242\t133830291061234567\n\n",
	]) {
		expect(
			processIncarnation(4_242, {
				platform: "win32",
				runCommand: () => ({ exitCode: 0, stdout }),
			}),
		).toBeUndefined();
	}
});

test("broker bounds a hanging WebSocket upgrade by the lifecycle deadline and cleans its child", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-hanging-upgrade-"));
	const stateRoot = path.join(agentDir, ".gjc", "state");
	const fixture = path.join(agentDir, "hanging-upgrade.js");
	const fixturePidPath = path.join(agentDir, "hanging-upgrade.pid");
	const fixtureRequestPath = path.join(agentDir, "hanging-upgrade.request.json");
	const previousCommand = process.env.GJC_SDK_SESSION_COMMAND;
	const previousUrl = process.env.GJC_HANGING_UPGRADE_URL;
	const hangingUpgrade = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			return Promise.withResolvers<Response>().promise;
		},
	});
	const broker = new Broker({ agentDir });
	let fixturePid: number | undefined;
	try {
		await fs.writeFile(
			fixture,
			`
const fs=require('fs'), path=require('path'), crypto=require('crypto');
const root=process.env.GJC_STATE_ROOT, id=process.env.GJC_SESSION_ID, agent=process.env.GJC_AGENT_DIR;
fs.mkdirSync(path.join(root,'sdk'),{recursive:true});
fs.writeFileSync(${JSON.stringify(fixturePidPath)},String(process.pid));
fs.writeFileSync(${JSON.stringify(fixtureRequestPath)},process.env.GJC_SDK_LIFECYCLE_REQUEST);
const endpoint=path.join(root,'sdk',id+'.json');
fs.writeFileSync(endpoint,JSON.stringify({sessionId:id,pid:process.pid,url:process.env.GJC_HANGING_UPGRADE_URL,token:'hang'}));
const m=fs.statSync(endpoint).mtimeMs;
const log=path.join(agent,'sdk','sessions','index.jsonl');fs.mkdirSync(path.dirname(log),{recursive:true});const indexSeq=fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\\n').filter(Boolean).length+1:1;
const event={type:'host_registered',sessionId:id,locator:{repo:agent,stateRoot:root},endpointGeneration:1,pid:process.pid,endpointMtimeMs:m,version:1,indexSeq,ts:Date.now()};
event.checksum=crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex');fs.appendFileSync(log,JSON.stringify(event)+'\\n');
setInterval(()=>{},1000);
`,
		);
		process.env.GJC_SDK_SESSION_COMMAND = `${process.execPath} ${fixture}`;
		process.env.GJC_HANGING_UPGRADE_URL = `ws://127.0.0.1:${hangingUpgrade.port}`;
		await broker.start();
		const started = Date.now();
		const lifecycle = broker.handleRequest(
			"session.create",
			{ cwd: agentDir, stateRoot, readinessTimeoutMs: 4_000 },
			"hanging-upgrade",
		);
		const request = await waitFor(async () => {
			try {
				return JSON.parse(await fs.readFile(fixtureRequestPath, "utf8")) as {
					effectMarker?: string;
					sessionId?: string;
				};
			} catch {
				return undefined;
			}
		}, "hanging-upgrade lifecycle request");
		fixturePid = Number(await fs.readFile(fixturePidPath, "utf8"));
		const incarnation = processIncarnation(fixturePid);
		if (!incarnation || !request.effectMarker || !request.sessionId)
			throw new Error("Expected a durable lifecycle child identity.");
		await fs.writeFile(
			path.join(stateRoot, "sdk", `${request.sessionId}.lifecycle.ready.json`),
			JSON.stringify({ pid: fixturePid, effectMarker: request.effectMarker, incarnation }),
		);
		expect(await lifecycle).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(() => process.kill(fixturePid!, 0)).toThrow();
	} finally {
		if (fixturePid) {
			try {
				process.kill(fixturePid, "SIGKILL");
			} catch {}
		}
		if (previousCommand === undefined) delete process.env.GJC_SDK_SESSION_COMMAND;
		else process.env.GJC_SDK_SESSION_COMMAND = previousCommand;
		if (previousUrl === undefined) delete process.env.GJC_HANGING_UPGRADE_URL;
		else process.env.GJC_HANGING_UPGRADE_URL = previousUrl;
		hangingUpgrade.stop(true);
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}, 10_000);

test("broker rejects an endpoint-only lifecycle child that never authenticates session_ready", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-life-"));
	const stateRoot = path.join(agentDir, ".gjc", "state");
	const fixture = path.join(agentDir, "fixture.js");
	await fs.writeFile(
		fixture,
		`
const fs=require('fs'), path=require('path'), crypto=require('crypto');
const root=process.env.GJC_STATE_ROOT, id=process.env.GJC_SESSION_ID, agent=process.env.GJC_AGENT_DIR;
fs.mkdirSync(path.join(root,'sdk'),{recursive:true});
fs.writeFileSync(path.join(agent,'fixture.pid'),String(process.pid));
fs.writeFileSync(path.join(agent,'fixture.request.json'),process.env.GJC_SDK_LIFECYCLE_REQUEST);

fs.writeFileSync(path.join(root,'sdk',id+'.json'),JSON.stringify({sessionId:id,pid:process.pid,url:'ws://127.0.0.1:1',token:'fake'}));
const m=fs.statSync(path.join(root,'sdk',id+'.json')).mtimeMs;
const log=path.join(agent,'sdk','sessions','index.jsonl');fs.mkdirSync(path.dirname(log),{recursive:true});const indexSeq=fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\\n').filter(Boolean).length+1:1;
const event={type:'host_registered',sessionId:id,locator:{repo:'fixture',stateRoot:root},endpointGeneration:1,pid:process.pid,endpointMtimeMs:m,version:1,indexSeq,ts:Date.now()};
event.checksum=crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex');fs.appendFileSync(log,JSON.stringify(event)+'\\n');
setInterval(()=>{},1000);
`,
	);
	const previous = process.env.GJC_SDK_SESSION_COMMAND;
	process.env.GJC_SDK_SESSION_COMMAND = `${process.execPath} ${fixture}`;
	const broker = new Broker({ agentDir });
	await broker.start();
	try {
		const started = Date.now();
		const [first, second] = await Promise.all([
			broker.handleRequest(
				"session.create",
				{ stateRoot, cwd: agentDir, readinessTimeoutMs: 4_000, body: "first", modelPreset: "codex-eco" },
				"create-1",
			),
			broker.handleRequest(
				"session.create",
				{ stateRoot, cwd: agentDir, readinessTimeoutMs: 4_000, body: "second", modelPreset: "codex-eco" },
				"create-2",
			),
		]);
		expect(first).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
		expect(second).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
		expect(Date.now() - started).toBeGreaterThanOrEqual(500);
		const fixturePid = Number(await fs.readFile(path.join(agentDir, "fixture.pid"), "utf8"));
		expect(() => process.kill(fixturePid, 0)).toThrow();
		expect(JSON.parse(await fs.readFile(path.join(agentDir, "fixture.request.json"), "utf8"))).toMatchObject({
			cwd: agentDir,
			modelPreset: "codex-eco",
		});
		expect(
			(await fs.readdir(path.join(stateRoot, "sdk"))).filter(name => name.endsWith(".json")).length,
		).toBeGreaterThan(0);
		const listed = await broker.handleRequest("session.list", {});
		expect(listed.ok).toBe(true);
		if (!listed.ok) throw new Error(listed.error.message);
		expect(JSON.stringify(listed.result)).toContain('"terminalUncertain":true');
	} finally {
		await broker.stop();
		process.env.GJC_SDK_SESSION_COMMAND = previous;
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}, 15_000);

test("broker rejects a cross-workspace cold fork source before spawning", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-cross-workspace-"));
	const agentDir = path.join(root, "agent");
	const sourceCwd = path.join(root, "source");
	const targetCwd = path.join(root, "target");
	const fixture = path.join(root, "spawned.js");
	const spawnedPath = path.join(root, "spawned");
	const previousCommand = process.env.GJC_SDK_SESSION_COMMAND;
	const broker = new Broker({ agentDir });
	try {
		await fs.mkdir(sourceCwd, { recursive: true });
		await fs.mkdir(targetCwd, { recursive: true });
		const source = SessionManager.create(sourceCwd, SessionManager.getDefaultSessionDir(sourceCwd, agentDir));
		await source.ensureOnDisk();
		const sourcePath = source.getSessionFile();
		if (!sourcePath) throw new Error("Expected source session path.");
		await fs.writeFile(
			fixture,
			`require("fs").writeFileSync(${JSON.stringify(spawnedPath)}, "spawned"); setInterval(() => {}, 1000);`,
		);
		process.env.GJC_SDK_SESSION_COMMAND = `${process.execPath} ${fixture}`;
		await broker.start();
		expect(
			await broker.handleRequest(
				"session.fork",
				{
					cwd: targetCwd,
					stateRoot: path.join(targetCwd, ".gjc", "state"),
					sourceSessionId: source.getSessionId(),
					sourceSessionPath: sourcePath,
				},
				"cross-workspace-fork",
			),
		).toEqual({
			ok: false,
			error: {
				code: "invalid_input",
				message: "Source saved session does not match the requested workspace and session id.",
			},
		});
		await expect(fs.stat(spawnedPath)).rejects.toThrow();
	} finally {
		if (previousCommand === undefined) delete process.env.GJC_SDK_SESSION_COMMAND;
		else process.env.GJC_SDK_SESSION_COMMAND = previousCommand;
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("broker terminalizes default command resolver failures", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-resolver-failure-"));
	const agentDir = path.join(root, "agent");
	const previousCommand = process.env.GJC_SDK_SESSION_COMMAND;
	const broker = new Broker({ agentDir });
	try {
		delete process.env.GJC_SDK_SESSION_COMMAND;
		setLifecycleCommandResolverForTest(broker, () => {
			throw new Error("SDK internal launch refused: compiled-runtime marker evidence is inconsistent.");
		});
		await broker.start();
		const requestId = "resolver-failure-terminal-receipt";
		const response = await broker.handleRequest(
			"session.create",
			{ cwd: root, stateRoot: path.join(root, ".gjc", "state") },
			requestId,
		);
		expect(response).toEqual({
			ok: false,
			error: {
				code: "spawn_failed",
				message:
					"Unable to spawn session: SDK internal launch refused: compiled-runtime marker evidence is inconsistent.",
			},
		});
		expect(
			await broker.handleRequest(
				"session.create",
				{ cwd: root, stateRoot: path.join(root, ".gjc", "state") },
				requestId,
			),
		).toEqual(response);
		const terminal = (await fs.readFile(path.join(agentDir, "sdk", "lifecycle-ledger.jsonl"), "utf8"))
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as Record<string, unknown>)
			.findLast(row => row.state === "terminal_error");
		expect(terminal?.response).toEqual(response);
	} finally {
		setLifecycleCommandResolverForTest(broker, undefined);
		if (previousCommand === undefined) delete process.env.GJC_SDK_SESSION_COMMAND;
		else process.env.GJC_SDK_SESSION_COMMAND = previousCommand;
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("broker rejects invalid and oversized readiness timeouts before spawning", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-timeout-"));
	const fixture = path.join(agentDir, "spawned.js");
	const spawnedPath = path.join(agentDir, "spawned");
	const previousCommand = process.env.GJC_SDK_SESSION_COMMAND;
	const broker = new Broker({ agentDir });
	try {
		await fs.writeFile(
			fixture,
			`require("fs").writeFileSync(${JSON.stringify(spawnedPath)}, "spawned"); setInterval(() => {}, 1000);`,
		);
		process.env.GJC_SDK_SESSION_COMMAND = `${process.execPath} ${fixture}`;
		await broker.start();
		for (const readinessTimeoutMs of [0, 60_001]) {
			expect(
				await broker.handleRequest(
					"session.create",
					{ cwd: agentDir, readinessTimeoutMs },
					`invalid-timeout-${readinessTimeoutMs}`,
				),
			).toEqual({
				ok: false,
				error: {
					code: "invalid_input",
					message: "readinessTimeoutMs must be an integer between 4000 and 60000.",
				},
			});
		}
		await expect(fs.stat(spawnedPath)).rejects.toThrow();
	} finally {
		if (previousCommand === undefined) delete process.env.GJC_SDK_SESSION_COMMAND;
		else process.env.GJC_SDK_SESSION_COMMAND = previousCommand;
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("broker propagates an owned lifecycle startup failure without semantic readiness or endpoint survivors", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-child-exit-"));
	const fixture = path.join(agentDir, "exit.js");
	const sessionIdPath = path.join(agentDir, "session-id");
	const previousCommand = process.env.GJC_SDK_SESSION_COMMAND;
	const broker = new Broker({ agentDir });
	try {
		await fs.writeFile(
			fixture,
			`require('fs').writeFileSync(${JSON.stringify(sessionIdPath)}, process.env.GJC_SESSION_ID); setTimeout(() => process.exit(0), 100);`,
		);
		process.env.GJC_SDK_SESSION_COMMAND = `${process.execPath} ${fixture}`;
		await broker.start();
		const started = Date.now();
		const response = await broker.handleRequest(
			"session.create",
			{ cwd: agentDir, readinessTimeoutMs: 4_000 },
			"child-exits",
		);
		expect(response).toMatchObject({ ok: false, error: { code: "terminal_uncertain", message: expect.any(String) } });
		expect(response).not.toMatchObject({ error: { code: "readiness_timeout" } });
		expect(Date.now() - started).toBeLessThan(1_000);
		const sessionId = await fs.readFile(sessionIdPath, "utf8");
		await expect(
			fs.stat(path.join(agentDir, ".gjc", "state", "sdk", `${sessionId}.lifecycle.ready.json`)),
		).rejects.toThrow();
		await expect(fs.stat(path.join(agentDir, ".gjc", "state", "sdk", `${sessionId}.json`))).rejects.toThrow();
		expect(await broker.handleRequest("session.list", {})).toMatchObject({
			ok: true,
			result: { sessions: [{ sessionId, terminalUncertain: true }] },
		});
	} finally {
		if (previousCommand === undefined) delete process.env.GJC_SDK_SESSION_COMMAND;
		else process.env.GJC_SDK_SESSION_COMMAND = previousCommand;
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("broker replays immutable lifecycle cleanup after a crash immediately after an exact detach", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-ledger-crash-"));
	const agentDir = path.join(root, "agent");
	const fixture = path.join(root, "owned-startup-failure.ts");
	const previousCommand = process.env.GJC_SDK_SESSION_COMMAND;
	let crashing: Broker | undefined;
	let reopened: Broker | undefined;
	let normal: Broker | undefined;
	try {
		await fs.writeFile(
			fixture,
			`import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionIndex } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/sdk/broker/session-index.ts"))};
import { writeSessionLifecycleFailure } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/sdk/broker/lifecycle.ts"))};
const request = JSON.parse(process.env.GJC_SDK_LIFECYCLE_REQUEST!);
const endpoint = path.join(request.stateRoot, "sdk", request.sessionId + ".json");
await fs.mkdir(path.dirname(endpoint), { recursive: true, mode: 0o700 });
await fs.writeFile(endpoint, JSON.stringify({ sessionId: request.sessionId, pid: process.pid, url: "ws://127.0.0.1:1", token: "owned-startup-failure" }), { mode: 0o600 });
const index = await new SessionIndex(process.env.GJC_AGENT_DIR!).open();
const endpointGeneration = 1;
await index.append({ type: "host_registered", sessionId: request.sessionId, locator: { repo: request.cwd, stateRoot: request.stateRoot }, endpointGeneration, pid: process.pid, endpointMtimeMs: (await fs.stat(endpoint)).mtimeMs, lifecycleRequestId: request.effectMarker });
const source = await fs.readFile(request.sessionPath);
const stat = await fs.stat(request.sessionPath, { bigint: true });
await writeSessionLifecycleFailure(request.stateRoot, request.sessionId, request.effectMarker, { phase: "startup", reason: "failed", message: "owned synthetic startup failure" }, { endpointGeneration, fenced: true, runtimeRemoved: true, hostStopped: true, brokerRegistrationReleased: true }, { digest: createHash("sha256").update(source).digest("hex"), identity: { dev: stat.dev.toString(), ino: stat.ino.toString(), size: Number(stat.size), mtimeMs: Number(stat.mtimeMs), mtimeNs: stat.mtimeNs.toString(), sha256: createHash("sha256").update(source).digest("hex") } });

await index.append({ type: "host_unregistered", sessionId: request.sessionId, locator: { repo: request.cwd, stateRoot: request.stateRoot }, endpointGeneration, pid: process.pid, lifecycleRequestId: request.effectMarker });
await fs.rm(endpoint);
`,
		);
		process.env.GJC_SDK_SESSION_COMMAND = `${process.execPath} ${fixture}`;
		const saved = SessionManager.create(root, SessionManager.getDefaultSessionDir(root, agentDir));
		await saved.ensureOnDisk();
		const sessionId = saved.getSessionId();
		const sessionPath = saved.getSessionFile();
		if (!sessionPath) throw new Error("Expected persisted resume transcript.");
		await saved.close();
		const request = { cwd: root, sessionId, sessionPath };

		crashing = new Broker({ agentDir });
		await crashing.start();
		setLifecycleCleanupHookForTest(crashing, () => {
			throw new Error("simulated crash after lifecycle exact detach");
		});
		await expect(crashing.handleRequest("session.resume", request, "post-fsync-crash")).rejects.toThrow(
			"simulated crash after lifecycle exact detach",
		);
		const crashRows = (await fs.readFile(path.join(agentDir, "sdk", "lifecycle-ledger.jsonl"), "utf8"))
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as Record<string, unknown>);
		const persisted = crashRows.findLast(row => row.state === "effect_started");
		if (!persisted?.response || typeof persisted.effectMarker !== "string")
			throw new Error("Expected persisted lifecycle cleanup intent.");
		const persistedResponse = persisted.response as BrokerResponse;
		expect(persistedResponse).toMatchObject({
			ok: false,
			error: {
				code: "cleanup_pending",
				cleanup: {
					phase: "lifecycle",
					lifecycleFiles: expect.arrayContaining([
						expect.objectContaining({
							path: expect.stringContaining(`${sessionId}.lifecycle.failure.`),
							identity: expect.objectContaining({ sha256: expect.any(String) }),
							plannedPath: expect.stringContaining(".gjc-delete-"),
						}),
					]),
				},
			},
		});
		const stateRoot = path.join(root, ".gjc", "state", "sdk");
		const artifact = path.join(stateRoot, `${sessionId}.lifecycle.failure.${persisted.effectMarker}.json`);
		const marker = path.join(stateRoot, `${sessionId}.lifecycle.json`);
		await expect(fs.stat(artifact)).rejects.toThrow();
		await expect(fs.stat(marker)).resolves.toBeDefined();

		await crashing.stop();
		crashing = undefined;
		reopened = new Broker({ agentDir });
		await reopened.start();
		setLifecycleCleanupHookForTest(reopened, () => {
			throw new Error("simulated repeated lifecycle cleanup failure");
		});
		await expect(reopened.handleRequest("session.resume", request, "post-fsync-crash")).rejects.toThrow(
			"simulated repeated lifecycle cleanup failure",
		);
		await reopened.stop();
		reopened = new Broker({ agentDir });
		await reopened.start();
		const replayed = await reopened.handleRequest("session.resume", request, "post-fsync-crash");
		expect(replayed).toMatchObject({ ok: false, error: { code: "spawn_failed" } });
		await expect(fs.stat(artifact)).rejects.toThrow();
		await expect(fs.stat(marker)).rejects.toThrow();
		await reopened.stop();
		reopened = undefined;

		const normalRoot = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-ledger-normal-"));
		const normalAgentDir = path.join(normalRoot, "agent");
		const normalSaved = SessionManager.create(
			normalRoot,
			SessionManager.getDefaultSessionDir(normalRoot, normalAgentDir),
		);
		try {
			await normalSaved.ensureOnDisk();
			const normalSessionPath = normalSaved.getSessionFile();
			if (!normalSessionPath) throw new Error("Expected persisted normal resume transcript.");
			const normalSessionId = normalSaved.getSessionId();
			await normalSaved.close();
			await fs.copyFile(fixture, path.join(normalRoot, "owned-startup-failure.ts"));
			process.env.GJC_SDK_SESSION_COMMAND = `${process.execPath} ${path.join(normalRoot, "owned-startup-failure.ts")}`;
			normal = new Broker({ agentDir: normalAgentDir });
			await normal.start();
			const normalResponse = await normal.handleRequest(
				"session.resume",
				{ cwd: normalRoot, sessionId: normalSessionId, sessionPath: normalSessionPath },
				"normal-after-verification",
			);
			expect(normalResponse).toMatchObject({ ok: false, error: { code: "spawn_failed" } });
			const normalTerminal = (await fs.readFile(path.join(normalAgentDir, "sdk", "lifecycle-ledger.jsonl"), "utf8"))
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line) as Record<string, unknown>)
				.findLast(row => row.state === "terminal_error");
			if (!normalTerminal || typeof normalTerminal.effectMarker !== "string")
				throw new Error("Expected normal terminal lifecycle record.");
			expect(normalTerminal.response).toEqual(normalResponse);
			expect(normalTerminal.responseDigest).toBe(
				createHash("sha256").update(canonicalJson(normalResponse)).digest("hex"),
			);
			await expect(
				fs.stat(
					path.join(
						normalRoot,
						".gjc",
						"state",
						"sdk",
						`${normalSessionId}.lifecycle.failure.${normalTerminal.effectMarker}.json`,
					),
				),
			).rejects.toThrow();
			await expect(
				fs.stat(path.join(normalRoot, ".gjc", "state", "sdk", `${normalSessionId}.lifecycle.json`)),
			).rejects.toThrow();
			expect({
				crashAfterDetachRecovered: await Promise.all([
					fs.stat(artifact).then(
						() => false,
						() => true,
					),
					fs.stat(marker).then(
						() => false,
						() => true,
					),
				]).then(values => values.every(Boolean)),
				normalPathEvidenceCleaned: await Promise.all([
					fs.stat(
						path.join(
							normalRoot,
							".gjc",
							"state",
							"sdk",
							`${normalSessionId}.lifecycle.failure.${normalTerminal.effectMarker}.json`,
						),
					),
					fs.stat(path.join(normalRoot, ".gjc", "state", "sdk", `${normalSessionId}.lifecycle.json`)),
				]).then(
					() => false,
					() => true,
				),
			}).toEqual({ crashAfterDetachRecovered: true, normalPathEvidenceCleaned: true });
		} finally {
			await normal?.stop();
			await normalSaved.close();
			await fs.rm(normalRoot, { recursive: true, force: true });
		}
	} finally {
		if (previousCommand === undefined) delete process.env.GJC_SDK_SESSION_COMMAND;
		else process.env.GJC_SDK_SESSION_COMMAND = previousCommand;
		await reopened?.stop();
		await crashing?.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);

test("session index rejects a stale unregister from an earlier matching PID-generation registration", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-session-index-unregister-"));
	const index = await new SessionIndex(agentDir).open();
	const shared = {
		sessionId: "reused-registration",
		locator: { repo: "fixture", stateRoot: path.join(agentDir, "state") },
		endpointGeneration: 5,
		pid: process.pid,
		lifecycleRequestId: "same-marker",
	};
	try {
		const first = await index.append({ type: "host_registered", ...shared });
		await index.append({ type: "host_unregistered", ...shared });
		const replacement = await index.append({ type: "host_registered", ...shared });
		expect(index.hostUnregisteredAfter(first)).toMatchObject({
			lifecycleRequestId: "same-marker",
		});
		expect(index.hostUnregisteredAfter(replacement)).toBeUndefined();
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});
test("session index proves ordinary host unregistration using a newer matching registration sequence", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-session-index-ordinary-close-"));
	const index = await new SessionIndex(agentDir).open();
	const shared = {
		sessionId: "ordinary-host",
		locator: { repo: "fixture", stateRoot: path.join(agentDir, "state") },
		endpointGeneration: 6,
		pid: process.pid,
	};
	try {
		const registration = await index.append({ type: "host_registered", ...shared });
		await index.append({ type: "host_unregistered", ...shared });
		expect(index.hostUnregisteredAfter(registration)).toEqual({ indexSeq: registration.indexSeq + 1 });
		const replacement = await index.append({ type: "host_registered", ...shared });
		expect(index.hostUnregisteredAfter(replacement)).toBeUndefined();
	} finally {
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("broker records the resolved worktree state root and preserves pre-child preparation failures", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-lifecycle-worktree-prechild-"));
	const repo = path.join(root, "repo");
	const agentDir = path.join(root, "agent");
	const worktreeName = "conflict";
	let worktreeRoot = "";
	const broker = new Broker({ agentDir });
	try {
		await fs.mkdir(repo, { recursive: true });
		for (const args of [
			["init"],
			["config", "user.email", "lifecycle@example.test"],
			["config", "user.name", "Lifecycle Test"],
		]) {
			const result = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
			if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		}
		await fs.writeFile(path.join(repo, "README"), "fixture\n");
		const committed = Bun.spawnSync(["git", "add", "README"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
		if (committed.exitCode !== 0) throw new Error(committed.stderr.toString());
		const commit = Bun.spawnSync(["git", "commit", "-m", "fixture"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
		if (commit.exitCode !== 0) throw new Error(commit.stderr.toString());
		const plannedWorktree = planLaunchWorktree(repo, { enabled: true, detached: false, name: worktreeName });
		if (!plannedWorktree.enabled) throw new Error("Expected enabled worktree plan");
		worktreeRoot = plannedWorktree.worktreePath;
		await fs.mkdir(worktreeRoot, { recursive: true });
		await fs.writeFile(path.join(worktreeRoot, "occupied"), "conflict\n");
		await broker.start();

		const response = await broker.handleRequest(
			"session.create",
			{
				cwd: repo,
				stateRoot: path.join(repo, ".gjc", "state"),
				target: { worktree: { enabled: true, name: worktreeName } },
			},
			"pre-child-worktree-conflict",
		);
		expect(response).toMatchObject({
			ok: false,
			error: { code: "spawn_failed", message: expect.stringContaining("worktree_path_conflict") },
		});
		const rows = (await fs.readFile(path.join(agentDir, "sdk", "lifecycle-ledger.jsonl"), "utf8"))
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as Record<string, unknown>);
		const terminal = rows.findLast(row => row.state === "terminal_error");
		expect(terminal).toMatchObject({
			response,
			effectIntent: {
				stateRoot: path.join(worktreeRoot, ".gjc", "state"),
				childOwnershipEstablished: false,
			},
		});
	} finally {
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);
test("broker fails closed when the reopened terminal ledger cannot reproduce its response", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-ledger-mismatch-"));
	const broker = new Broker({ agentDir });
	const originalOpen = LifecycleLedger.prototype.open;
	try {
		await broker.start();
		LifecycleLedger.prototype.open = async () => ({ get: () => undefined }) as unknown as LifecycleLedger;
		const response = await broker.handleRequest("session.unknown", {}, "ledger-mismatch");
		expect(response).toEqual({
			ok: false,
			error: {
				code: "terminal_uncertain",
				message:
					"Lifecycle terminal evidence could not be verified after persistence; retained artifacts require reconciliation.",
			},
		});
	} finally {
		LifecycleLedger.prototype.open = originalOpen;
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("broker rejects a ready foreign host for the spawned session id", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-foreign-ready-"));
	const stateRoot = path.join(agentDir, ".gjc", "state");
	const fixture = path.join(agentDir, "foreign.js");
	const foreignIdPath = path.join(agentDir, "foreign-session-id");
	const previousCommand = process.env.GJC_SDK_SESSION_COMMAND;
	const previousEndpoint = process.env.GJC_FOREIGN_ENDPOINT_URL;
	let replayRequests = 0;
	const foreign = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			if (server.upgrade(request)) return;
			return new Response("WebSocket required", { status: 426 });
		},
		websocket: {
			open(socket) {
				socket.send(JSON.stringify({ type: "hello", connectionId: "foreign" }));
			},
			message(socket, message) {
				const frame = JSON.parse(String(message)) as { id?: string; type?: string };
				if (frame.type !== "event_replay" || !frame.id) return;
				replayRequests++;
				void fs.readFile(foreignIdPath, "utf8").then(sessionId =>
					socket.send(
						JSON.stringify({
							type: "event_replay_result",
							id: frame.id,
							ok: true,
							events: [{ type: "event", name: "session_ready", sessionId, generation: 1 }],
						}),
					),
				);
			},
		},
	});
	const broker = new Broker({ agentDir });
	try {
		await fs.writeFile(
			fixture,
			`
const fs=require('fs'), path=require('path'), crypto=require('crypto');
const root=process.env.GJC_STATE_ROOT, id=process.env.GJC_SESSION_ID, agent=process.env.GJC_AGENT_DIR;
fs.mkdirSync(path.join(root,'sdk'),{recursive:true});
fs.writeFileSync(path.join(agent,'foreign-session-id'),id);
const endpoint=path.join(root,'sdk',id+'.json');
fs.writeFileSync(endpoint,JSON.stringify({sessionId:id,pid:process.ppid,url:process.env.GJC_FOREIGN_ENDPOINT_URL,token:'foreign'}));
const m=fs.statSync(endpoint).mtimeMs;
const log=path.join(agent,'sdk','sessions','index.jsonl');fs.mkdirSync(path.dirname(log),{recursive:true});const indexSeq=fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\\n').filter(Boolean).length+1:1;
const event={type:'host_registered',sessionId:id,locator:{repo:'foreign',stateRoot:root},endpointGeneration:1,pid:process.ppid,endpointMtimeMs:m,version:1,indexSeq,ts:Date.now()};
event.checksum=crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex');fs.appendFileSync(log,JSON.stringify(event)+'\\n');
setInterval(()=>{},1000);
`,
		);
		process.env.GJC_SDK_SESSION_COMMAND = `${process.execPath} ${fixture}`;
		process.env.GJC_FOREIGN_ENDPOINT_URL = `ws://127.0.0.1:${foreign.port}`;
		await broker.start();
		expect(
			await broker.handleRequest(
				"session.create",
				{ cwd: agentDir, stateRoot, readinessTimeoutMs: 4_000 },
				"foreign-ready",
			),
		).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
		expect((await fs.readFile(foreignIdPath, "utf8")).length).toBeGreaterThan(0);
		expect(replayRequests).toBe(0);
	} finally {
		if (previousCommand === undefined) delete process.env.GJC_SDK_SESSION_COMMAND;
		else process.env.GJC_SDK_SESSION_COMMAND = previousCommand;
		if (previousEndpoint === undefined) delete process.env.GJC_FOREIGN_ENDPOINT_URL;
		else process.env.GJC_FOREIGN_ENDPOINT_URL = previousEndpoint;
		foreign.stop(true);
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("broker refuses a stale registered PID when no durable effect marker proves ownership", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-stale-"));
	const stateRoot = path.join(agentDir, "state");
	const broker = new Broker({ agentDir });
	try {
		await broker.start();
		await broker.index.append({
			type: "host_registered",
			sessionId: "stale",
			locator: { repo: "fixture", stateRoot },
			endpointGeneration: 1,
			pid: process.pid,
		});
		expect(await broker.handleRequest("session.close", { sessionId: "stale" }, "stale-close")).toEqual({
			ok: false,
			error: {
				code: "close_refused",
				message: "Session endpoint is unavailable and its durable process identity could not be verified.",
			},
		});
		expect(process.pid).toBeGreaterThan(0);
	} finally {
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("broker refuses same-generation close authority from a prior endpoint incarnation", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-close-incarnation-"));
	const stateRoot = path.join(agentDir, "state");
	const sessionId = "successor";
	const endpoint = path.join(stateRoot, "sdk", `${sessionId}.json`);
	const broker = new Broker({ agentDir });
	try {
		await broker.start();
		await fs.mkdir(path.dirname(endpoint), { recursive: true });
		await fs.writeFile(
			endpoint,
			JSON.stringify({ sessionId, pid: process.pid, url: "ws://127.0.0.1:1", token: "successor-token" }),
		);
		const endpointMtimeMs = (await fs.stat(endpoint)).mtimeMs;
		await broker.index.append({
			type: "host_registered",
			sessionId,
			locator: { repo: "fixture", stateRoot },
			endpointGeneration: 1,
			pid: process.pid,
			endpointMtimeMs,
		});
		const staleEndpointIncarnation = createHash("sha256")
			.update(
				JSON.stringify({
					endpointGeneration: 1,
					endpointMtimeMs: endpointMtimeMs - 1,
					pid: process.pid,
					sessionId,
				}),
			)
			.digest("hex");
		expect(
			await broker.handleRequest(
				"session.close",
				{ sessionId, endpointGeneration: 1, endpointIncarnation: staleEndpointIncarnation },
				"stale-incarnation-close",
			),
		).toEqual({ ok: false, error: { code: "endpoint_stale", message: "session endpoint is stale" } });
		expect(await fs.readFile(endpoint, "utf8")).toContain("successor-token");
	} finally {
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("broker rebinds implicit close only for a matching non-empty lifecycle request id", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-close-rebind-"));
	const stateRoot = path.join(agentDir, "state");
	const broker = new Broker({ agentDir });
	const originalHandleRequest = broker.handleRequest.bind(broker);
	try {
		await broker.start();
		for (const [label, initialRequestId, replacementRequestId, expectedCode] of [
			["same", "request-a", "request-a", "close_refused"],
			["absent", undefined, undefined, "endpoint_stale"],
			["different", "request-a", "request-b", "endpoint_stale"],
		] as const) {
			const sessionId = `close-rebind-${label}`;
			const locator = { repo: "fixture", stateRoot };
			await broker.index.append({
				type: "host_registered",
				sessionId,
				locator,
				endpointGeneration: 1,
				pid: process.pid,
				endpointMtimeMs: 1,
				...(initialRequestId ? { lifecycleRequestId: initialRequestId } : {}),
			});
			await broker.index.append({
				type: "host_heartbeat",
				sessionId,
				locator,
				endpointGeneration: 1,
				pid: process.pid,
			});
			let injected = false;
			broker.handleRequest = async (operation, input, idempotencyKey) => {
				if (operation === "session.get_endpoint" && input.sessionId === sessionId) {
					if (!injected) {
						injected = true;
						await broker.index.append({
							type: "host_registered",
							sessionId,
							locator,
							endpointGeneration: 2,
							pid: process.pid,
							endpointMtimeMs: 2,
							...(replacementRequestId ? { lifecycleRequestId: replacementRequestId } : {}),
						});
						return { ok: false, error: { code: "endpoint_stale", message: "session endpoint is stale" } };
					}
					return { ok: false, error: { code: "resource_gone", message: "session endpoint record is gone" } };
				}
				return originalHandleRequest(operation, input, idempotencyKey);
			};
			const result = await broker.handleRequest("session.close", { sessionId }, `close-rebind-${label}`);
			expect(injected).toBe(true);
			expect(result).toMatchObject({ ok: false, error: { code: expectedCode } });
		}
	} finally {
		broker.handleRequest = originalHandleRequest;
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});
test("broker atomically reuses the indexed live owner for distinct resume keys", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-resume-live-"));
	const agentDir = path.join(root, "agent");
	const stateRoot = path.join(root, ".gjc", "state");
	const savedSession = SessionManager.create(root, SessionManager.getDefaultSessionDir(root, agentDir));
	await savedSession.ensureOnDisk();
	const sessionId = savedSession.getSessionId();
	const sessionPath = savedSession.getSessionFile();
	if (!sessionPath) throw new Error("Expected saved session path.");
	const endpointPath = path.join(stateRoot, "sdk", `${sessionId}.json`);
	const broker = new Broker({ agentDir });
	try {
		await broker.start();
		await fs.mkdir(path.dirname(endpointPath), { recursive: true });
		await fs.writeFile(
			endpointPath,
			JSON.stringify({ sessionId, pid: process.pid, url: "ws://127.0.0.1:1", token: "live-owner-token" }),
		);
		await broker.index.append({
			type: "host_registered",
			sessionId,
			locator: { repo: root, stateRoot },
			endpointGeneration: 17,
			pid: process.pid,
			endpointMtimeMs: (await fs.stat(endpointPath)).mtimeMs,
		});

		const [first, second] = await Promise.all([
			broker.handleRequest("session.resume", { sessionId, sessionPath, cwd: root }, "resume-first"),
			broker.handleRequest("session.resume", { sessionId, sessionPath, cwd: root }, "resume-second"),
		]);

		for (const resumed of [first, second]) {
			expect(resumed).toMatchObject({
				ok: true,
				result: {
					sessionId,
					endpointGeneration: 17,
					reused: true,
					endpoint: { token: "live-owner-token" },
				},
			});
		}
		expect(await broker.handleRequest("session.list", {})).toMatchObject({
			ok: true,
			result: { sessions: [expect.objectContaining({ sessionId, endpointGeneration: 17 })] },
		});
	} finally {
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
});
test("broker never signals a PID reused after its lifecycle marker was written", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-reused-"));
	const stateRoot = path.join(agentDir, "state");
	const sessionId = "reused";
	const endpoint = path.join(stateRoot, "sdk", `${sessionId}.json`);
	const marker = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`);
	const broker = new Broker({ agentDir });
	try {
		await broker.start();
		await fs.mkdir(path.dirname(endpoint), { recursive: true });
		await fs.writeFile(
			endpoint,
			JSON.stringify({ sessionId, pid: process.pid, url: "ws://127.0.0.1:1", token: "stale" }),
		);
		await fs.writeFile(
			marker,
			JSON.stringify({ pid: process.pid, effectMarker: "old-effect", incarnation: "reused-process-incarnation" }),
		);
		await broker.index.append({
			type: "host_registered",
			sessionId,
			locator: { repo: "fixture", stateRoot },
			endpointGeneration: 7,
			pid: process.pid,
			endpointMtimeMs: (await fs.stat(endpoint)).mtimeMs,
		});
		expect(await broker.handleRequest("session.close", { sessionId }, "reused-close")).toEqual({
			ok: false,
			error: {
				code: "close_refused",
				message: "Session endpoint is unavailable and its durable process identity could not be verified.",
			},
		});
		expect(await fs.readFile(endpoint, "utf8")).toContain("stale");
		expect(await fs.readFile(marker, "utf8")).toContain("reused-process-incarnation");
	} finally {
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});
test("broker records terminal uncertainty when SIGKILL re-verification fails after SIGTERM", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-uncertain-"));
	const stateRoot = path.join(agentDir, "state");
	const sessionId = "unkillable";
	const endpoint = path.join(stateRoot, "sdk", `${sessionId}.json`);
	const marker = path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`);
	const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
		stdout: "ignore",
		stderr: "ignore",
	});
	const originalKill = process.kill;
	const broker = new Broker({ agentDir });
	try {
		if (!child.pid) throw new Error("fixture child has no pid");
		await broker.start();
		await fs.mkdir(path.dirname(endpoint), { recursive: true });
		await fs.writeFile(
			endpoint,
			JSON.stringify({ sessionId, pid: child.pid, url: "ws://127.0.0.1:1", token: "unreachable" }),
		);
		await fs.writeFile(
			marker,
			JSON.stringify({ pid: child.pid, effectMarker: "fixture", incarnation: await incarnation(child.pid) }),
		);
		await broker.index.append({
			type: "host_registered",
			sessionId,
			locator: { repo: "fixture", stateRoot },
			endpointGeneration: 9,
			pid: child.pid,
			endpointMtimeMs: (await fs.stat(endpoint)).mtimeMs,
		});
		process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
			if (signal === "SIGTERM")
				writeFileSync(marker, JSON.stringify({ pid: child.pid, effectMarker: "fixture", incarnation: "replaced" }));
			return signal === 0 || signal === undefined ? originalKill(pid, signal) : undefined;
		}) as typeof process.kill;
		expect(await broker.handleRequest("session.close", { sessionId }, "unkillable-close")).toMatchObject({
			ok: false,
			error: { code: "terminal_uncertain" },
		});
		expect(await fs.readFile(endpoint, "utf8")).toContain("unreachable");
		expect(await fs.readFile(marker, "utf8")).toContain('"fixture"');
		expect(await broker.handleRequest("session.list", {})).toMatchObject({
			ok: true,
			result: { sessions: [expect.objectContaining({ sessionId, terminalUncertain: true })] },
		});
	} finally {
		process.kill = originalKill;
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
}, 10_000);

if (process.platform === "darwin") {
	test("broker records terminal uncertainty when a spawned child incarnation is unreadable", async () => {
		const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-incarnation-"));
		const previousCommand = process.env.GJC_SDK_SESSION_COMMAND;
		let incarnationReads = 0;
		let childPid: number | undefined;
		const broker = new Broker({ agentDir });
		process.env.GJC_SDK_SESSION_COMMAND = "/bin/sleep 60";
		setProcessIncarnationForTest(broker, pid => {
			childPid ??= pid;
			return ++incarnationReads === 1 ? `test:${pid}` : undefined;
		});
		await broker.start();
		try {
			expect(
				await broker.handleRequest(
					"session.create",
					{ cwd: agentDir, readinessTimeoutMs: 4_000 },
					"unreadable-incarnation",
				),
			).toMatchObject({ ok: false, error: { code: "terminal_uncertain" } });
			expect(childPid).toBeGreaterThan(0);
			expect(await broker.handleRequest("session.list", {})).toMatchObject({
				ok: true,
				result: { sessions: [expect.objectContaining({ terminalUncertain: true })] },
			});
		} finally {
			if (previousCommand === undefined) delete process.env.GJC_SDK_SESSION_COMMAND;
			else process.env.GJC_SDK_SESSION_COMMAND = previousCommand;
			setProcessIncarnationForTest(broker, undefined);
			const pid = childPid;
			if (
				pid &&
				(() => {
					try {
						process.kill(pid, 0);
						return true;
					} catch {
						return false;
					}
				})()
			)
				process.kill(pid, "SIGKILL");
			await broker.stop();
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	}, 10_000);
}

test("broker starts from the production broker entrypoint with no sessions", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-zero-"));
	const broker = new Broker({ agentDir });
	try {
		const discovery = await broker.start();
		expect(discovery.url).toStartWith("ws://127.0.0.1:");
		expect(await broker.handleRequest("session.list", {})).toEqual({
			ok: true,
			result: { indexSeq: 0, sessions: [], warnings: [] },
			indexSeq: 0,
		});
	} finally {
		await broker.stop();
		await fs.rm(agentDir, { recursive: true, force: true });
	}
});

test("shipped sdk session-host-internal stays alive only after a semantic ready event and serves real requests", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-subprocess-"));
	const agentDir = path.join(root, "agent");
	const sessionId = "shipped-subprocess";
	brokerDirs.push(agentDir);
	try {
		const { child, endpoint } = await liveLifecycleSession(root, agentDir, sessionId);
		const client = await SdkClient.connect(endpoint.url, endpoint.token, { timeoutMs: 2_000, reconnectAttempts: 0 });
		try {
			const replay = await client.request({ type: "event_replay", sinceGeneration: 1, sinceSeq: 0 });
			expect(replay.events).toContainEqual(
				expect.objectContaining({ type: "event", name: "session_ready", sessionId }),
			);
			expect(child.exitCode).toBeNull();
			expect(await client.query("session.metadata")).toMatchObject({
				ok: true,
				page: { items: [{ sessionId }] },
			});
			expect(await client.control("mode.plan.set", { on: true })).toMatchObject({ ok: true });
		} finally {
			await client.close();
		}
		child.kill("SIGTERM");
		expect(await child.exited).toBe(0);
		spawned.splice(spawned.indexOf(child), 1);
		const broker = await waitFor(
			async () => (await readSdkBrokerDiscovery(agentDir)) ?? undefined,
			"broker discovery",
		);
		expect(broker.url).toStartWith("ws://127.0.0.1:");
	} finally {
		await stopDiscoveredBroker(agentDir);
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);

test("session-host-internal exits with a sanitized startup failure before writing lifecycle readiness", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-startup-failure-"));
	const agentDir = path.join(root, "agent");
	const sessionId = "startup-failure";
	const stateRoot = path.join(root, ".gjc", "state");
	try {
		await fs.mkdir(path.dirname(stateRoot), { recursive: true });
		await fs.writeFile(stateRoot, "not-a-directory");
		const child = Bun.spawn([process.execPath, "run", cliEntrypoint, "sdk", "session-host-internal"], {
			cwd: root,
			env: {
				...process.env,
				HOME: root,
				GJC_AGENT_DIR: agentDir,
				GJC_CODING_AGENT_DIR: agentDir,
				GJC_SESSION_ID: sessionId,
				GJC_LIFECYCLE_REQUEST_ID: "startup-failure-proof",
				GJC_SDK_LIFECYCLE_REQUEST: JSON.stringify({
					operation: "session.create",
					sessionId,
					cwd: root,
					stateRoot,
					effectMarker: "startup-failure-proof",
					...deriveLifecycleDeadlines(Date.now(), 10_000),
				}),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		spawned.push(child);
		await waitFor(async () => (child.exitCode === null ? undefined : child.exitCode), "startup failure exit");
		expect(child.exitCode).not.toBe(0);
		const stderr = await new Response(child.stderr).text();
		expect(stderr.trim()).not.toBe("");
		expect(stderr).not.toContain("readiness timeout");
		expect(await fs.readFile(stateRoot, "utf8")).toBe("not-a-directory");
		spawned.splice(spawned.indexOf(child), 1);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);

test("production lifecycle factory failure preserves reason and redacts collected secrets", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-factory-failure-"));
	const agentDir = path.join(root, "agent");
	const broker = new Broker({ agentDir });
	const names = ["GJC_SDK_TEST_FACTORY_FAILURE", "GJC_SDK_TEST_FACTORY_SECRET"] as const;
	const previous = names.map(name => process.env[name]);
	const bare = "factory-bare-secret";
	const overlap = `${bare}-overlap`;
	const normalized = "factory-secret０".normalize("NFKC");
	process.env.GJC_SDK_TEST_FACTORY_FAILURE = root;
	process.env.GJC_SDK_TEST_FACTORY_SECRET = `${overlap} ${normalized} ${"x".repeat(600)}`;
	try {
		await broker.start();
		const response = await broker.handleRequest(
			"session.create",
			{ cwd: root, readinessTimeoutMs: 4_000 },
			"factory-secret-failure",
		);
		expect(response).toMatchObject({
			ok: false,
			error: { code: "spawn_failed", endpoint: "unavailable" },
			startupFailure: { phase: "registration", reason: "factory_absent" },
		});
		if (response.ok || !response.startupFailure) throw new Error("Expected startup failure evidence.");
		expect(response.startupFailure.message).toContain("[redacted-secret]");
		expect(response.startupFailure.message).not.toContain(bare);
		expect(response.startupFailure.message).not.toContain(overlap);
		expect(response.startupFailure.message).not.toContain(normalized);
		expect(new TextEncoder().encode(response.startupFailure.message).byteLength).toBeLessThanOrEqual(512);
	} finally {
		names.forEach((name, index) => {
			const value = previous[index];
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		});
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 10_000);
test("never-settling model profile startup cuts off with proven pre-registration cleanup", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-profile-cutoff-"));
	const agentDir = path.join(root, "agent");
	const broker = new Broker({ agentDir });
	const previous = process.env.GJC_SDK_TEST_HANG_MODEL_PROFILE;
	process.env.GJC_SDK_TEST_HANG_MODEL_PROFILE = root;
	try {
		await broker.start();
		const input = { cwd: root, readinessTimeoutMs: 4_000 };
		const response = await broker.handleRequest("session.create", input, "profile-cutoff");
		expect(response).toMatchObject({
			ok: false,
			error: { code: "spawn_failed", endpoint: "unavailable" },
			startupFailure: {
				phase: "startup",
				reason: "pending",
				rollback: {
					endpointGeneration: null,
					fenced: true,
					runtimeRemoved: true,
					hostStopped: true,
					brokerRegistrationReleased: true,
				},
				cleanupProof: {
					processExited: true,
					endpointRemoved: true,
					hostUnregistered: { state: "not_registered" },
				},
			},
		});
		expect(await broker.handleRequest("session.create", input, "profile-cutoff")).toEqual(response);
	} finally {
		if (previous === undefined) delete process.env.GJC_SDK_TEST_HANG_MODEL_PROFILE;
		else process.env.GJC_SDK_TEST_HANG_MODEL_PROFILE = previous;
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 10_000);
test("production post-registration startup failure proves cleanup and exact replay", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-production-failure-"));
	const agentDir = path.join(root, "agent");
	const broker = new Broker({ agentDir });
	const previousFailure = process.env.GJC_SDK_TEST_FAIL_AFTER_REGISTRATION;
	process.env.GJC_SDK_TEST_FAIL_AFTER_REGISTRATION = root;
	try {
		await broker.start();
		const input = { cwd: root, readinessTimeoutMs: 10_000 };
		const response = await broker.handleRequest("session.create", input, "production-startup-failure");
		expect(response).toMatchObject({
			ok: false,
			error: {
				code: "spawn_failed",
				message: "No ready SDK endpoint remains available.",
				endpoint: "unavailable",
			},
			startupFailure: {
				phase: "startup",
				reason: "failed",
				rollback: {
					endpointGeneration: expect.any(Number),
					fenced: true,
					runtimeRemoved: true,
					hostStopped: true,
					brokerRegistrationReleased: true,
				},
				cleanupProof: {
					processExited: true,
					endpointRemoved: true,
					hostUnregistered: {
						indexSeq: expect.any(Number),
						lifecycleRequestId: expect.any(String),
					},
					rollback: {
						endpointGeneration: expect.any(Number),
						fenced: true,
						runtimeRemoved: true,
						hostStopped: true,
						brokerRegistrationReleased: true,
					},
				},
			},
			durableEffects: {
				transcript: { identityDigest: expect.any(String), contentDigest: expect.any(String) },
				digest: expect.any(String),
			},
		});
		expect(await broker.handleRequest("session.create", input, "production-startup-failure")).toEqual(response);
		const failure = response.ok ? undefined : response.startupFailure;
		if (!failure) throw new Error("Expected persisted startup failure evidence.");
		const sessions = await broker.handleRequest("session.list", {});
		expect(sessions).toMatchObject({ ok: true, result: { sessions: [] } });
		const sdkDir = path.join(root, ".gjc", "state", "sdk");
		const entries = await fs.readdir(sdkDir);
		expect(entries.some(entry => entry.includes(".lifecycle.failure."))).toBe(false);
		expect(entries.some(entry => entry.endsWith(".lifecycle.json"))).toBe(false);
	} finally {
		if (previousFailure === undefined) delete process.env.GJC_SDK_TEST_FAIL_AFTER_REGISTRATION;
		else process.env.GJC_SDK_TEST_FAIL_AFTER_REGISTRATION = previousFailure;
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);
test("production broker session.create authenticates a source-workspace v3 native endpoint", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-v3-broker-"));
	const agentDir = path.join(root, "agent");
	const broker = new Broker({ agentDir });
	try {
		expect(typeof NotificationServer.prototype.onSdkFrame).toBe("function");
		await broker.start();
		const created = await broker.handleRequest(
			"session.create",
			{ cwd: root, readinessTimeoutMs: 10_000 },
			"v3-native-create",
		);
		if (!created.ok) throw new Error(created.error.message);
		const { sessionId, endpoint } = created.result as {
			sessionId: string;
			endpoint: { url: string; token: string };
		};
		expect(typeof sessionId).toBe("string");
		expect(typeof endpoint.url).toBe("string");
		expect(typeof endpoint.token).toBe("string");
		const client = await SdkClient.connect(endpoint.url, endpoint.token, { timeoutMs: 2_000, reconnectAttempts: 0 });
		try {
			const replay = await client.request({ type: "event_replay", sinceGeneration: 1, sinceSeq: 0 });
			expect(replay.events).toContainEqual(
				expect.objectContaining({ type: "event", name: "session_ready", sessionId }),
			);
			expect(await client.query("session.metadata")).toMatchObject({
				ok: true,
				page: { items: [expect.objectContaining({ sessionId })] },
			});
		} finally {
			await client.close();
		}
		expect(await broker.handleRequest("session.close", { sessionId }, "v3-native-close")).toMatchObject({
			ok: true,
			result: { sessionId },
		});
		const sdkEntries = await fs.readdir(path.join(root, ".gjc", "state", "sdk"));
		expect(sdkEntries.some(entry => entry.includes(".lifecycle.failure."))).toBe(false);
	} finally {
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);

test("broker close acknowledges before terminating the lifecycle child and preserves its terminal host index", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-close-subprocess-"));
	const agentDir = path.join(root, "agent");
	const sessionId = "close-subprocess";
	const broker = new Broker({ agentDir });
	try {
		await broker.start();
		const { child, endpoint } = await liveLifecycleSession(root, agentDir, sessionId);
		// The lifecycle child writes its endpoint file before the broker index records
		// its host_registered event; wait for the session to be indexed so session.close
		// does not race the registration (slow CI runners surfaced "session is not indexed").
		await waitFor(async () => {
			const listed = (await broker.handleRequest("session.list", {})) as {
				result?: { sessions?: Array<{ sessionId?: string }> };
			};
			return listed.result?.sessions?.some(session => session.sessionId === sessionId) ? true : undefined;
		}, "session indexed before close");
		const closed = await broker.handleRequest("session.close", { sessionId }, "close-1");
		expect(closed).toMatchObject({ ok: true, result: { sessionId } });
		expect(await child.exited).toBe(0);
		expect(await broker.handleRequest("session.get_endpoint", { sessionId })).toMatchObject({
			ok: false,
			error: { code: "resource_gone" },
		});
		await expect(
			SdkClient.connect(endpoint.url, endpoint.token, { timeoutMs: 250, reconnectAttempts: 0 }),
		).rejects.toThrow();
		expect(await broker.handleRequest("session.list", {})).toMatchObject({ ok: true, result: { sessions: [] } });
		expect(
			(await fs.readFile(path.join(agentDir, "sdk", "sessions", "index.jsonl"), "utf8"))
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line) as { type?: string; sessionId?: string })
				.at(-1),
		).toMatchObject({ type: "host_unregistered", sessionId });
		expect(await broker.handleRequest("session.close", { sessionId }, "close-1")).toEqual(closed);
	} finally {
		await broker.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);

test("ACP, MCP, and daemon global requests bootstrap a broker with zero sessions", async () => {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-sdk-zero-global-"));
	const agentDirs = ["acp", "mcp", "daemon"].map(name => path.join(root, name, "agent"));
	brokerDirs.push(...agentDirs);
	try {
		const acp = new AcpAgent({ signal: new AbortController().signal } as never, { agentDir: agentDirs[0] });
		expect(await acp.listSessions({})).toEqual({ sessions: [] });
		expect(await readSdkBrokerDiscovery(agentDirs[0])).not.toBeNull();

		const mcp = createSdkMcpServer({ repo: path.join(root, "mcp"), agentDir: agentDirs[1] });
		expect(await mcp.callTool("gjc_session_global", { operation: "session.list" })).toMatchObject({
			ok: true,
			result: { sessions: [] },
		});
		expect(await readSdkBrokerDiscovery(agentDirs[1])).not.toBeNull();

		const output: unknown[] = [];
		await runSdkSessionCli(
			{ action: "global", operation: "session.list", agentDir: agentDirs[2], repo: path.join(root, "daemon") },
			value => output.push(value),
		);
		expect(output).toMatchObject([{ ok: true, result: { sessions: [] } }]);
		expect(await readSdkBrokerDiscovery(agentDirs[2])).not.toBeNull();
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 20_000);
