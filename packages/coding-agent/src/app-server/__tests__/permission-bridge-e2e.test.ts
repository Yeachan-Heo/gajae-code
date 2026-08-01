import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

type JsonObject = Record<string, unknown>;
type Reader = {
	readonly reader: {
		read(): Promise<{ done: boolean; value?: Uint8Array }>;
	};
	readonly decoder: TextDecoder;
	buffer: string;
};

const repoRoot = path.resolve(import.meta.dir, "../../../../..");
const frameTimeoutMs = 30_000;

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readFrame(state: Reader): Promise<JsonObject> {
	const deadline = Date.now() + frameTimeoutMs;
	while (true) {
		const newline = state.buffer.indexOf("\n");
		if (newline >= 0) {
			const line = state.buffer.slice(0, newline).trim();
			state.buffer = state.buffer.slice(newline + 1);
			if (line.length === 0) continue;
			const parsed: unknown = JSON.parse(line);
			if (!isRecord(parsed)) throw new Error(`Expected a JSON object frame, received ${line}`);
			return parsed;
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error("Timed out waiting for an app-server frame.");
		const read = state.reader.read();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("Timed out waiting for an app-server frame.")), remaining);
		});
		try {
			const chunk = await Promise.race([read, timeout]);
			if (chunk.done) throw new Error("App-server stdout closed before the expected frame.");
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
	state: Reader,
	id: number,
	method: string,
	params: JsonObject,
	onFrame: (frame: JsonObject) => Promise<void>,
): Promise<JsonObject> {
	await sendFrame(child, { jsonrpc: "2.0", id, method, params });
	while (true) {
		const frame = await readFrame(state);
		if (frame.id === id) return frame;
		await onFrame(frame);
	}
}

async function runScenario(
	decision: JsonObject | undefined,
	approvalPolicy?: "never",
): Promise<{ approvalMethod: string | undefined; markerContent: string | undefined }> {
	const tempRoot = mkdtempSync(path.join(tmpdir(), "gjc-permission-bridge-e2e-"));
	const agentDir = path.join(tempRoot, "agent");
	const cwd = repoRoot;
	const marker = path.join(tempRoot, "tool-ran.txt");
	const provider = path.join(
		repoRoot,
		"packages/coding-agent/src/app-server/__tests__/fixtures/stub-model-provider.ts",
	);
	const command = `printf approved > ${marker}`;
	mkdirSync(agentDir);
	const child = Bun.spawn([process.execPath, "packages/coding-agent/src/cli.ts", "app-server", "--stdio"], {
		cwd: repoRoot,
		env: {
			...process.env,
			GJC_AGENT_DIR: agentDir,
			GJC_CODING_AGENT_DIR: agentDir,
			PI_CODING_AGENT_DIR: agentDir,
			GJC_TEST_MODEL_PROVIDER: provider,
			GJC_TEST_MODEL_PROVIDER_AUTHORITY: "1",
			GJC_TEST_MODEL_TOOL_COMMAND: command,
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stderr = new Response(child.stderr).text();
	const state: Reader = {
		reader: child.stdout.getReader() as unknown as Reader["reader"],
		decoder: new TextDecoder(),
		buffer: "",
	};
	let approvalMethod: string | undefined;
	const onFrame = async (frame: JsonObject): Promise<void> => {
		if (frame.method !== "execCommandApproval" && frame.method !== "applyPatchApproval") return;
		if (!decision) throw new Error(`approval request was unexpected under approvalPolicy=never: ${frame.method}`);
		approvalMethod = frame.method;
		await sendFrame(child, { jsonrpc: "2.0", id: frame.id as string, result: decision });
	};
	try {
		await sendRequest(
			child,
			state,
			1,
			"initialize",
			{
				clientInfo: { name: "permission-bridge-e2e", version: "1.0.0" },
			},
			onFrame,
		);
		await sendFrame(child, { jsonrpc: "2.0", method: "initialized" });
		const threadStart = await sendRequest(
			child,
			state,
			2,
			"thread/start",
			{
				cwd,
				model: "gjc-app-server-stub/gjc-app-server-stub-model",
				allowProviderModelFallback: false,
				experimentalRawEvents: false,
			},
			onFrame,
		);
		if (!isRecord(threadStart.result)) {
			child.kill();
			throw new Error(`thread/start failed: ${JSON.stringify(threadStart)}\nstderr: ${await stderr}`);
		}
		const thread = (threadStart.result as JsonObject).thread;
		expect(isRecord(thread)).toBe(true);
		const threadId = (thread as JsonObject).id;
		expect(typeof threadId).toBe("string");
		const turnStart = await sendRequest(
			child,
			state,
			3,
			"turn/start",
			{
				threadId,
				input: [{ type: "text", text: "run the guarded command", text_elements: [] }],
				...(approvalPolicy === undefined ? {} : { approvalPolicy }),
			},
			onFrame,
		);
		expect(isRecord(turnStart.result)).toBe(true);
		let completed = false;
		while (!completed) {
			const frame = await readFrame(state);
			await onFrame(frame);
			if (frame.method === "turn/completed") completed = true;
		}
		await child.stdin.end();
		await child.exited;
		const errorOutput = await stderr;
		if (child.exitCode !== 0) throw new Error(`app-server exited ${child.exitCode}: ${errorOutput}`);
		expect(approvalMethod).toBe(decision ? "execCommandApproval" : undefined);
		return {
			approvalMethod,
			markerContent: existsSync(marker) ? readFileSync(marker, "utf8") : undefined,
		};
	} finally {
		if (child.exitCode === null) child.kill();
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

test("real guarded child tool routes approval to the subscribed app-server client", async () => {
	const approved = await runScenario({ decision: "approved" });
	expect(approved.markerContent).toBe("approved");

	const denied = await runScenario({ decision: { denied: { rejection: "not allowed" } } });
	expect(denied.markerContent).toBeUndefined();

	const never = await runScenario(undefined, "never");
	expect(never.markerContent).toBe("approved");
}, 120_000);
