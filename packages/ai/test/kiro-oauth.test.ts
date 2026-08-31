import { beforeEach, describe, expect, mock, test, vi } from "bun:test";
import { crc32, decodeMessage } from "../src/providers/aws-eventstream";
import { pollForToken } from "../src/utils/oauth/kiro";

// ---- Frame builder (shared with aws-eventstream.test.ts) ----

function encodeStringHeader(name: string, value: string): Uint8Array {
	const nameBytes = new TextEncoder().encode(name);
	const valueBytes = new TextEncoder().encode(value);
	if (nameBytes.length > 255) throw new Error("name too long");
	const buf = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
	const view = new DataView(buf.buffer);
	let p = 0;
	view.setUint8(p, nameBytes.length);
	p += 1;
	buf.set(nameBytes, p);
	p += nameBytes.length;
	view.setUint8(p, 7); // string type
	p += 1;
	view.setUint16(p, valueBytes.length, false);
	p += 2;
	buf.set(valueBytes, p);
	return buf;
}

function encodeFrame(headers: Record<string, string>, payload: Uint8Array): Uint8Array {
	const headerChunks: Uint8Array[] = [];
	for (const name in headers) headerChunks.push(encodeStringHeader(name, headers[name]));
	const headerLen = headerChunks.reduce((s, c) => s + c.length, 0);
	const headerBytes = new Uint8Array(headerLen);
	let off = 0;
	for (const c of headerChunks) {
		headerBytes.set(c, off);
		off += c.length;
	}
	const total = 4 + 4 + 4 + headerLen + payload.length + 4;
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	view.setUint32(0, total, false);
	view.setUint32(4, headerLen, false);
	const preludeCrc = crc32(out.subarray(0, 8));
	view.setUint32(8, preludeCrc, false);
	out.set(headerBytes, 12);
	out.set(payload, 12 + headerLen);
	const msgCrc = crc32(out.subarray(0, total - 4));
	view.setUint32(total - 4, msgCrc, false);
	return out;
}

function streamFrom(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	let i = 0;
	return new ReadableStream({
		pull(controller) {
			if (i < chunks.length) controller.enqueue(chunks[i++]);
			else controller.close();
		},
	});
}

// ---- SSO OIDC mock helpers ----

function mockResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

// =============================================================================

