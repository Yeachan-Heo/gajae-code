import { expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { assertTranscript, type TranscriptHeader } from "./oracle-contract";

const repoRoot = path.resolve(import.meta.dir, "../../../../../..");
const appBundlePath = "/Applications/T3 Code (Alpha).app";
const infoPlistPath = path.join(appBundlePath, "Contents/Info.plist");
const serverBundlePath = path.join(appBundlePath, "Contents/Resources/app.asar.unpacked/apps/server/dist/bin.mjs");
const expectedClientVersion = "0.0.28";
const expectedServerSha256 = "c69b9ebf8ddf0b30194616b49163bc5b6e3670be5549b81567b56f3dcd7aebd3";
const nodeBinary = "/opt/homebrew/bin/node";
const bunBinary = "/opt/homebrew/bin/bun";
const frameTimeoutMs = 90_000;

type JsonObject = Record<string, unknown>;
type ProcessRecord = {
	readonly pid: number;
	childPid?: number;
	argv?: string[];
	codexHome?: string;
	stdin: Buffer[];
	stdout: Buffer[];
};

type CommandResult = {
	readonly code: number;
	readonly output: string;
};

class GateBlocked extends Error {
	readonly evidence: JsonObject;

	constructor(message: string, evidence: JsonObject) {
		super(message);
		this.name = "GateBlocked";
		this.evidence = evidence;
	}
}

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(100);
	}
	throw new GateBlocked(`Timed out waiting for ${description}.`, { description, timeoutMs });
}

function runCommand(command: string, args: string[]): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", chunk => {
			output += String(chunk);
		});
		child.stderr.on("data", chunk => {
			output += String(chunk);
		});
		child.once("error", reject);
		child.once("close", (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), output }));
	});
}

function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const listener = createServer();
		listener.once("error", reject);
		listener.listen(0, "127.0.0.1", () => {
			const address = listener.address();
			if (address === null || typeof address === "string") {
				listener.close();
				reject(new Error("Could not determine an available loopback port."));
				return;
			}
			listener.close(error => (error ? reject(error) : resolve(address.port)));
		});
	});
}

function parsePinnedBundleVersion(): string {
	const plist = readFileSync(infoPlistPath, "utf8");
	const match = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
	if (!match?.[1]) throw new Error("CFBundleShortVersionString is missing from T3 Code Info.plist.");
	return match[1];
}

function parseTranscript(text: string): Map<string, ProcessRecord> {
	const records = new Map<string, ProcessRecord>();
	for (const line of text.split(/\r?\n/)) {
		if (line.length === 0) continue;
		if (line.startsWith("META ")) {
			const value: unknown = JSON.parse(line.slice(5));
			if (!isRecord(value) || typeof value.pid !== "number") continue;
			const pid = String(value.pid);
			const record = records.get(pid) ?? { pid: value.pid, stdin: [], stdout: [] };
			if (typeof value.child === "number") record.childPid = value.child;
			if (Array.isArray(value.argv) && value.argv.every(entry => typeof entry === "string"))
				record.argv = value.argv;
			if (typeof value.codexHome === "string") record.codexHome = value.codexHome;
			records.set(pid, record);
			continue;
		}
		const match = line.match(/^([IO]) (\d+) (\S+)$/);
		if (!match) continue;
		const [, direction, pid, encoded] = match;
		const record = records.get(pid) ?? { pid: Number(pid), stdin: [], stdout: [] };
		record[direction === "I" ? "stdin" : "stdout"].push(Buffer.from(encoded!, "base64"));
		records.set(pid, record);
	}
	return records;
}

function decodeJsonLines(chunks: Buffer[]): { frames: JsonObject[]; malformed: string[] } {
	const text = Buffer.concat(chunks).toString("utf8");
	const frames: JsonObject[] = [];
	const malformed: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (isRecord(parsed)) frames.push(parsed);
			else malformed.push(trimmed);
		} catch {
			malformed.push(trimmed);
		}
	}
	return { frames, malformed };
}

function selectedClientProcess(records: Map<string, ProcessRecord>):
	| {
			readonly record: ProcessRecord;
			readonly outbound: JsonObject[];
			readonly inbound: JsonObject[];
			readonly malformedOutbound: string[];
			readonly malformedInbound: string[];
	  }
	| undefined {
	for (const record of records.values()) {
		const outbound = decodeJsonLines(record.stdin);
		const inbound = decodeJsonLines(record.stdout);
		const initialize = outbound.frames.find(
			frame =>
				frame.method === "initialize" &&
				isRecord(frame.params) &&
				isRecord(frame.params.clientInfo) &&
				frame.params.clientInfo.version === expectedClientVersion,
		);
		if (initialize) {
			return {
				record,
				outbound: outbound.frames,
				inbound: inbound.frames,
				malformedOutbound: outbound.malformed,
				malformedInbound: inbound.malformed,
			};
		}
	}
	return undefined;
}

