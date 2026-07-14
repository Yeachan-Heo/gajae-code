import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { openLifecycleSessionManager } from "../src/commands/sdk";
import { AcpAgent } from "../src/modes/acp/acp-agent";
import { Broker } from "../src/sdk/broker/broker";
import { brokerOwnerForTest } from "../src/sdk/broker/ensure";
import {
	parseDarwinProcessIncarnation,
	processIncarnation,
	setProcessIncarnationForTest,
} from "../src/sdk/broker/lifecycle";
import { runSdkSessionCli } from "../src/sdk/cli";
import { SdkClient } from "../src/sdk/client";
import { readSdkBrokerDiscovery } from "../src/sdk/client/discovery";
import { createSdkMcpServer } from "../src/sdk/mcp";
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

async function liveLifecycleSession(root: string, agentDir: string, sessionId: string) {
	const stateRoot = path.join(root, ".gjc", "state");
	const request = { operation: "session.create", sessionId, cwd: root, stateRoot } as const;
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
		if (!child.pid) throw new Error("session host has no pid");
		await fs.writeFile(
			path.join(stateRoot, "sdk", `${sessionId}.lifecycle.json`),
			JSON.stringify({
				pid: child.pid,
				effectMarker: "subprocess-proof",
				incarnation: await incarnation(child.pid),
			}),
		);
		return { child, endpoint };
	} catch (error) {
		if (child.exitCode === null) child.kill("SIGTERM");
		await child.exited;
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}; child exit=${child.exitCode}; stdout=${await new Response(child.stdout).text()}; stderr=${await new Response(child.stderr).text()}`,
		);
	}
}

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
		const originalInventory = SessionManager.inventorySessionsStrict;
		let replaced = false;
		const replaceAfterAuthorization: typeof SessionManager.inventorySessionsStrict = (cwd, options) => {
			const result = originalInventory(cwd, options);
			if (!replaced) {
				replaced = true;
				renameSync(replacementPath, sessionPath);
			}
			return result;
		};
		SessionManager.inventorySessionsStrict = replaceAfterAuthorization;
		try {
			await expect(
				openLifecycleSessionManager(
					{
						operation: "session.resume",
						sessionId: candidate.id,
						cwd: root,
						stateRoot: path.join(root, ".gjc", "state"),
						sessionPath,
						sessionIdentity: {
							dev: candidate.identity.dev.toString(),
							ino: candidate.identity.ino.toString(),
							size: candidate.identity.size,
							mtimeMs: candidate.identity.mtimeMs,
							mtimeNs: candidate.identity.mtimeNs.toString(),
						},
					},
					root,
					agentDir,
				),
			).rejects.toThrow("Lifecycle saved session authority changed before the session host consumed it.");
			expect(replaced).toBe(true);
		} finally {
			SessionManager.inventorySessionsStrict = originalInventory;
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
		try {
			await expect(
				openLifecycleSessionManager(
					{
						operation: "session.fork",
						sessionId: "fork-destination",
						cwd: targetCwd,
						stateRoot: path.join(targetCwd, ".gjc", "state"),
						sourceCwd,
						sourceSessionId: candidate.id,
						sourceSessionPath: sourcePath,
						sourceSessionIdentity: {
							dev: candidate.identity.dev.toString(),
							ino: candidate.identity.ino.toString(),
							size: candidate.identity.size,
							mtimeMs: candidate.identity.mtimeMs,
							mtimeNs: candidate.identity.mtimeNs.toString(),
						},
					},
					targetCwd,
					agentDir,
				),
			).rejects.toThrow("Lifecycle saved session authority changed while the session host forked it.");
			expect(replaced).toBe(true);
			await expect(fs.lstat(destinationSessionDir)).rejects.toThrow();
		} finally {
			SessionManager.captureTranscriptStrict = originalCapture;
		}
	} finally {
		await source.close();
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
			{ cwd: agentDir, stateRoot, readinessTimeoutMs: 300 },
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
		expect(await lifecycle).toMatchObject({ ok: false, error: { code: "readiness_timeout" } });
		expect(Date.now() - started).toBeLessThan(1_500);
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
				{ stateRoot, cwd: agentDir, readinessTimeoutMs: 300, body: "first", modelPreset: "codex-eco" },
				"create-1",
			),
			broker.handleRequest(
				"session.create",
				{ stateRoot, cwd: agentDir, readinessTimeoutMs: 300, body: "second", modelPreset: "codex-eco" },
				"create-2",
			),
		]);
		expect(first).toMatchObject({ ok: false, error: { code: "readiness_timeout" } });
		expect(second).toMatchObject({ ok: false, error: { code: "readiness_timeout" } });
		expect(Date.now() - started).toBeGreaterThanOrEqual(500);
		const fixturePid = Number(await fs.readFile(path.join(agentDir, "fixture.pid"), "utf8"));
		expect(() => process.kill(fixturePid, 0)).toThrow();
		expect(JSON.parse(await fs.readFile(path.join(agentDir, "fixture.request.json"), "utf8"))).toMatchObject({
			cwd: agentDir,
			modelPreset: "codex-eco",
		});
		expect((await fs.readdir(path.join(stateRoot, "sdk"))).filter(name => name.endsWith(".json"))).toEqual([]);
		const listed = await broker.handleRequest("session.list", {});
		expect(listed.ok).toBe(true);
		if (!listed.ok) throw new Error(listed.error.message);
		expect(listed.result).toMatchObject({ sessions: [] });
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
					message: "readinessTimeoutMs must be an integer between 1 and 60000.",
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

test("broker fails promptly when the owned lifecycle child exits before readiness", async () => {
	const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-child-exit-"));
	const fixture = path.join(agentDir, "exit.js");
	const previousCommand = process.env.GJC_SDK_SESSION_COMMAND;
	const broker = new Broker({ agentDir });
	try {
		await fs.writeFile(fixture, "setTimeout(() => process.exit(0), 100);");
		process.env.GJC_SDK_SESSION_COMMAND = `${process.execPath} ${fixture}`;
		await broker.start();
		const started = Date.now();
		expect(
			await broker.handleRequest("session.create", { cwd: agentDir, readinessTimeoutMs: 2_000 }, "child-exits"),
		).toMatchObject({ ok: false, error: { code: "spawn_failed" } });
		expect(Date.now() - started).toBeLessThan(1_000);
	} finally {
		if (previousCommand === undefined) delete process.env.GJC_SDK_SESSION_COMMAND;
		else process.env.GJC_SDK_SESSION_COMMAND = previousCommand;
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
				{ cwd: agentDir, stateRoot, readinessTimeoutMs: 1_000 },
				"foreign-ready",
			),
		).toMatchObject({ ok: false, error: { code: "readiness_timeout" } });
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
					{ cwd: agentDir, readinessTimeoutMs: 100 },
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