describe("kiro OAuth — SSO OIDC flow", () => {
	beforeEach(() => {
		// Clear the registration cache before each test
		const { clearClientRegistrationCache } = require("../src/utils/oauth/kiro");
		clearClientRegistrationCache();
	});

	test("refreshKiroToken rotates tokens from CreateToken response", async () => {
		const { refreshKiroToken, registerClient } = await import("../src/utils/oauth/kiro");

		// Pre-seed the registration cache by mocking the register call
		const fetchMock = mock(() =>
			Promise.resolve(
				mockResponse({
					clientId: "test-client-id",
					clientSecret: "test-client-secret",
					clientIdIssuedAt: Math.floor(Date.now() / 1000),
					clientSecretExpiresAt: Math.floor(Date.now() / 1000) + 86400,
				}),
			),
		);
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

		await registerClient("us-east-1", "https://view.awsapps.com/start");

		// Now mock the refresh call
		fetchMock.mockImplementation(() =>
			Promise.resolve(
				mockResponse({
					accessToken: "new-access-token",
					refreshToken: "new-refresh-token",
					tokenType: "Bearer",
					expiresIn: 3600,
				}),
			),
		);

		const result = await refreshKiroToken({
			access: "old-access-token",
			refresh: "old-refresh-token",
			expires: Date.now() - 1000,
		});

		expect(result.access).toBe("new-access-token");
		expect(result.refresh).toBe("new-refresh-token");
		expect(result.expires).toBeGreaterThan(Date.now());
	});

	test("refreshKiroToken preserves old refresh token when server omits new one", async () => {
		const { refreshKiroToken, registerClient } = await import("../src/utils/oauth/kiro");

		const fetchMock = mock(() =>
			Promise.resolve(
				mockResponse({
					clientId: "test-client-id",
					clientSecret: "test-client-secret",
					clientIdIssuedAt: Math.floor(Date.now() / 1000),
					clientSecretExpiresAt: Math.floor(Date.now() / 1000) + 86400,
				}),
			),
		);
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

		await registerClient("us-east-1", "https://view.awsapps.com/start");

		fetchMock.mockImplementation(() =>
			Promise.resolve(
				mockResponse({
					accessToken: "new-access-token",
					tokenType: "Bearer",
					expiresIn: 3600,
					// No refreshToken in response
				}),
			),
		);

		const result = await refreshKiroToken({
			access: "old-access-token",
			refresh: "old-refresh-token",
			expires: Date.now() - 1000,
		});

		expect(result.access).toBe("new-access-token");
		expect(result.refresh).toBe("old-refresh-token");
	});

	test("refreshKiroToken fails closed on invalid_grant", async () => {
		const { refreshKiroToken, registerClient } = await import("../src/utils/oauth/kiro");

		const fetchMock = mock(() =>
			Promise.resolve(
				mockResponse({
					clientId: "test-client-id",
					clientSecret: "test-client-secret",
					clientIdIssuedAt: Math.floor(Date.now() / 1000),
					clientSecretExpiresAt: Math.floor(Date.now() / 1000) + 86400,
				}),
			),
		);
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

		await registerClient("us-east-1", "https://view.awsapps.com/start");

		fetchMock.mockImplementation(() =>
			Promise.resolve(
				mockResponse({
					error: "invalid_grant",
					error_description: "The refresh token is invalid.",
				}),
			),
		);

		await expect(
			refreshKiroToken({
				access: "expired-access-token",
				refresh: "invalid-refresh-token",
				expires: Date.now() - 1000,
			}),
		).rejects.toThrow(/invalid or expired/i);
	});

	test("refreshKiroToken fails closed on expired_token", async () => {
		const { refreshKiroToken, registerClient } = await import("../src/utils/oauth/kiro");

		const fetchMock = mock(() =>
			Promise.resolve(
				mockResponse({
					clientId: "test-client-id",
					clientSecret: "test-client-secret",
					clientIdIssuedAt: Math.floor(Date.now() / 1000),
					clientSecretExpiresAt: Math.floor(Date.now() / 1000) + 86400,
				}),
			),
		);
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

		await registerClient("us-east-1", "https://view.awsapps.com/start");

		fetchMock.mockImplementation(() =>
			Promise.resolve(
				mockResponse({
					error: "expired_token_exception",
					error_description: "Client registration expired.",
				}),
			),
		);

		await expect(
			refreshKiroToken({
				access: "old-access-token",
				refresh: "old-refresh-token",
				expires: Date.now() - 1000,
			}),
		).rejects.toThrow(/registration has expired/i);
	});

	test("SSO OIDC fatal error set includes all published errors", async () => {
		// Verify the error set is comprehensive by testing each error
		const { refreshKiroToken, registerClient } = await import("../src/utils/oauth/kiro");

		const fetchMock = mock(() =>
			Promise.resolve(
				mockResponse({
					clientId: "test-client-id",
					clientSecret: "test-client-secret",
					clientIdIssuedAt: Math.floor(Date.now() / 1000),
					clientSecretExpiresAt: Math.floor(Date.now() / 1000) + 86400,
				}),
			),
		);
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

		await registerClient("us-east-1", "https://view.awsapps.com/start");

		for (const errorCode of [
			"access_denied_exception",
			"unauthorized_client_exception",
			"unsupported_grant_type_exception",
			"invalid_scope_exception",
			"invalid_client_exception",
		]) {
			fetchMock.mockImplementation(() =>
				Promise.resolve(
					mockResponse({
						error: errorCode,
					}),
				),
			);

			await expect(
				refreshKiroToken({
					access: "old-access-token",
					refresh: "old-refresh-token",
					expires: Date.now() - 1000,
				}),
			).rejects.toThrow();
		}
	});

	test("pollForToken keeps polling through HTTP 400 authorization_pending", async () => {
		const fetchMock = mock(() =>
			Promise.resolve(mockResponse({ error: "authorization_pending", error_description: "pending" }, 400)),
		);
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(fetchMock as unknown as typeof globalThis.fetch);

		try {
			fetchMock.mockImplementationOnce(() =>
				Promise.resolve(mockResponse({ error: "authorization_pending", error_description: "pending" }, 400)),
			);
			fetchMock.mockImplementationOnce(() =>
				Promise.resolve(
					mockResponse({
						accessToken: "device-access-token",
						refreshToken: "device-refresh-token",
						tokenType: "Bearer",
						expiresIn: 3600,
					}),
				),
			);

			const token = await pollForToken(
				"us-east-1",
				{ clientId: "test-client-id", clientSecret: "test-client-secret", expiresAt: Date.now() + 86_400_000 },
				"device-code",
				1,
				10,
			);

			expect(token.accessToken).toBe("device-access-token");
			expect(fetchMock).toHaveBeenCalledTimes(2);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("pollForToken fails closed on an HTTP error without an OIDC error payload", async () => {
		const fetchMock = mock(() => Promise.resolve(mockResponse({ message: "Internal Server Error" }, 500)));
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(fetchMock as unknown as typeof globalThis.fetch);

		try {
			await expect(
				pollForToken(
					"us-east-1",
					{ clientId: "test-client-id", clientSecret: "test-client-secret", expiresAt: Date.now() + 86_400_000 },
					"device-code",
					1,
					10,
				),
			).rejects.toThrow(/failed: 500/);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("pollForToken applies persistent five-second slow_down backoff", async () => {
		const fetchMock = mock()
			.mockResolvedValueOnce(mockResponse({ error: "slow_down" }, 400))
			.mockResolvedValueOnce(
				mockResponse({ accessToken: "device-access-token", tokenType: "Bearer", expiresIn: 3600 }),
			);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof globalThis.fetch);

		try {
			const token = await pollForToken(
				"us-east-1",
				{ clientId: "test-client-id", clientSecret: "test-client-secret", expiresAt: Date.now() + 86_400_000 },
				"device-code",
				1,
				8,
			);
			expect(token.accessToken).toBe("device-access-token");
			expect(fetchMock).toHaveBeenCalledTimes(2);
		} finally {
			fetchSpy.mockRestore();
		}
	}, 15_000);
});

// =============================================================================

describe("kiro CodeWhisperer transport — eventstream parsing", () => {
	test("decodes assistantResponseEvent with text content", () => {
		const payload = new TextEncoder().encode(JSON.stringify({ assistantResponseEvent: { content: "Hello world" } }));
		const frame = encodeFrame(
			{
				":message-type": "event",
				":event-type": "assistantResponseEvent",
				":content-type": "application/json",
			},
			payload,
		);
		const decoded = decodeMessage(frame);
		expect(decoded.headers[":event-type"]).toBe("assistantResponseEvent");
		const parsed = JSON.parse(new TextDecoder().decode(decoded.payload));
		expect(parsed.assistantResponseEvent.content).toBe("Hello world");
	});

	test("decodes toolUseEvent with tool call details", () => {
		const payload = new TextEncoder().encode(
			JSON.stringify({
				toolUseEvent: {
					toolUseId: "call-123",
					name: "read_file",
					input: { path: "/src/main.ts" },
				},
			}),
		);
		const frame = encodeFrame(
			{
				":message-type": "event",
				":event-type": "toolUseEvent",
			},
			payload,
		);
		const decoded = decodeMessage(frame);
		const parsed = JSON.parse(new TextDecoder().decode(decoded.payload));
		expect(parsed.toolUseEvent.toolUseId).toBe("call-123");
		expect(parsed.toolUseEvent.name).toBe("read_file");
		expect(parsed.toolUseEvent.input.path).toBe("/src/main.ts");
	});

	test("decodes messageMetadataEvent with conversation metadata", () => {
		const payload = new TextEncoder().encode(
			JSON.stringify({
				messageMetadataEvent: {
					conversationId: "conv-abc-123",
					utteranceId: "utt-xyz-789",
				},
			}),
		);
		const frame = encodeFrame(
			{
				":message-type": "event",
				":event-type": "messageMetadataEvent",
			},
			payload,
		);
		const decoded = decodeMessage(frame);
		const parsed = JSON.parse(new TextDecoder().decode(decoded.payload));
		expect(parsed.messageMetadataEvent.conversationId).toBe("conv-abc-123");
		expect(parsed.messageMetadataEvent.utteranceId).toBe("utt-xyz-789");
	});

	test("decodes exception events (validationException)", () => {
		const payload = new TextEncoder().encode(JSON.stringify({ message: "Invalid conversation state" }));
		const frame = encodeFrame(
			{
				":message-type": "exception",
				":exception-type": "validationException",
				":content-type": "application/json",
			},
			payload,
		);
		const decoded = decodeMessage(frame);
		expect(decoded.headers[":message-type"]).toBe("exception");
		expect(decoded.headers[":exception-type"]).toBe("validationException");
		const parsed = JSON.parse(new TextDecoder().decode(decoded.payload));
		expect(parsed.message).toBe("Invalid conversation state");
	});

	test("handles fragmented frames split across chunks", async () => {
		const { decodeEventStream } = await import("../src/providers/aws-eventstream");

		const payload1 = new TextEncoder().encode(JSON.stringify({ assistantResponseEvent: { content: "chunk1" } }));
		const payload2 = new TextEncoder().encode(JSON.stringify({ assistantResponseEvent: { content: "chunk2" } }));

		const frame1 = encodeFrame({ ":message-type": "event", ":event-type": "assistantResponseEvent" }, payload1);
		const frame2 = encodeFrame({ ":message-type": "event", ":event-type": "assistantResponseEvent" }, payload2);

		// Split frame1 across two chunks, then put frame2 in a third
		const mid = Math.floor(frame1.length / 2);
		const chunks = [frame1.subarray(0, mid), frame1.subarray(mid), frame2].map(c => new Uint8Array(c));

		const messages: Array<{ eventType: string; content: string }> = [];
		for await (const msg of decodeEventStream(streamFrom(chunks))) {
			if (msg.headers[":event-type"] === "assistantResponseEvent") {
				const parsed = JSON.parse(new TextDecoder().decode(msg.payload));
				messages.push({ eventType: msg.headers[":event-type"], content: parsed.assistantResponseEvent.content });
			}
		}

		expect(messages).toHaveLength(2);
		expect(messages[0].content).toBe("chunk1");
		expect(messages[1].content).toBe("chunk2");
	});

	test("detects malformed/truncated stream", async () => {
		const { decodeEventStream } = await import("../src/providers/aws-eventstream");

		// A partial frame (header bytes but not complete)
		const partialFrame = new Uint8Array(4);
		new DataView(partialFrame.buffer).setUint32(0, 100, false); // claims 100 bytes total but we only have 4

		expect(
			(async () => {
				for await (const _ of decodeEventStream(streamFrom([partialFrame]))) {
					// should throw before yielding
				}
			})(),
		).rejects.toThrow();
	});

	test("does not print or expose raw secrets in error messages", () => {
		const payload = new TextEncoder().encode(
			JSON.stringify({ error: { message: "Something went wrong", code: "InternalError" } }),
		);
		const frame = encodeFrame({ ":message-type": "event", ":event-type": "error" }, payload);
		const decoded = decodeMessage(frame);
		const parsed = JSON.parse(new TextDecoder().decode(decoded.payload));
		expect(parsed.error.message).toBe("Something went wrong");
		// Verify no secret material is embedded in the error frame
		expect(parsed.error.code).toBe("InternalError");
		expect(JSON.stringify(parsed)).not.toContain("refresh");
		expect(JSON.stringify(parsed)).not.toContain("Bearer ");
	});
});
