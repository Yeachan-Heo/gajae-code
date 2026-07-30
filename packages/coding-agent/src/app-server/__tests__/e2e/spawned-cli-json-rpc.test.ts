import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { assertTranscript, goldenBytes, type TranscriptHeader } from "./oracle-contract";

const repoRoot = path.resolve(import.meta.dir, "../../../../../..");
const goldenPath = path.join(import.meta.dir, "golden", "spawned-cli-json-rpc.golden.json");
const frameTimeoutMs = 30_000;

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

test("spawned CLI black-box JSON-RPC transcript satisfies the shared oracle", async () => {
	const tempRoot = mkdtempSync(path.join(tmpdir(), "gjc-spawned-cli-blackbox-"));
	const agentDir = path.join(tempRoot, "agent");
	const sourcePath = path.join(tempRoot, "source.txt");
	const destinationPath = path.join(tempRoot, "copied.txt");
	const sourceContents = "spawned stdio black-box fixture\n";
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
		// cli/runtime.ts creates the runtime without a threadStartAdapter or broker child.
		executionMode: "injected-in-process-session",
		profile: "stable",
		clientVersion: "1.0.0",
	};
	const responses: JsonObject[] = [];
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

		await sendFrame(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: requests[0]!.params });
		responses.push(await readFrame(stream));
		await sendFrame(child, { jsonrpc: "2.0", method: "initialized" });

		for (const request of requests.slice(1)) {
			await sendFrame(child, {
				jsonrpc: "2.0",
				id: request.id,
				method: request.method,
				params: request.params,
			});
			responses.push(await readFrame(stream));
		}

		expect(responses).toHaveLength(requests.length);
		expect(responses.at(-1)).toEqual({ id: 6, error: { code: -32081, message: "Not supported" } });
		expect(readFileSync(destinationPath, "utf8")).toBe(sourceContents);

		const transcriptRequests = requests.map(({ id, method }) => ({ id, method }));
		const violations = assertTranscript({ header, requests: transcriptRequests, responses });
		expect(violations).toEqual([]);

		const actualGolden = requests.map((request, index) => ({
			id: request.id,
			method: request.method,
			bytes: goldenBytes(responses[index]!),
		}));
		const committedGolden = JSON.parse(readFileSync(goldenPath, "utf8")) as typeof actualGolden;
		expect(actualGolden).toEqual(committedGolden);

		const readFileResponseIndex = requests.findIndex(request => request.method === "fs/readFile");
		expect(readFileResponseIndex).toBeGreaterThanOrEqual(0);
		const readFileResponse = responses[readFileResponseIndex]!;
		expect(isRecord(readFileResponse.result)).toBe(true);
		const tamperedResult = { ...(readFileResponse.result as JsonObject) };
		delete tamperedResult.dataBase64;
		const tamperedResponses = [...responses];
		tamperedResponses[readFileResponseIndex] = { ...readFileResponse, result: tamperedResult };
		const tamperViolations = assertTranscript({
			header,
			requests: transcriptRequests,
			responses: tamperedResponses,
		});
		expect(tamperViolations).toContainEqual({
			rule: "validator.result",
			detail: "fs/readFile result failed the stable validator",
		});

		await child.stdin.end();
		const exitCode = await child.exited;
		expect(exitCode, await stderr).toBe(0);
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
		rmSync(tempRoot, { recursive: true, force: true });
	}
}, 120_000);
