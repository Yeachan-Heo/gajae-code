import { expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { AuthStorage } from "../../../session/auth-storage";
import { experimentalValidators } from "../../protocol-source/schema-validators.generated";
import { assertTranscript, type TranscriptHeader } from "./oracle-contract";

const repoRoot = path.resolve(import.meta.dir, "../../../../../..");
const appBundlePath = "/Applications/T3 Code (Alpha).app";
const infoPlistPath = path.join(appBundlePath, "Contents/Info.plist");
const serverBundlePath = path.join(appBundlePath, "Contents/Resources/app.asar.unpacked/apps/server/dist/bin.mjs");
const expectedClientVersion = "0.0.28"; // T3 app bundle version pinned by Info.plist.
const expectedWireClientVersion = "0.1.0"; // T3 app-server initialize clientInfo.version pin.
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
	let selected: SelectedClientProcess | undefined;
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
		if (!initialize) continue;
		if (selected) return undefined;
		selected = {
			record,
			outbound: outbound.frames,
			inbound: inbound.frames,
			malformedOutbound: outbound.malformed,
			malformedInbound: inbound.malformed,
		};
	}
	return selected;
}

function initializeVersions(records: Map<string, ProcessRecord>): string[] {
	const versions: string[] = [];
	for (const record of records.values()) {
		const initialize = decodeJsonLines(record.stdin).frames.find(frame => frame.method === "initialize");
		const clientInfo = isRecord(initialize?.params) ? initialize.params.clientInfo : undefined;
		if (isRecord(clientInfo) && typeof clientInfo.version === "string") versions.push(clientInfo.version);
	}
	return versions;
}

type SelectedClientProcess = NonNullable<ReturnType<typeof selectedClientProcess>>;

function assertExperimentalInboundFrames(frames: readonly JsonObject[]): void {
	for (const frame of frames) {
		if (typeof frame.method !== "string") continue;
		const isServerRequest = frame.id !== undefined && frame.result === undefined && frame.error === undefined;
		const validator = isServerRequest
			? experimentalValidators.serverRequestParams[frame.method]
			: experimentalValidators.serverNotificationParams[frame.method];
		expect(
			validator,
			`${isServerRequest ? "server request" : "server notification"} ${frame.method} has a validator`,
		).toBeDefined();
		expect(validator?.(frame.params), `${frame.method} params satisfy the experimental validator`).toBe(true);
	}
}

function transcriptEvidence(
	transcriptPath: string,
	records: Map<string, ProcessRecord>,
	selected: SelectedClientProcess | undefined,
): JsonObject {
	return {
		rawTranscript: existsSync(transcriptPath) ? readFileSync(transcriptPath, "utf8") : "",
		processCount: records.size,
		observedOutboundMethods: selected?.outbound.map(frame => frame.method).filter(value => typeof value === "string"),
		observedInboundMethods: selected?.inbound.map(frame => frame.method).filter(value => typeof value === "string"),
		observedOutbound: selected?.outbound ?? [],
		observedInbound: selected?.inbound ?? [],
	};
}

function captureIsolatedLogs(root: string): Array<{ path: string; content: string }> {
	const logs: Array<{ path: string; content: string }> = [];
	const visit = (directory: string): void => {
		if (!existsSync(directory)) return;
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const entryPath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				visit(entryPath);
				continue;
			}
			if (!entry.isFile() || !/(?:\.log|\.txt|\.jsonl)$/.test(entry.name)) continue;
			try {
				logs.push({ path: entryPath, content: readFileSync(entryPath, "utf8") });
			} catch {
				// Ignore non-text or concurrently removed files in the isolated temp root.
			}
		}
	};
	visit(root);
	return logs;
}

function assertExperimentalOutboundFrames(frames: readonly JsonObject[]): void {
	for (const frame of frames) {
		if (typeof frame.method !== "string") continue;
		const isClientRequest = frame.id !== undefined && frame.result === undefined && frame.error === undefined;
		const validator = isClientRequest
			? experimentalValidators.clientRequestParams[frame.method]
			: experimentalValidators.clientNotificationParams[frame.method];
		expect(
			validator,
			`${isClientRequest ? "client request" : "client notification"} ${frame.method} has a validator`,
		).toBeDefined();
		expect(validator?.(frame.params), `${frame.method} params satisfy the experimental validator`).toBe(true);
	}
}

