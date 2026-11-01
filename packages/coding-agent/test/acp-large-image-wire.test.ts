/**
 * ACP large inline image wire oracle — a real `gjc --mode acp` child over stdio.
 *
 * A standard ACP `session/prompt` carrying a ~1 MB PNG exceeds the private SDK
 * 256 KiB request-frame cap. The adapter must stage it through `turn.image.*`
 * and the exact original bytes must reach the outgoing provider request.
 *
 * The child environment never spreads `process.env`; every HOME/XDG/agent dir
 * is rooted under an owned temp root, and the model is a local fixture server.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import {
	type Client,
	ClientSideConnection,
	ndJsonStream,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import { startFixtureBrokerWithLeaseForTest } from "../src/sdk/broker/ensure";
import {
	cleanupFixtureRoots,
	createFixtureRootCleanup,
	type FixtureRootCleanup,
	registerFixtureRuntime,
	withFixtureBrokerEnvironment,
} from "./helpers/fixture-broker-cleanup";

type AcpProc = Bun.Subprocess<"pipe", "pipe", "pipe">;

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cleanupRoots: FixtureRootCleanup[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
const STDERR_CAP = 64 * 1024;

class OracleClient implements Client {
	async requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		return { outcome: { outcome: "selected", optionId: "allow_once" } };
	}
	async sessionUpdate(_params: SessionNotification): Promise<void> {}
}

afterEach(async () => {
	for (const server of servers.splice(0)) server.stop(true);
	await cleanupFixtureRoots(cleanupRoots);
});

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const header = Buffer.alloc(8);
	header.writeUInt32BE(data.length, 0);
	header.write(type, 4, "ascii");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])), 0);
	return Buffer.concat([header, data, crc]);
}

/** Incompressible RGB noise PNG, so the encoded file is roughly width*height*3 bytes. */
function noisePng(width: number, height: number): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // RGB
	const rowBytes = width * 3 + 1;
	const raw = crypto.randomBytes(rowBytes * height);
	for (let row = 0; row < height; row++) raw[row * rowBytes] = 0; // filter: none
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", zlib.deflateSync(raw, { level: 0 })),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

function sha256(bytes: Uint8Array): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** Every `data:<mime>;base64,<payload>` image URL in an OpenAI chat-completions request body. */
function requestImageDataUrls(body: unknown): Array<{ mimeType: string; data: string }> {
	const found: Array<{ mimeType: string; data: string }> = [];
	const visit = (value: unknown): void => {
		if (typeof value === "string") {
			const match = /^data:([^;]+);base64,(.*)$/s.exec(value);
			if (match) found.push({ mimeType: match[1]!, data: match[2]! });
			return;
		}
		if (Array.isArray(value)) for (const item of value) visit(item);
		else if (value && typeof value === "object") for (const item of Object.values(value)) visit(item);
	};
	visit(body);
	return found;
}

