import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { APP_SERVER_PROJECTION_CUSTOM_ENTRY_TYPE } from "../../../session/session-manager";
import { stableValidators } from "../../protocol-source/schema-validators.generated";
import { assertTranscript, goldenBytes, type TranscriptHeader } from "./oracle-contract";

const repoRoot = path.resolve(import.meta.dir, "../../../../../..");
const goldenPath = path.join(import.meta.dir, "golden", "spawned-cli-json-rpc.golden.json");
const frameTimeoutMs = 30_000;
const shutdownTimeoutMs = 30_000;

type JsonObject = Record<string, unknown>;

type RequestPlan = {
	readonly id: number;
	readonly method: string;
	readonly params: JsonObject;
};

type StdoutReader = {
	// Structural: Bun's reader type parameterizes its buffer, which is irrelevant to framing here.
	readonly reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> };
	readonly decoder: TextDecoder;
	buffer: string;
};

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readFrame(state: StdoutReader): Promise<JsonObject> {
	const deadline = Date.now() + frameTimeoutMs;
	while (true) {
		const newline = state.buffer.indexOf("\n");
		if (newline >= 0) {
			const line = state.buffer.slice(0, newline).trim();
			state.buffer = state.buffer.slice(newline + 1);
			if (line.length === 0) continue;
			const parsed: unknown = JSON.parse(line);
			if (!isRecord(parsed)) throw new Error(`Expected a JSON object response, received ${line}`);
			return parsed;
		}

		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error("Timed out waiting for an app-server stdout frame.");
		const read = state.reader.read();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("Timed out waiting for an app-server stdout frame.")), remaining);
		});
		try {
			const chunk = await Promise.race([read, timeout]);
			if (chunk.done) throw new Error("App-server stdout closed before the expected response.");
			state.buffer += state.decoder.decode(chunk.value, { stream: true });
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}
}

async function sendFrame(child: Bun.Subprocess<"pipe", "pipe", "pipe">, frame: JsonObject): Promise<void> {
	child.stdin.write(`${JSON.stringify(frame)}\n`);
	await child.stdin.flush();
}

async function sendRequest(
	child: Bun.Subprocess<"pipe", "pipe", "pipe">,
	state: StdoutReader,
	request: RequestPlan,
	responses: JsonObject[],
	inbound: JsonObject[],
): Promise<JsonObject> {
	expect(stableValidators.clientRequestParams[request.method]?.(request.params), request.method).toBe(true);
	await sendFrame(child, { jsonrpc: "2.0", id: request.id, method: request.method, params: request.params });
	while (true) {
		const frame = await readFrame(state);
		inbound.push(frame);
		if (frame.id === request.id) {
			responses.push(frame);
			return frame;
		}
	}
}

async function sendNotification(
	child: Bun.Subprocess<"pipe", "pipe", "pipe">,
	method: string,
	params?: JsonObject,
): Promise<void> {
	expect(stableValidators.clientNotificationParams[method]?.(params), method).toBe(true);
	await sendFrame(child, { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
}

async function readUntilNotification(state: StdoutReader, inbound: JsonObject[], method: string): Promise<JsonObject> {
	while (true) {
		const frame = await readFrame(state);
		inbound.push(frame);
		if (frame.method === method) return frame;
	}
}

function processLines(marker: string): string[] {
	const result = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,command="]);
	const text = new TextDecoder().decode(result.stdout);
	return text
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0 && line.includes(marker));
}

/** Canonicalize only dynamic values observed in this run; structural keys remain untouched. */
function goldenFrameBytes(frame: JsonObject, identities: readonly string[], timestamps: ReadonlySet<number>): string {
	const normalizeIdentity = (value: unknown): unknown => {
		if (typeof value === "string" && identities.includes(value)) return "<normalized>";
		if (typeof value === "number" && timestamps.has(value)) return "<normalized>";
		if (Array.isArray(value)) return value.map(entry => normalizeIdentity(entry));
		if (!isRecord(value)) return value;
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeIdentity(entry)]));
	};
	return goldenBytes(normalizeIdentity(frame));
}

function observedTimestamps(frames: readonly JsonObject[]): ReadonlySet<number> {
	const values = new Set<number>();
	const visit = (value: unknown, key?: string): void => {
		if ((key === "startedAtMs" || key === "completedAtMs") && typeof value === "number") values.add(value);
		if (Array.isArray(value)) {
			for (const entry of value) visit(entry);
		} else if (isRecord(value)) {
			for (const [entryKey, entry] of Object.entries(value)) visit(entry, entryKey);
		}
	};
	for (const frame of frames) visit(frame);
	return values;
}

function jsonlFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const files: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const entryPath = path.join(directory, entry.name);
			if (entry.isDirectory()) visit(entryPath);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(entryPath);
		}
	};
	visit(root);
	return files;
}

function projectionRecords(agentDir: string): JsonObject[] {
	const records: JsonObject[] = [];
	for (const file of jsonlFiles(path.join(agentDir, "sessions"))) {
		for (const line of readFileSync(file, "utf8").split("\n")) {
			if (line.trim().length === 0) continue;
			const parsed: unknown = JSON.parse(line);
			if (
				!isRecord(parsed) ||
				parsed.type !== "custom" ||
				parsed.customType !== APP_SERVER_PROJECTION_CUSTOM_ENTRY_TYPE
			)
				continue;
			if (isRecord(parsed.data)) records.push(parsed.data);
		}
	}
	return records;
}

test("spawned CLI black-box JSON-RPC transcript satisfies the shared oracle", async () => {
	const tempRoot = mkdtempSync(path.join(tmpdir(), "gjc-spawned-cli-blackbox-"));
	const agentDir = path.join(tempRoot, "agent");
	const sourcePath = path.join(tempRoot, "source.txt");
	const destinationPath = path.join(tempRoot, "copied.txt");
	const sourceContents = "spawned stdio black-box fixture\n";
	const stubProviderPath = path.join(
		repoRoot,
		"packages/coding-agent/src/app-server/__tests__/fixtures/stub-model-provider.ts",
	);
	writeFileSync(sourcePath, sourceContents, "utf8");

	const requests: RequestPlan[] = [
		{
			id: 1,
			method: "initialize",
			params: { clientInfo: { name: "gjc-spawned-blackbox", version: "1.0.0" } },
		},
		{ id: 2, method: "fs/readFile", params: { path: sourcePath } },
		{
			id: 3,
			method: "fs/copy",
			params: { sourcePath, destinationPath, recursive: false },
		},
		{ id: 4, method: "model/list", params: { limit: 1 } },
		{ id: 5, method: "thread/loaded/list", params: {} },
		// app/list is a deliberate support-manifest not_supported row.
		{ id: 6, method: "app/list", params: {} },
	];
	const header: TranscriptHeader = {
		gateId: "spawned-cli-blackbox",
		transportMode: "spawned-stdio",
		executionMode: "real-broker-child",
		profile: "stable",
		clientVersion: "1.0.0",
	};
	const responses: JsonObject[] = [];
	const inbound: JsonObject[] = [];
	let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
	let stdout: StdoutReader | undefined;
	let stderr: Promise<string> | undefined;

	try {
		// `process.execPath` rather than a bare "bun": the obligations verifier re-executes this
		// gate with PATH=/usr/bin:/bin, where a PATH lookup would fail.
		child = Bun.spawn([process.execPath, "packages/coding-agent/src/cli.ts", "app-server", "--stdio"], {
			cwd: repoRoot,
			env: {
				...process.env,
				GJC_AGENT_DIR: agentDir,
				GJC_CODING_AGENT_DIR: agentDir,
				PI_CODING_AGENT_DIR: agentDir,
				GJC_TEST_MODEL_PROVIDER: stubProviderPath,
				GJC_TEST_MODEL_PROVIDER_AUTHORITY: "1",
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(Number.isInteger(child.pid) && child.pid > 0, "the real CLI must have a child pid").toBe(true);
		stderr = new Response(child.stderr).text();
		const reader = child.stdout.getReader();
		const stream: StdoutReader = { reader, decoder: new TextDecoder(), buffer: "" };
		stdout = stream;

		await sendRequest(child, stream, requests[0]!, responses, inbound);
		await sendNotification(child, "initialized");
		for (const request of requests.slice(1)) await sendRequest(child, stream, request, responses, inbound);

		const threadStart: RequestPlan = {
			id: 7,
			method: "thread/start",
			params: {
				cwd: repoRoot,
				model: "gjc-app-server-stub/gjc-app-server-stub-model",
				allowProviderModelFallback: false,
				experimentalRawEvents: false,
			},
		};
		requests.push(threadStart);
		const threadStartResponse = await sendRequest(child, stream, threadStart, responses, inbound);
		const threadStartResult = threadStartResponse.result;
		expect(isRecord(threadStartResult)).toBe(true);
		const thread = (threadStartResult as JsonObject).thread;
		expect(isRecord(thread)).toBe(true);
		expect((thread as JsonObject).modelProvider).toBe("gjc-app-server-stub");
		expect((threadStartResult as JsonObject).modelProvider).toBe("gjc-app-server-stub");
		expect((threadStartResult as JsonObject).model).toBe("gjc-app-server-stub-model");

		const brokerProcesses = processLines(agentDir).filter(line => line.includes("sdk broker-internal"));
		expect(brokerProcesses, "thread/start must leave a real broker child for the loaded thread").not.toEqual([]);

		const threadId = (thread as JsonObject).id;
		expect(typeof threadId).toBe("string");
		const turnStart: RequestPlan = {
			id: 8,
			method: "turn/start",
			params: {
				threadId: threadId as string,
				input: [{ type: "text", text: "hello from spawned black-box", text_elements: [] }],
			},
		};
		requests.push(turnStart);
		const turnStartResponse = await sendRequest(child, stream, turnStart, responses, inbound);
		const turnStartResult = turnStartResponse.result;
		expect(isRecord(turnStartResult)).toBe(true);
		expect((turnStartResult as JsonObject).turn).toMatchObject({ status: "inProgress" });
		await readUntilNotification(stream, inbound, "turn/completed");

		expect(responses).toHaveLength(requests.length);
		expect(responses.find(response => response.id === 6)).toEqual({
			id: 6,
			error: { code: -32081, message: "Not supported" },
		});
		expect(readFileSync(destinationPath, "utf8")).toBe(sourceContents);

		const inboundSequence = inbound.map(frame =>
			frame.id !== undefined ? `response:${String(frame.id)}` : String(frame.method),
		);
		expect(inboundSequence).toEqual([
			"response:1",
			"response:2",
			"response:3",
			"response:4",
			"response:5",
			"response:6",
			"response:7",
			"response:8",
			"turn/started",
			"item/started",
			"item/agentMessage/delta",
			"item/agentMessage/delta",
			"item/completed",
			"turn/completed",
		]);
		const deltaFrames = inbound.filter(frame => frame.method === "item/agentMessage/delta");
		expect(deltaFrames.map(frame => (frame.params as JsonObject).delta)).toEqual(["Stub ", "response."]);
		const startedItem = inbound.find(frame => frame.method === "item/started");
		expect((startedItem?.params as JsonObject).item).toMatchObject({
			type: "agentMessage",
			text: "Stub response.",
		});
		const completedItem = inbound.find(frame => frame.method === "item/completed");
		expect((completedItem?.params as JsonObject).item).toMatchObject({
			type: "agentMessage",
			text: "Stub response.",
		});
		const completedTurn = inbound.find(frame => frame.method === "turn/completed");
		expect((completedTurn?.params as JsonObject).turn).toMatchObject({ status: "completed" });

		const transcriptRequests = requests.map(({ id, method }) => ({ id, method }));
		const violations = assertTranscript({ header, requests: transcriptRequests, responses });
		expect(violations).toEqual([]);
		for (const frame of inbound) {
			if (frame.id !== undefined) continue;
			expect(typeof frame.method).toBe("string");
			const method = frame.method as string;
			expect(stableValidators.serverNotificationParams[method]?.(frame.params), method).toBe(true);
		}

		const turnId = (turnStartResult as JsonObject).turn;
		expect(isRecord(turnId)).toBe(true);
		const turnIdentity = (turnId as JsonObject).id;
		const itemIdentity = ((completedItem?.params as JsonObject).item as JsonObject).id;
		expect(typeof turnIdentity).toBe("string");
		expect(typeof itemIdentity).toBe("string");
		const identityValues = [threadId as string, turnIdentity as string, itemIdentity as string];
		const dynamicTimestamps = observedTimestamps(inbound);
		const methodById = new Map(requests.map(request => [request.id, request.method]));
		const actualGolden = inbound.map(frame =>
			frame.id !== undefined
				? {
						id: frame.id,
						method: methodById.get(Number(frame.id)),
						bytes: goldenFrameBytes(frame, identityValues, dynamicTimestamps),
					}
				: { method: frame.method, bytes: goldenFrameBytes(frame, identityValues, dynamicTimestamps) },
		);
		const committedGolden = JSON.parse(readFileSync(goldenPath, "utf8")) as typeof actualGolden;
		expect(actualGolden).toEqual(committedGolden);

		const readFileResponseIndex = requests.findIndex(request => request.method === "fs/readFile");
		expect(readFileResponseIndex).toBeGreaterThanOrEqual(0);
		const readFileResponse = responses[readFileResponseIndex]!;
		expect(isRecord(readFileResponse.result)).toBe(true);
		const tamperedReadFileResult = { ...(readFileResponse.result as JsonObject) };
		delete tamperedReadFileResult.dataBase64;
		const tamperedReadFileResponses = [...responses];
		tamperedReadFileResponses[readFileResponseIndex] = { ...readFileResponse, result: tamperedReadFileResult };
		const tamperReadFileViolations = assertTranscript({
			header,
			requests: transcriptRequests,
			responses: tamperedReadFileResponses,
		});
		expect(tamperReadFileViolations).toContainEqual({
			rule: "validator.result",
			detail: "fs/readFile result failed the stable validator",
		});

		const turnStartResponseIndex = requests.findIndex(request => request.method === "turn/start");
		expect(turnStartResponseIndex).toBeGreaterThanOrEqual(0);
		const tamperedTurnStartResult = { ...(responses[turnStartResponseIndex]!.result as JsonObject) };
		const tamperedTurn = { ...(tamperedTurnStartResult.turn as JsonObject) };
		delete tamperedTurn.id;
		tamperedTurnStartResult.turn = tamperedTurn;
		const tamperedTurnResponses = [...responses];
		tamperedTurnResponses[turnStartResponseIndex] = {
			...responses[turnStartResponseIndex]!,
			result: tamperedTurnStartResult,
		};
		const tamperTurnViolations = assertTranscript({
			header,
			requests: transcriptRequests,
			responses: tamperedTurnResponses,
		});
		expect(tamperTurnViolations).toContainEqual({
			rule: "validator.result",
			detail: "turn/start result failed the stable validator",
		});

		const projections = projectionRecords(agentDir);
		const projectionKinds = new Set(projections.map(record => record.recordKind));
		expect([...projectionKinds]).toEqual(
			expect.arrayContaining([
				"app-server.turn.created",
				"app-server.turn.item.completed",
				"app-server.turn.terminal",
			]),
		);
		const projectionItem = projections.find(record => record.recordKind === "app-server.turn.item.completed");
		expect((projectionItem?.payload as JsonObject).item).toMatchObject({ text: "Stub response." });
		const projectionTerminal = projections.find(record => record.recordKind === "app-server.turn.terminal");
		expect((projectionTerminal?.payload as JsonObject).turn).toMatchObject({ status: "completed" });

		await child.stdin.end();
		const shutdown = await Promise.race([
			child.exited.then(exitCode => ({ exitCode, timedOut: false as const })),
			Bun.sleep(shutdownTimeoutMs).then(() => ({ exitCode: undefined, timedOut: true as const })),
		]);
		if (shutdown.timedOut) {
			const evidence = processLines(agentDir);
			throw new Error(
				`stdio close did not stop CLI pid ${child.pid}; surviving processes: ${JSON.stringify(evidence)}`,
			);
		} else {
			expect(shutdown.exitCode, await stderr).toBe(0);
			const deadline = Date.now() + 5_000;
			let surviving = processLines(agentDir);
			while (surviving.length > 0 && Date.now() < deadline) {
				await Bun.sleep(100);
				surviving = processLines(agentDir);
			}
			expect(surviving, "transport close must not orphan the broker child").toEqual([]);
		}
	} finally {
		try {
			await stdout?.reader.cancel();
		} catch {
			// The process may have already closed stdout during normal shutdown.
		}
		if (child) {
			try {
				child.kill("SIGTERM");
			} catch {
				// A normally exited child has no live process to signal.
			}
			await child.exited.catch(() => -1);
		}
		await stderr?.catch(() => "");
		for (const line of processLines(agentDir)) {
			const pid = Number(line.split(/\s+/, 1)[0]);
			if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
				try {
					process.kill(pid, "SIGTERM");
				} catch {
					// The child may have exited between ps and kill.
				}
			}
		}
		rmSync(tempRoot, { recursive: true, force: true });
	}
}, 120_000);
