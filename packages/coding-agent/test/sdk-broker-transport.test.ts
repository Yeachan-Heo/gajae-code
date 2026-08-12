import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { Broker, type BrokerResponse } from "../src/sdk/broker/broker";
import { deriveIdempotencyIdentity } from "../src/sdk/broker/identity";
import { brokerShutdownSendAction } from "../src/sdk/broker/transport";
import { SdkClient } from "../src/sdk/client/client";

async function nextFrame(ws: WebSocket): Promise<Record<string, unknown>> {
	return await new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("Timed out waiting for broker frame")), 2_000);
		ws.addEventListener(
			"message",
			event => {
				clearTimeout(timeout);
				resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
			},
			{ once: true },
		);
		ws.addEventListener(
			"error",
			() => {
				clearTimeout(timeout);
				reject(new Error("Broker WebSocket error"));
			},
			{ once: true },
		);
		ws.addEventListener(
			"close",
			event => {
				clearTimeout(timeout);
				reject(new Error(`Broker WebSocket closed (${event.code})`));
			},
			{ once: true },
		);
	});
}
async function connect(url: string): Promise<WebSocket> {
	const ws = new WebSocket(url);
	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve(), { once: true });
		ws.addEventListener("error", () => reject(new Error("Broker WebSocket error")), { once: true });
	});
	return ws;
}

function lifecycleFingerprint(operation: string, input: Record<string, unknown>): string {
	return createHash("sha256").update(JSON.stringify({ operation, input })).digest("hex");
}

type TerminalLifecycleState = "terminal_ok" | "terminal_error" | "terminal_uncertain";

async function persistLifecycleOutcome(
	broker: Broker,
	input: {
		operation: string;
		idempotencyKey: string;
		request: Record<string, unknown>;
		state: TerminalLifecycleState;
		response?: BrokerResponse;
	},
): Promise<string> {
	const fingerprint = lifecycleFingerprint(input.operation, input.request);
	const identity = await deriveIdempotencyIdentity(broker.settings.agentDir, input.operation, input.idempotencyKey);
	const begun = await broker.ledger.begin(identity, `lookup-${input.idempotencyKey}`, {
		operationKey: `${input.operation}\0${input.idempotencyKey}`,
		fingerprint,
	});
	if (begun.kind !== "new") throw new Error(`Expected a new lifecycle ledger entry, received ${begun.kind}`);
	await broker.ledger.transition(identity, input.state, {
		...(input.response === undefined ? {} : { response: input.response }),
	});
	return fingerprint;
}