function nextNotificationIndex(frames: readonly JsonObject[], method: string, after: number): number {
	return frames.findIndex((frame, index) => index > after && frame.id === undefined && frame.method === method);
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
		GJC_TEST_MODEL_PROVIDER: path.join(
			repoRoot,
			"packages/coding-agent/src/app-server/__tests__/fixtures/stub-model-provider.ts",
		),
		GJC_TEST_MODEL_PROVIDER_AUTHORITY: "1",
	};
	const header: TranscriptHeader = {
		gateId: "real-t3",
		transportMode: "spawned-stdio",
		executionMode: "real-broker-child",
		profile: "experimental",
		clientVersion: expectedClientVersion,
	};
	let server: ChildProcess | undefined;
	let report: JsonObject;
	let probeModelIdsObserved: string[] = [];
	let probeResponsesValidated = false;
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
append("META " + JSON.stringify({ pid: process.pid, child: child.pid, argv: process.argv.slice(2), codexHome: process.env.CODEX_HOME, agentDir: process.env.GJC_AGENT_DIR, testProvider: process.env.GJC_TEST_MODEL_PROVIDER, testProviderAuthority: process.env.GJC_TEST_MODEL_PROVIDER_AUTHORITY }) + "\\n");
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
		const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
		await authStorage.set("openai", { type: "api_key", key: "gjc-g3b-test-api-key" });
		authStorage.close();
		writeFileSync(
			path.join(agentDir, "models.yml"),
			JSON.stringify(
				{
					providers: {
						"gjc-app-server-stub": {
							baseUrl: "http://127.0.0.1:9/v1",
							api: "openai-completions",
							apiKey: "gjc-g3b-test-api-key",
							models: [
								{
									id: "gjc-app-server-stub-model",
									name: "GJC app-server stub",
									reasoning: false,
									input: ["text"],
									contextWindow: 1_000_000,
									maxTokens: 4_096,
								},
							],
						},
					},
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
		const modelSelection = { instanceId: "codex", model: "gjc-app-server-stub/gjc-app-server-stub-model" };
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
		try {
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
							isRecord(frame.params.clientInfo),
					);
					return (
						initialize !== undefined && selected.inbound.some(frame => String(frame.id) === String(initialize.id))
					);
				},
				frameTimeoutMs,
				"the pinned T3 initialize handshake",
			);
		} catch (error) {
			if (!(error instanceof GateBlocked)) throw error;
			throw new GateBlocked(error.message, {
				...error.evidence,
				...transcriptEvidence(transcriptPath, records, selected),
			});
		}
		if (!selected)
			throw new GateBlocked("No pinned T3 initialize handshake was captured.", { records: records.size });
		const initialize = selected.outbound.find(
			frame => frame.method === "initialize" && isRecord(frame.params) && isRecord(frame.params.clientInfo),
		);
		if (!initialize || initialize.id === undefined) throw new Error("Pinned initialize request was not captured.");
		const initializeParams = initialize.params as JsonObject;
		expect(initializeParams.capabilities).toEqual({ experimentalApi: true });
		expect(initializeParams.clientInfo).toMatchObject({
			name: "t3code_desktop",
			title: "T3 Code Desktop",
		});
		expect((initializeParams.clientInfo as JsonObject).version).toBe(expectedClientVersion);
		const initializeResponse = selected.inbound.find(frame => String(frame.id) === String(initialize.id));
		expect(initializeResponse).toBeDefined();
		expect(initializeResponse?.error).toBeUndefined();
		expect(isRecord(initializeResponse?.result)).toBe(true);
		try {
			await waitUntil(
				() => {
					records = parseTranscript(readFileSync(transcriptPath, "utf8"));
					const current = selectedClientProcess(records);
					if (!current) return false;
					selected = current;
					return current.outbound.some(frame => frame.method === "initialized");
				},
				frameTimeoutMs,
				"the pinned T3 initialized notification",
			);
		} catch (error) {
			if (!(error instanceof GateBlocked)) throw error;
			throw new GateBlocked(error.message, {
				...error.evidence,
				...transcriptEvidence(transcriptPath, records, selected),
			});
		}
		try {
			await waitUntil(
				() => {
					records = parseTranscript(readFileSync(transcriptPath, "utf8"));
					const versions = initializeVersions(records);
					return (
						versions.filter(version => version === expectedClientVersion).length === 1 &&
						versions.filter(version => version === expectedWireClientVersion).length === 1
					);
				},
				frameTimeoutMs,
				"both pinned T3 provider-probe and turn-driving client versions",
			);
		} catch (error) {
			if (!(error instanceof GateBlocked)) throw error;
			throw new GateBlocked(error.message, {
				...error.evidence,
				initializeVersions: initializeVersions(records),
				...transcriptEvidence(transcriptPath, records, selected),
			});
		}
		try {
			await waitUntil(
				() => {
					records = parseTranscript(readFileSync(transcriptPath, "utf8"));
					const probe = [...records.values()].find(record => {
						const initializeFrame = decodeJsonLines(record.stdin).frames.find(
							frame => frame.method === "initialize",
						);
						const clientInfo = isRecord(initializeFrame?.params) ? initializeFrame.params.clientInfo : undefined;
						return isRecord(clientInfo) && clientInfo.version === expectedWireClientVersion;
					});
					if (!probe) return false;
					const outbound = decodeJsonLines(probe.stdin).frames;
					const inbound = decodeJsonLines(probe.stdout).frames;
					const requests = outbound.filter(frame => frame.id !== undefined);
					const answered = new Set(
						inbound
							.filter(frame => frame.id !== undefined && ("result" in frame || "error" in frame))
							.map(frame => String(frame.id)),
					);
					const requiredMethods = ["account/read", "model/list", "skills/list"];
					const requiredRequests = requiredMethods.map(method => requests.find(frame => frame.method === method));
					return (
						requiredRequests.every(request => request !== undefined) &&
						requiredRequests.every(request => answered.has(String(request!.id))) &&
						requests.every(request => answered.has(String(request.id)))
					);
				},
				frameTimeoutMs,
				"T3 provider-probe requests",
			);
		} catch (error) {
			if (!(error instanceof GateBlocked)) throw error;
			throw new GateBlocked(error.message, {
				...error.evidence,
				initializeVersions: initializeVersions(records),
				...transcriptEvidence(transcriptPath, records, selected),
			});
		}
		const probeRecord = [...records.values()].find(record => {
			const initializeFrame = decodeJsonLines(record.stdin).frames.find(frame => frame.method === "initialize");
			const clientInfo = isRecord(initializeFrame?.params) ? initializeFrame.params.clientInfo : undefined;
			return isRecord(clientInfo) && clientInfo.version === expectedWireClientVersion;
		});
		if (!probeRecord)
			throw new GateBlocked("The pinned 0.1.0 T3 provider-probe process was not captured.", {
				initializeVersions: initializeVersions(records),
				...transcriptEvidence(transcriptPath, records, selected),
			});
		const probeOutbound = decodeJsonLines(probeRecord.stdin).frames;
		const probeInbound = decodeJsonLines(probeRecord.stdout).frames;
		const probeModelListRequest = probeOutbound.find(frame => frame.method === "model/list");
		const probeModelListResponse = probeModelListRequest
			? probeInbound.find(frame => String(frame.id) === String(probeModelListRequest.id))
			: undefined;
		const probeModelListResult = probeModelListResponse?.result;
		if (
			!isRecord(probeModelListResult) ||
			!experimentalValidators.clientRequestResults["model/list"]?.(probeModelListResult)
		)
			throw new GateBlocked("T3 provider-probe model/list returned a malformed result.", {
				probeModelListRequest,
				probeModelListResponse,
				...transcriptEvidence(transcriptPath, records, selected),
			});
		const probeModelIds = Array.isArray(probeModelListResult.data)
			? probeModelListResult.data
					.filter(isRecord)
					.map(model => model.id)
					.filter((id): id is string => typeof id === "string")
			: [];
		if (!probeModelIds.includes("gjc-app-server-stub/gjc-app-server-stub-model"))
			throw new GateBlocked("T3 provider-probe model/list did not expose the configured stub model.", {
				probeModelIds,
				...transcriptEvidence(transcriptPath, records, selected),
			});
		const probeSkillsRequest = probeOutbound.find(frame => frame.method === "skills/list");
		const probeSkillsResponse = probeSkillsRequest
			? probeInbound.find(frame => String(frame.id) === String(probeSkillsRequest.id))
			: undefined;
		if (
			!isRecord(probeSkillsResponse?.result) ||
			!experimentalValidators.clientRequestResults["skills/list"]?.(probeSkillsResponse.result)
		)
			throw new GateBlocked("T3 provider-probe skills/list returned a malformed result.", {
				probeSkillsRequest,
				probeSkillsResponse,
				...transcriptEvidence(transcriptPath, records, selected),
			});
		probeModelIdsObserved = probeModelIds;
		probeResponsesValidated = true;
		// Creating a real GJC session for a thread takes seconds, so wait for the thread/start
		// request itself to be issued and answered, and for every other issued request to be
		// answered too; a snapshot taken before thread/start exists would satisfy a generic
		// all-issued check vacuously and then look like a protocol violation below.
		await waitUntil(
			() => {
				const current = selectedClientProcess(parseTranscript(readFileSync(transcriptPath, "utf8")));
				if (!current) return false;
				selected = current;
				const issued = current.outbound.filter(frame => frame.id !== undefined).map(frame => String(frame.id));
				const answered = new Set(
					current.inbound
						.filter(frame => frame.id !== undefined && (frame.result !== undefined || frame.error !== undefined))
						.map(frame => String(frame.id)),
				);
				const threadStartRequest = current.outbound.find(frame => frame.method === "thread/start");
				if (!threadStartRequest || threadStartRequest.id === undefined) return false;
				if (!answered.has(String(threadStartRequest.id))) return false;
				return issued.length > 0 && issued.every(id => answered.has(id));
			},
			frameTimeoutMs,
			"GJC to answer every request the real client issued",
		).catch(() => undefined);
		if (!selected)
			throw new GateBlocked(
				"The pinned T3 process disappeared before the turn transcript was captured.",
				transcriptEvidence(transcriptPath, records, selected),
			);
		expect(selected.record.argv?.[0]).toBe("app-server");
		expect(selected.record.codexHome).toBe(codexHome);

		const threadStart = selected.outbound.find(frame => frame.method === "thread/start");
		if (!threadStart || threadStart.id === undefined)
			throw new GateBlocked(
				"T3 completed initialize but did not attempt thread/start.",
				transcriptEvidence(transcriptPath, records, selected),
			);
		const threadStartResponse = selected.inbound.find(frame => String(frame.id) === String(threadStart.id));
		if (!threadStartResponse)
			throw new GateBlocked("GJC did not answer T3 thread/start within the gate timeout.", {
				threadStart,
				...transcriptEvidence(transcriptPath, records, selected),
			});
		if (isRecord(threadStartResponse.error))
			throw new GateBlocked(`T3 thread/start failed: ${threadStartResponse.error.message ?? "unknown error"}.`, {
				threadStartRequest: threadStart,
				threadStartResponse,
				...transcriptEvidence(transcriptPath, records, selected),
			});
		const threadResult = threadStartResponse.result;
		expect(isRecord(threadResult)).toBe(true);
		const thread = isRecord(threadResult) ? threadResult.thread : undefined;
		expect(isRecord(thread)).toBe(true);
		if (isRecord(thread) && thread.modelProvider !== "gjc-app-server-stub")
			throw new GateBlocked("T3 thread/start selected a model provider other than the stub.", {
				threadStartRequest: threadStart,
				threadStartResponse,
				...transcriptEvidence(transcriptPath, records, selected),
			});

		let turnStart: JsonObject | undefined;
		const turnRequestDeadline = Date.now() + frameTimeoutMs;
		while (!turnStart && Date.now() < turnRequestDeadline) {
			records = parseTranscript(readFileSync(transcriptPath, "utf8"));
			selected = selectedClientProcess(records);
			turnStart = selected?.outbound.find(frame => frame.method === "turn/start");
			if (!turnStart) await sleep(100);
		}
		if (!selected || !turnStart || turnStart.id === undefined)
			throw new GateBlocked(
				"T3 did not issue turn/start after a successful thread/start.",
				transcriptEvidence(transcriptPath, records, selected),
			);

		let terminalSequence: number[] | undefined;
		const completionDeadline = Date.now() + frameTimeoutMs;
		while (!terminalSequence && Date.now() < completionDeadline) {
			records = parseTranscript(readFileSync(transcriptPath, "utf8"));
			selected = selectedClientProcess(records);
			if (!selected) {
				await sleep(100);
				continue;
			}
			const turnResponseIndex = selected.inbound.findIndex(frame => String(frame.id) === String(turnStart.id));
			if (turnResponseIndex < 0) {
				await sleep(100);
				continue;
			}
			const turnStartResponse = selected.inbound[turnResponseIndex]!;
			if (turnStartResponse.error !== undefined)
				throw new GateBlocked("T3 turn/start returned an error instead of starting a turn.", {
					turnStartRequest: turnStart,
					turnStartResponse,
					probeStubModelSeen: probeModelIdsObserved.includes("gjc-app-server-stub/gjc-app-server-stub-model"),
					probeModelCount: probeModelIdsObserved.length,
					probeResponsesValidated,
					...transcriptEvidence(transcriptPath, records, selected),
				});
			const turnStartedIndex = nextNotificationIndex(selected.inbound, "turn/started", turnResponseIndex);
			const itemStartedIndex = nextNotificationIndex(selected.inbound, "item/started", turnStartedIndex);
			const deltaIndex = nextNotificationIndex(selected.inbound, "item/agentMessage/delta", itemStartedIndex);
			const itemCompletedIndex = nextNotificationIndex(selected.inbound, "item/completed", deltaIndex);
			const turnCompletedIndex = nextNotificationIndex(selected.inbound, "turn/completed", itemCompletedIndex);
			const usageIndex = nextNotificationIndex(selected.inbound, "thread/tokenUsage/updated", turnCompletedIndex);
			if (
				[turnStartedIndex, itemStartedIndex, deltaIndex, itemCompletedIndex, turnCompletedIndex, usageIndex].every(
					index => index >= 0,
				)
			) {
				terminalSequence = [
					turnResponseIndex,
					turnStartedIndex,
					itemStartedIndex,
					deltaIndex,
					itemCompletedIndex,
					turnCompletedIndex,
					usageIndex,
				];
				break;
			}
			await sleep(100);
		}
		if (!terminalSequence || !selected)
			throw new GateBlocked("T3 did not complete the required turn sequence before the gate timeout.", {
				expectedSequence: [
					"turn/start response",
					"turn/started",
					"item/started",
					"item/agentMessage/delta",
					"item/completed",
					"turn/completed",
					"thread/tokenUsage/updated",
				],
				...transcriptEvidence(transcriptPath, records, selected),
			});

		assertExperimentalOutboundFrames(selected.outbound);
		assertExperimentalInboundFrames(selected.inbound);
		const requests = selected.outbound
			.filter(frame => frame.id !== undefined && typeof frame.method === "string")
			.map(frame => ({ id: frame.id as string | number, method: frame.method as string }));
		const responses = selected.inbound.filter(
			frame => frame.id !== undefined && (frame.result !== undefined || frame.error !== undefined),
		);
		expect(selected.malformedOutbound).toEqual([]);
		expect(selected.malformedInbound).toEqual([]);
		expect(assertTranscript({ header, requests, responses })).toEqual([]);
		const completedTurnFrame = selected.inbound[terminalSequence[5]!];
		expect(isRecord(completedTurnFrame?.params)).toBe(true);
		const completedTurn = isRecord(completedTurnFrame?.params) ? completedTurnFrame.params.turn : undefined;
		expect(isRecord(completedTurn)).toBe(true);
		if (isRecord(completedTurn)) {
			expect(completedTurn.id).toBeDefined();
			expect(completedTurn.status).toBe("completed");
		}
		if (isRecord(completedTurn)) {
			const tamperedTurn = { ...completedTurn };
			delete tamperedTurn.id;
			const validateTurnCompleted = experimentalValidators.serverNotificationParams["turn/completed"];
			expect(validateTurnCompleted?.({ ...(completedTurnFrame?.params as JsonObject), turn: tamperedTurn })).toBe(
				false,
			);
		}
		const deltaFrames = selected.inbound.filter(frame => frame.method === "item/agentMessage/delta");
		expect(deltaFrames.length).toBeGreaterThan(0);
		expect(deltaFrames.map(frame => (isRecord(frame.params) ? frame.params.delta : undefined))).toEqual(
			expect.arrayContaining(["Stub ", "response."]),
		);
		report = {
			status: "PASSED",
			gateId: header.gateId,
			clientVersion: expectedClientVersion,
			wireClientVersion: expectedWireClientVersion,
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
			terminalSequence: terminalSequence.map(index => selected!.inbound[index]?.method ?? "turn/start response"),
		};
	} catch (error) {
		if (!(error instanceof GateBlocked)) throw error;
		report = {
			status: "BLOCKED",
			gateId: header.gateId,
			clientVersion: expectedClientVersion,
			wireClientVersion: expectedWireClientVersion,
			appBundlePath,
			serverBundleSha256: serverSha256,
			header,
			blocker: {
				reason: error.message,
				evidence: { ...error.evidence, isolatedCodexHomeLogs: captureIsolatedLogs(codexHome) },
			},
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
		`G3b REAL-CLIENT ${report.status}: version=${expectedClientVersion} wireClientVersion=${expectedWireClientVersion} ` +
			`bin.mjs.sha256=${serverSha256} header=${JSON.stringify(header)} ` +
			`${JSON.stringify(report.blocker ?? { evidence: "completed turn terminal sequence" })}`,
	);
	expect(report.status === "PASSED" || report.status === "BLOCKED").toBe(true);
}, 240_000);