function chatStream(text: string): Response {
	const chunk = (delta: Record<string, unknown>, finishReason: string | null) => ({
		id: "chatcmpl-acp-large-image",
		object: "chat.completion.chunk",
		created: 0,
		model: "fixture-model",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	});
	const chunks = [chunk({ role: "assistant", content: text }, null), chunk({}, "stop")];
	return new Response(`${chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

function subprocessInput(proc: AcpProc): WritableStream<Uint8Array> {
	return new WritableStream({
		write(chunk) {
			proc.stdin.write(chunk);
			proc.stdin.flush();
		},
		close() {
			proc.stdin.end();
		},
		abort() {
			proc.stdin.end();
		},
	});
}

function buildChildEnv(root: string): Record<string, string> {
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: root,
		TMPDIR: path.join(root, "tmp"),
		XDG_DATA_HOME: path.join(root, ".local", "share"),
		XDG_CONFIG_HOME: path.join(root, ".config"),
		XDG_STATE_HOME: path.join(root, ".local", "state"),
		XDG_CACHE_HOME: path.join(root, ".cache"),
		XDG_RUNTIME_DIR: path.join(root, ".run"),
		GJC_CODING_AGENT_DIR: path.join(root, "agent"),
		PI_CODING_AGENT_DIR: path.join(root, "agent"),
		PI_NO_TITLE: "1",
		NO_COLOR: "1",
	};
	for (const key of ["LANG", "LC_ALL", "TZ"] as const) {
		const value = process.env[key];
		if (value !== undefined && value !== "") env[key] = value;
	}
	return env;
}

describe("ACP large inline image wire oracle (real subprocess stdio)", () => {
	it("stages a ~1 MB PNG past the SDK frame cap and delivers its exact bytes to the provider", async () => {
		const requests: unknown[] = [];
		const modelServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const url = new URL(request.url);
				if (request.method === "GET" && url.pathname === "/v1/models")
					return Response.json({ data: [{ id: "fixture-model" }] });
				if (request.method !== "POST" || url.pathname !== "/v1/chat/completions")
					return new Response("Not found", { status: 404 });
				requests.push(await request.json());
				return chatStream("Large image received.");
			},
		});
		servers.push(modelServer);

		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "gjc-acp-large-image-wire-"));
		const env = buildChildEnv(root);
		for (const dir of [
			env.HOME,
			env.TMPDIR,
			env.XDG_DATA_HOME,
			env.XDG_CONFIG_HOME,
			env.XDG_STATE_HOME,
			env.XDG_CACHE_HOME,
			env.XDG_RUNTIME_DIR,
			env.GJC_CODING_AGENT_DIR,
		])
			await fs.promises.mkdir(dir!, { recursive: true });
		const workspace = path.join(root, "workspace");
		await fs.promises.mkdir(workspace, { recursive: true });
		const agentDir = path.join(root, "agent");
		await fs.promises.writeFile(
			path.join(agentDir, "models.yml"),
			`providers:\n  fixture:\n    baseUrl: http://127.0.0.1:${modelServer.port}/v1\n    apiKey: fixture-key\n    api: openai-completions\n    models:\n      - id: fixture-model\n        name: Fixture Model\n        input: [text, image]\n        contextWindow: 32768\n        maxTokens: 4096\nprofiles:\n  acp-fixture:\n    display_name: ACP Fixture\n    required_providers: [fixture]\n    model_mapping:\n      default: fixture/fixture-model\n`,
		);

		const started = await withFixtureBrokerEnvironment(() => startFixtureBrokerWithLeaseForTest({ agentDir, env }));
		const cleanup = createFixtureRootCleanup(root, agentDir, started.lease);
		cleanupRoots.push(cleanup);

		const proc = Bun.spawn(
			["bun", "packages/coding-agent/src/cli.ts", "--mode", "acp", "--no-extensions", "--mpreset", "acp-fixture"],
			{ cwd: repoRoot, stdin: "pipe", stdout: "pipe", stderr: "pipe", env },
		);
		let stderr = "";
		const stderrDrain = (async () => {
			const reader = proc.stderr.getReader();
			const decoder = new TextDecoder();
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				if (value) stderr = `${stderr}${decoder.decode(value, { stream: true })}`.slice(-STDERR_CAP);
			}
		})();
		const sessionIds: string[] = [];
		let connection: ClientSideConnection | undefined;
		registerFixtureRuntime(cleanup, {
			key: "acp-large-image-subprocess",
			requiredOwner: "runtime-and-broker",
			shutdown: async () => {
				// The broker-spawned session host outlives the ACP child; retire it before
				// the owned root is removed so it cannot recreate files under it.
				for (const sessionId of sessionIds.splice(0)) await connection?.closeSession({ sessionId });
				try {
					proc.stdin.end();
				} catch {
					// already closed
				}
				const graceful = await Promise.race([proc.exited.then(() => true), Bun.sleep(2_000).then(() => false)]);
				if (!graceful) proc.kill("SIGKILL");
				const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(3_000).then(() => false)]);
				if (!exited) throw new Error(`ACP subprocess did not exit after SIGKILL.\n[child stderr]\n${stderr}`);
			},
			dispose: () => stderrDrain,
		});

		const acp = new ClientSideConnection(() => new OracleClient(), ndJsonStream(subprocessInput(proc), proc.stdout));
		connection = acp;
		const png = noisePng(600, 560);
		expect(png.length).toBeGreaterThan(1_000_000);
		const pngBase64 = png.toString("base64");
		try {
			const initialized = await acp.initialize({ protocolVersion: 1, clientCapabilities: {} });
			expect(initialized.agentCapabilities?.promptCapabilities?.image).toBe(true);
			const { sessionId } = await acp.newSession({ cwd: workspace, mcpServers: [] });
			sessionIds.push(sessionId);
			const response = await acp.prompt({
				sessionId,
				prompt: [
					{ type: "text", text: "Describe this large image." },
					{ type: "image", mimeType: "image/png", data: pngBase64 },
				],
			});
			expect(response.stopReason).toBe("end_turn");
			expect(requests).toHaveLength(1);
			const images = requestImageDataUrls(requests[0]);
			expect(images).toHaveLength(1);
			expect(images[0]!.mimeType).toBe("image/png");
			expect(sha256(Buffer.from(images[0]!.data, "base64"))).toBe(sha256(png));
		} catch (error) {
			throw new Error(`${error instanceof Error ? error.message : String(error)}\n[child stderr]\n${stderr}`);
		}
	}, 90_000);
});