async function lookupLifecycle(
	ws: WebSocket,
	input: { id: string; operation: string; idempotencyKey?: string; fingerprint?: string },
): Promise<Record<string, unknown>> {
	const response = nextFrame(ws);
	ws.send(
		JSON.stringify({
			type: "broker_request",
			id: input.id,
			operation: "broker.lookup_lifecycle",
			input: {
				operation: input.operation,
				...(input.fingerprint === undefined ? {} : { fingerprint: input.fingerprint }),
			},
			...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
		}),
	);
	return await response;
}
describe("SDK broker WebSocket transport", () => {
	it("fails closed for dropped shutdown acknowledgements and waits for backpressure drain", () => {
		expect(brokerShutdownSendAction(0)).toBe("dropped");
		expect(brokerShutdownSendAction(-1)).toBe("wait_for_drain");
		expect(brokerShutdownSendAction(1)).toBe("close");
	});
	it("uses Rust-compatible request and response frames", async () => {
		const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-transport-"));
		const broker = new Broker({ agentDir, packageGeneration: "test" });
		const discovery = await broker.start();
		try {
			expect(JSON.parse(await fs.readFile(path.join(agentDir, "sdk", "broker.json"), "utf8"))).toMatchObject({
				port: discovery.port,
				url: discovery.url,
			});
			const wrong = new WebSocket(`${discovery.url}/?token=wrong`);
			await new Promise<void>(resolve => wrong.addEventListener("close", () => resolve(), { once: true }));
			const ws = await connect(`${discovery.url}/?token=${discovery.token}`);
			expect(await nextFrame(ws)).toEqual({ type: "broker_hello", protocolVersion: 3 });
			ws.send("{");
			expect(await nextFrame(ws)).toEqual({
				type: "broker_response",
				ok: false,
				error: { code: "invalid_input", message: "malformed JSON" },
			});
			const request = { type: "broker_request", id: "list", operation: "session.list", input: {} };
			expect(JSON.stringify(request)).toBe(
				'{"type":"broker_request","id":"list","operation":"session.list","input":{}}',
			);
			ws.send(JSON.stringify(request));
			expect(await nextFrame(ws)).toEqual({
				type: "broker_response",
				id: "list",
				ok: true,
				result: { indexSeq: 0, sessions: [], warnings: [] },
				indexSeq: 0,
			});
			ws.send(
				JSON.stringify({
					type: "broker_request",
					id: "create",
					operation: "session.create",
					input: {},
					idempotencyKey: "key",
				}),
			);
			expect(await nextFrame(ws)).toEqual({
				type: "broker_response",
				id: "create",
				ok: false,
				error: { code: "invalid_input", message: "A target path is required." },
			});
			ws.close();
		} finally {
			await broker.stop();
		}
	});
	it("dispatches durable lifecycle lookup outcomes through the broker transport", async () => {
		const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-lookup-"));
		const broker = new Broker({ agentDir, packageGeneration: "test" });
		const discovery = await broker.start();
		try {
			const createInput = { cwd: "/workspace/create" };
			const createFingerprint = await persistLifecycleOutcome(broker, {
				operation: "session.create",
				idempotencyKey: "lookup-ok",
				request: createInput,
				state: "terminal_ok",
				response: { ok: true, result: { sessionId: "created" } },
			});
			const closeInput = { sessionId: "closed" };
			const closeFingerprint = lifecycleFingerprint("session.close", closeInput);
			expect(await broker.handleRequest("session.close", closeInput, "lookup-error")).toEqual({
				ok: false,
				error: { code: "not_found", message: "session is not indexed" },
			});
			const closeIdentity = await deriveIdempotencyIdentity(
				broker.settings.agentDir,
				"session.close",
				"lookup-error",
			);
			expect(broker.ledger.get(closeIdentity)).toMatchObject({
				operationKey: "session.close\0lookup-error",
				fingerprint: closeFingerprint,
				state: "terminal_error",
			});
			const deleteInput = { sessionId: "uncertain" };
			const deleteFingerprint = await persistLifecycleOutcome(broker, {
				operation: "session.delete",
				idempotencyKey: "lookup-uncertain",
				request: deleteInput,
				state: "terminal_uncertain",
			});

			const ws = await connect(`${discovery.url}/?token=${discovery.token}`);
			try {
				expect(await nextFrame(ws)).toEqual({ type: "broker_hello", protocolVersion: 3 });
				expect(
					await lookupLifecycle(ws, {
						id: "lookup-ok",
						operation: "session.create",
						idempotencyKey: "lookup-ok",
						fingerprint: createFingerprint,
					}),
				).toEqual({ type: "broker_response", id: "lookup-ok", ok: true, result: { sessionId: "created" } });
				expect(
					await lookupLifecycle(ws, {
						id: "lookup-error",
						operation: "session.close",
						idempotencyKey: "lookup-error",
						fingerprint: closeFingerprint,
					}),
				).toEqual({
					type: "broker_response",
					id: "lookup-error",
					ok: false,
					error: { code: "not_found", message: "session is not indexed" },
				});
				expect(
					await lookupLifecycle(ws, {
						id: "lookup-uncertain",
						operation: "session.delete",
						idempotencyKey: "lookup-uncertain",
						fingerprint: deleteFingerprint,
					}),
				).toEqual({
					type: "broker_response",
					id: "lookup-uncertain",
					ok: false,
					error: { code: "terminal_uncertain", message: "lifecycle outcome is still uncertain" },
				});
				expect(
					await lookupLifecycle(ws, {
						id: "lookup-conflict",
						operation: "session.create",
						idempotencyKey: "lookup-ok",
						fingerprint: "f".repeat(64),
					}),
				).toEqual({
					type: "broker_response",
					id: "lookup-conflict",
					ok: false,
					error: { code: "idempotency_conflict", message: "lifecycle request fingerprint differs" },
				});
				expect(
					await lookupLifecycle(ws, {
						id: "lookup-missing",
						operation: "session.create",
						idempotencyKey: "lookup-missing",
						fingerprint: createFingerprint,
					}),
				).toEqual({
					type: "broker_response",
					id: "lookup-missing",
					ok: false,
					error: { code: "not_found", message: "lifecycle operation was not found" },
				});
				expect(
					await lookupLifecycle(ws, {
						id: "lookup-invalid",
						operation: "session.create",
						fingerprint: createFingerprint,
					}),
				).toEqual({
					type: "broker_response",
					id: "lookup-invalid",
					ok: false,
					error: { code: "invalid_input", message: "operation, idempotencyKey, and fingerprint are required" },
				});
			} finally {
				ws.close();
			}
			const client = await SdkClient.connect(discovery.url, discovery.token, { reconnectAttempts: 0 });
			try {
				expect(
					await client.lookupLifecycle({
						id: "sent-create",
						operation: "session.create",
						idempotencyKey: "lookup-ok",
						fingerprint: createFingerprint,
					}),
				).toMatchObject({ ok: true, result: { sessionId: "created" } });
			} finally {
				await client.close();
			}
		} finally {
			await broker.stop();
		}
	});
	it("hashes lifecycle wire fingerprints before retaining secret-bearing large inputs", async () => {
		const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-digest-"));
		const broker = new Broker({ agentDir, packageGeneration: "test" });
		const discovery = await broker.start();
		const secret = "mcp-credential-not-for-ledger";
		const input = {
			sessionId: "secret-lifecycle-input",
			mcp: {
				headers: { authorization: `Bearer ${secret}` },
				env: { MCP_TOKEN: secret },
			},
			padding: "x".repeat(2 * 1024 * 1024),
		};
		const expectedFingerprint = createHash("sha256")
			.update(JSON.stringify({ operation: "session.close", input }))
			.digest("hex");
		const request = JSON.stringify({
			type: "broker_request",
			id: "large-secret-lifecycle",
			operation: "session.close",
			input,
			idempotencyKey: "large-secret-lifecycle",
		});
		expect(Buffer.byteLength(request)).toBeGreaterThan(2 * 1024 * 1024);
		expect(Buffer.byteLength(request)).toBeLessThan(4 * 1024 * 1024);
		const ws = await connect(`${discovery.url}/?token=${discovery.token}`);
		try {
			expect(await nextFrame(ws)).toEqual({ type: "broker_hello", protocolVersion: 3 });
			const response = nextFrame(ws);
			ws.send(request);
			expect(await response).toEqual({
				type: "broker_response",
				id: "large-secret-lifecycle",
				ok: false,
				error: { code: "not_found", message: "session is not indexed" },
			});
			const ledger = await fs.readFile(path.join(agentDir, "sdk", "lifecycle-ledger.jsonl"), "utf8");
			expect(ledger).not.toContain(secret);
			expect(ledger).not.toContain(input.padding.slice(0, 128));
			expect(Buffer.byteLength(ledger)).toBeLessThan(4 * 1024);
			const rows = ledger
				.trimEnd()
				.split("\n")
				.map(line => JSON.parse(line) as { fingerprint?: unknown });
			expect(rows).toHaveLength(2);
			for (const row of rows) {
				expect(row.fingerprint).toBe(expectedFingerprint);
				expect(row.fingerprint).toMatch(/^[a-f0-9]{64}$/);
			}
		} finally {
			ws.close();
			await broker.stop();
		}
	});
	it("accepts authenticated shutdown and removes discovery before completion", async () => {
		const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-shutdown-"));
		const broker = new Broker({ agentDir, packageGeneration: "test" });
		const discovery = await broker.start();

		const ws = await connect(`${discovery.url}/?token=${discovery.token}`);
		expect(await nextFrame(ws)).toEqual({ type: "broker_hello", protocolVersion: 3 });
		ws.send(JSON.stringify({ type: "broker_request", id: "shutdown", operation: "broker.shutdown", input: {} }));
		expect(await nextFrame(ws)).toEqual({
			type: "broker_response",
			id: "shutdown",
			ok: true,
			result: { accepted: true },
		});

		await broker.completion;
		expect(await Bun.file(path.join(agentDir, "sdk", "broker.json")).exists()).toBe(false);
	});
	it("rejects oversized frames without disrupting other authenticated clients", async () => {
		const agentDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-broker-transport-"));
		const broker = new Broker({ agentDir, packageGeneration: "test" });
		const discovery = await broker.start();
		try {
			const oversizedClient = await connect(`${discovery.url}/?token=${discovery.token}`);
			expect(await nextFrame(oversizedClient)).toEqual({ type: "broker_hello", protocolVersion: 3 });
			const healthyClient = await connect(`${discovery.url}/?token=${discovery.token}`);
			expect(await nextFrame(healthyClient)).toEqual({ type: "broker_hello", protocolVersion: 3 });
			const oversizedFrame = JSON.stringify({
				type: "broker_request",
				id: "too-large",
				operation: "session.list",
				input: { padding: "x".repeat(4 * 1024 * 1024) },
			});
			expect(Buffer.byteLength(oversizedFrame)).toBeGreaterThan(4 * 1024 * 1024);
			const oversizedResponse = nextFrame(oversizedClient);
			oversizedClient.send(oversizedFrame);
			expect(await oversizedResponse).toEqual({
				type: "broker_response",
				ok: false,
				error: { code: "payload_too_large", message: "broker JSON frame exceeds 4 MiB limit" },
			});
			healthyClient.send(
				JSON.stringify({ type: "broker_request", id: "healthy-list", operation: "session.list", input: {} }),
			);
			expect(await nextFrame(healthyClient)).toEqual({
				type: "broker_response",
				id: "healthy-list",
				ok: true,
				result: { indexSeq: 0, sessions: [], warnings: [] },
				indexSeq: 0,
			});
			oversizedClient.close();
			healthyClient.close();
		} finally {
			await broker.stop();
		}
	});
});