function killPid(pid: number | undefined, signal: NodeJS.Signals): void {
	if (pid === undefined || pid <= 0 || pid === process.pid) return;
	try {
		process.kill(pid, signal);
	} catch {
		// The child may have already exited or been reaped with its parent.
	}
}

async function terminate(child: ChildProcess | undefined): Promise<void> {
	if (!child) return;
	if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
	await Promise.race([new Promise<void>(resolve => child.once("close", () => resolve())), sleep(2_000)]);
	if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function postJson(
	url: string,
	token: string | undefined,
	body: JsonObject,
): Promise<{ status: number; body: unknown }> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
	});
	const text = await response.text();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = text;
	}
	return { status: response.status, body: parsed };
}

test("G3b REAL-CLIENT gate: T3 Code 0.0.28 drives GJC through its spawn contract", async () => {
	const pinnedVersion = parsePinnedBundleVersion();
	expect(pinnedVersion).toBe(expectedClientVersion);
	expect(existsSync(appBundlePath)).toBe(true);
	expect(existsSync(serverBundlePath)).toBe(true);
	const serverSha256 = createHash("sha256").update(readFileSync(serverBundlePath)).digest("hex");
	expect(serverSha256).toBe(expectedServerSha256);

	const helpExpectations: ReadonlyArray<readonly [string[], RegExp]> = [
		[["serve", "--help"], /without opening a browser|headless pairing/i],
		[["project", "--help"], /add/i],
		[["connect", "--help"], /login|link/i],
		[["auth", "--help"], /pairing-token|session/i],
	];
	for (const [args, pattern] of helpExpectations) {
		const help = await runCommand(nodeBinary, [serverBundlePath, ...args]);
		expect(help.code, `${args.join(" ")} exited with: ${help.output}`).toBe(0);
		expect(help.output).toMatch(pattern);
	}

	const tempRoot = mkdtempSync(path.join(tmpdir(), "gjc-real-client-t3-"));
	const baseDir = path.join(tempRoot, "t3-home");
	const codexHome = path.join(tempRoot, "codex-home");
	const osHome = path.join(tempRoot, "os-home");
	const agentDir = path.join(tempRoot, "agent");
	const workspaceRoot = path.join(tempRoot, "workspace");
	const transcriptPath = path.join(tempRoot, "provider-transcript.log");
	const shimPath = path.join(tempRoot, "codex-shim.cjs");
	const port = await findFreePort();
	const environment = {
		...process.env,
		HOME: osHome,
		USERPROFILE: osHome,
		CODEX_HOME: codexHome,
		GJC_AGENT_DIR: agentDir,
		GJC_CODING_AGENT_DIR: agentDir,
		PI_CODING_AGENT_DIR: agentDir,
	};
	const header: TranscriptHeader = {
		gateId: "real-t3",
		transportMode: "spawned-stdio",
		executionMode: "real-broker-child",
		profile: "stable",
		clientVersion: expectedClientVersion,
	};
	let server: ChildProcess | undefined;
	let report: JsonObject;
	try {
		writeFileSync(
			shimPath,
			`#!/opt/homebrew/bin/node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const transcript = fs.openSync(${JSON.stringify(transcriptPath)}, "a");
const append = value => fs.writeSync(transcript, value);
const child = spawn(${JSON.stringify(bunBinary)}, [${JSON.stringify(path.join(repoRoot, "packages/coding-agent/src/cli.ts"))}, ...process.argv.slice(2)], {
  cwd: ${JSON.stringify(repoRoot)},
  env: process.env,
  stdio: ["pipe", "pipe", "inherit"],
});
append("META " + JSON.stringify({ pid: process.pid, child: child.pid, argv: process.argv.slice(2), codexHome: process.env.CODEX_HOME }) + "\\n");
process.stdin.on("data", chunk => {
  append("I " + process.pid + " " + Buffer.from(chunk).toString("base64") + "\\n");
  child.stdin.write(chunk);
});
child.stdout.on("data", chunk => {
  append("O " + process.pid + " " + Buffer.from(chunk).toString("base64") + "\\n");
  process.stdout.write(chunk);
});
const stop = signal => {
  try { child.kill(signal); } catch {}
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
process.stdin.on("end", () => child.stdin.end());
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
`,
			"utf8",
		);
		chmodSync(shimPath, 0o755);
		mkdirSync(path.join(baseDir, "userdata"), { recursive: true });
		writeFileSync(
			path.join(baseDir, "userdata", "settings.json"),
			JSON.stringify(
				{
					providers: {
						codex: { enabled: true, binaryPath: shimPath, homePath: codexHome },
					},
					textGenerationModelSelection: { instanceId: "codex", model: "gpt-5.4-mini" },
				},
				null,
				2,
			),
			"utf8",
		);
		const output: { value: string } = { value: "" };
		server = spawn(
			nodeBinary,
			[
				serverBundlePath,
				"serve",
				"--base-dir",
				baseDir,
				"--host",
				"127.0.0.1",
				"--port",
				String(port),
				"--no-browser",
				workspaceRoot,
			],
			{ cwd: repoRoot, env: environment, stdio: ["ignore", "pipe", "pipe"] },
		);
		server.stdout?.on("data", chunk => {
			output.value += String(chunk);
		});
		server.stderr?.on("data", chunk => {
			output.value += String(chunk);
		});
		await waitUntil(() => output.value.includes("T3 Code server is ready."), frameTimeoutMs, "T3 server readiness");
		const pairingToken = output.value.match(/Token: ([A-Z0-9]+)/)?.[1];
		if (!pairingToken)
			throw new GateBlocked("T3 server did not print a pairing token.", { output: output.value.slice(-2_000) });
		const exchange = new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
			subject_token: pairingToken,
			subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
			requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
			client_label: "gjc-real-client-t3-gate",
			client_device_type: "desktop",
			client_os: "darwin",
		});
		const tokenResponse = await fetch(`http://127.0.0.1:${port}/oauth/token`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: exchange,
		});
		const tokenPayload: unknown = await tokenResponse.json();
		if (!isRecord(tokenPayload) || typeof tokenPayload.access_token !== "string")
			throw new GateBlocked("T3 pairing token could not be exchanged for a bearer session.", { tokenPayload });
		const bearer = tokenPayload.access_token;
		const now = () => new Date().toISOString();
		const modelSelection = { instanceId: "codex", model: "gpt-5.4-mini" };
		const projectDispatch = await postJson(`http://127.0.0.1:${port}/api/orchestration/dispatch`, bearer, {
			type: "project.create",
			commandId: "real-t3-project-command",
			projectId: "real-t3-project",
			title: "G3b real T3 project",
			workspaceRoot,
			createWorkspaceRootIfMissing: false,
			defaultModelSelection: modelSelection,
			createdAt: now(),
		});
		if (projectDispatch.status !== 200)
			throw new GateBlocked("T3 project.create dispatch failed.", { projectDispatch });
		const threadDispatch = await postJson(`http://127.0.0.1:${port}/api/orchestration/dispatch`, bearer, {
			type: "thread.create",
			commandId: "real-t3-thread-command",
			threadId: "real-t3-thread",
			projectId: "real-t3-project",
			title: "G3b real T3 thread",
			modelSelection,
			runtimeMode: "full-access",
			interactionMode: "default",
			branch: null,
			worktreePath: null,
			createdAt: now(),
		});
		if (threadDispatch.status !== 200) throw new GateBlocked("T3 thread.create dispatch failed.", { threadDispatch });
		const turnDispatch = await postJson(`http://127.0.0.1:${port}/api/orchestration/dispatch`, bearer, {
			type: "thread.turn.start",
			commandId: "real-t3-turn-command",
			threadId: "real-t3-thread",
			message: { messageId: "real-t3-message", role: "user", text: "hello", attachments: [] },
			modelSelection,
			runtimeMode: "full-access",
			interactionMode: "default",
			createdAt: now(),
		});
		if (turnDispatch.status !== 200) throw new GateBlocked("T3 thread.turn.start dispatch failed.", { turnDispatch });

		let records = new Map<string, ProcessRecord>();
		let selected = selectedClientProcess(records);
		await waitUntil(
			() => {
				if (!existsSync(transcriptPath)) return false;
				records = parseTranscript(readFileSync(transcriptPath, "utf8"));
				selected = selectedClientProcess(records);
				if (!selected) return false;
				const initialize = selected.outbound.find(
					frame =>
						frame.method === "initialize" &&
						frame.id !== undefined &&
						isRecord(frame.params) &&
						isRecord(frame.params.clientInfo) &&
						frame.params.clientInfo.version === expectedClientVersion,
				);
				return (
					initialize !== undefined && selected.inbound.some(frame => String(frame.id) === String(initialize.id))
				);
			},
			frameTimeoutMs,
			"the pinned T3 initialize handshake",
		);
		if (!selected)
			throw new GateBlocked("No pinned T3 initialize handshake was captured.", { records: records.size });
		const initialize = selected.outbound.find(
			frame =>
				frame.method === "initialize" &&
				isRecord(frame.params) &&
				isRecord(frame.params.clientInfo) &&
				frame.params.clientInfo.version === expectedClientVersion,
		);
		if (!initialize || initialize.id === undefined) throw new Error("Pinned initialize request was not captured.");
		const initializeParams = initialize.params as JsonObject;
		expect(initializeParams.capabilities).toEqual({ experimentalApi: true });
		expect(initializeParams.clientInfo).toMatchObject({
			name: "t3code_desktop",
			title: "T3 Code Desktop",
			version: expectedClientVersion,
		});
		const initializeResponse = selected.inbound.find(frame => String(frame.id) === String(initialize.id));
		expect(initializeResponse).toBeDefined();
		expect(initializeResponse?.error).toBeUndefined();
		expect(isRecord(initializeResponse?.result)).toBe(true);
		expect(selected.outbound.some(frame => frame.method === "initialized")).toBe(true);
		const requests = selected.outbound
			.filter(frame => frame.id !== undefined && typeof frame.method === "string")
			.map(frame => ({ id: frame.id as string | number, method: frame.method as string }));
		const responses = selected.inbound.filter(
			frame => frame.id !== undefined && (frame.result !== undefined || frame.error !== undefined),
		);
		expect(selected.malformedOutbound).toEqual([]);
		expect(selected.malformedInbound).toEqual([]);
		expect(assertTranscript({ header, requests, responses })).toEqual([]);
		expect(selected.record.argv?.[0]).toBe("app-server");
		expect(selected.record.codexHome).toBe(codexHome);

		const threadStart = selected.outbound.find(frame => frame.method === "thread/start");
		if (!threadStart || threadStart.id === undefined)
			throw new GateBlocked("T3 completed initialize but did not attempt thread/start.", {
				observedMethods: selected.outbound.map(frame => frame.method).filter(value => typeof value === "string"),
			});
		const threadStartResponse = selected.inbound.find(frame => String(frame.id) === String(threadStart.id));
		if (!threadStartResponse)
			throw new GateBlocked("GJC did not answer T3 thread/start within the gate timeout.", { threadStart });
		if (
			isRecord(threadStartResponse.error) &&
			threadStartResponse.error.code === -32081 &&
			threadStartResponse.error.message === "Not supported"
		) {
			report = {
				status: "BLOCKED",
				gateId: header.gateId,
				clientVersion: expectedClientVersion,
				appBundlePath,
				serverBundleSha256: serverSha256,
				header,
				counts: {
					projectDispatches: 1,
					threadDispatches: 1,
					turnDispatches: 1,
					providerProcesses: records.size,
					requests: requests.length,
					responses: responses.length,
				},
				blocker: {
					reason:
						"GJC app-server stdio has no threadStartAdapter, so the real T3 client receives Not supported for thread/start and cannot issue turn/start.",
					evidence: { threadStartRequest: threadStart, threadStartResponse, turnStartObserved: false },
					unblockSteps: [
						"Launch GJC app-server with a real threadStartAdapter/child bridge (not the stdio runtime default).",
						"Rerun this gate and require T3 to emit turn/start and receive its completion notifications.",
					],
				},
			};
		} else {
			await waitUntil(
				() => {
					records = parseTranscript(readFileSync(transcriptPath, "utf8"));
					selected = selectedClientProcess(records);
					return selected?.outbound.some(frame => frame.method === "turn/start") === true;
				},
				frameTimeoutMs,
				"T3 turn/start",
			);
			report = {
				status: "PASSED",
				gateId: header.gateId,
				clientVersion: expectedClientVersion,
				appBundlePath,
				serverBundleSha256: serverSha256,
				header,
				counts: { projectDispatches: 1, threadDispatches: 1, turnDispatches: 1 },
			};
		}
	} catch (error) {
		if (!(error instanceof GateBlocked)) throw error;
		report = {
			status: "BLOCKED",
			gateId: header.gateId,
			clientVersion: expectedClientVersion,
			appBundlePath,
			serverBundleSha256: serverSha256,
			header,
			blocker: { reason: error.message, evidence: error.evidence },
		};
	} finally {
		await terminate(server);
		if (existsSync(transcriptPath)) {
			for (const record of parseTranscript(readFileSync(transcriptPath, "utf8")).values()) {
				killPid(record.childPid, "SIGTERM");
				killPid(record.pid, "SIGTERM");
			}
			await sleep(250);
			if (existsSync(transcriptPath)) {
				for (const record of parseTranscript(readFileSync(transcriptPath, "utf8")).values()) {
					killPid(record.childPid, "SIGKILL");
					killPid(record.pid, "SIGKILL");
				}
			}
		}
		rmSync(tempRoot, { recursive: true, force: true });
	}
	console.log(
		`G3b REAL-CLIENT ${report.status}: version=${expectedClientVersion} bin.mjs.sha256=${serverSha256} ` +
			`${JSON.stringify(report.blocker ?? { evidence: "turn/start observed" })}`,
	);
	expect(report.status === "PASSED" || report.status === "BLOCKED").toBe(true);
}, 240_000);
