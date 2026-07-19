import { describe, expect, it } from "bun:test";
import { SessionSdkHost } from "../src/sdk/host/host.js";
import {
	CURSOR_TTL_MS,
	cursorMac,
	MAX_CURSORS_PER_CONNECTION,
	MAX_CURSORS_PER_SESSION,
} from "../src/sdk/host/query/cursor.js";
import { RESPONSE_CEILING_BYTES, TARGET_PAGE_BYTES } from "../src/sdk/host/query/handlers.js";
import {
	MAX_MEMORY_BYTES,
	MAX_PINNED_REVISIONS,
	MAX_REVISIONS_PER_RESOURCE,
	SNAPSHOT_TTL_MS,
} from "../src/sdk/host/query/revision-store.js";
import {
	MAX_REVERSE_OUTSTANDING,
	MAX_REVERSE_PAYLOAD_BYTES,
	REVERSE_HEARTBEAT_MS,
	REVERSE_LEASE_TTL_MS,
} from "../src/sdk/host/reverse-leases.js";
import { OPERATIONS } from "../src/sdk/protocol/operation-registry.js";

const frame = (type: string, fields: Record<string, unknown>): Record<string, unknown> => ({ type, ...fields });
const expectedErrorCodes = [
	"revision_conflict",
	"unknown_operation",
	"invalid_input",
	"busy",
	"resource_gone",
	"unsupported_protocol",
	"provider_lease_conflict",
	"lease_expired",
	"not_lease_owner",
	"endpoint_stale",
	"idempotency_conflict",
	"snapshot_capacity_exceeded",
	"cursor_expired",
	"event_gap",
] as const;

describe("SDK v3 TypeScript/Rust wire conformance", () => {
	it("uses snake_case frame tags and camelCase fields for every v3 family", () => {
		const frames = [
			frame("control_request", {
				id: "c1",
				operation: "turn.prompt",
				input: {},
				expectedRevision: "r1",
				idempotencyKey: "k1",
				confirm: true,
			}),
			frame("control_response", {
				id: "c1",
				ok: false,
				error: { code: "revision_conflict", message: "changed", currentRevision: "r2" },
			}),
			frame("query_request", { id: "q1", query: "transcript.list", input: {}, cursor: "cursor" }),
			frame("query_response", {
				id: "q1",
				ok: true,
				page: {
					items: [{ id: "one" }],
					complete: false,
					continuationCursor: "next",
					revision: "r1",
					preview: true,
				},
			}),
			frame("register_provider", {
				id: "p1",
				connectionId: "conn",
				capability: "host_tools",
				definitions: [],
				expectedLeaseId: "old",
				idempotencyKey: "k2",
			}),
			frame("register_provider_result", {
				leaseId: "lease",
				leaseExpiresAt: "2026-01-01T00:00:15Z",
				registeredNames: ["read"],
			}),
			frame("reverse_request", {
				id: "r1",
				capability: "host_tools",
				connectionId: "conn",
				leaseId: "lease",
				payload: {},
			}),
			frame("reverse_response", { id: "r1", connectionId: "conn", leaseId: "lease", ok: true, result: {} }),
			frame("ephemeral_turn", {
				sessionId: "s1",
				requestId: "turn-1",
				updateId: 1,
				messageId: 2,
				threadId: "thread-1",
				question: "What changed?",
			}),
			frame("ephemeral_turn_cancel", {
				sessionId: "s1",
				requestId: "turn-1",
				updateId: 1,
				messageId: 2,
				threadId: "thread-1",
				reason: "daemon_shutdown",
			}),
			frame("ephemeral_turn_result", {
				sessionId: "s1",
				requestId: "turn-1",
				updateId: 1,
				messageId: 2,
				threadId: "thread-1",
				status: "cancelled",
			}),
			frame("broker_hello", { protocolVersion: 3 }),
			frame("broker_request", { id: "g1", operation: "session.create", input: {}, idempotencyKey: "k3" }),
			frame("broker_response", { id: "g1", ok: true, result: {}, indexSeq: 1 }),
		];
		for (const candidate of frames) {
			expect(String(candidate.type)).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
			expect(JSON.stringify(candidate)).not.toMatch(/"[a-z]+_[a-z]+"\s*:/);
		}
		expect(frames[3].page).toEqual({
			items: [{ id: "one" }],
			complete: false,
			continuationCursor: "next",
			revision: "r1",
			preview: true,
		});
	});

	it("tolerates unknown frames at the TypeScript session host boundary", async () => {
		let receive: ((connectionId: string, value: Record<string, unknown>) => void) | undefined;
		const sent: Record<string, unknown>[] = [];
		const host = new SessionSdkHost({
			sessionId: "s",
			stateRoot: "/tmp",
			token: "token",
			sendFrame: (_connectionId, value) => {
				sent.push(value);
			},
			onFrame: handler => {
				receive = handler;
				return () => {};
			},
		});
		await host.start();
		expect(() => receive?.("connection", { type: "future_v4_frame", futureField: true })).not.toThrow();
		await Promise.resolve();
		expect(sent).toEqual([]);
		await host.stop();
	});

	it("keeps the shared error-code vocabulary and cursor MAC fixture stable", () => {
		expect(expectedErrorCodes).toEqual([
			"revision_conflict",
			"unknown_operation",
			"invalid_input",
			"busy",
			"resource_gone",
			"unsupported_protocol",
			"provider_lease_conflict",
			"lease_expired",
			"not_lease_owner",
			"endpoint_stale",
			"idempotency_conflict",
			"snapshot_capacity_exceeded",
			"cursor_expired",
			"event_gap",
		]);
		const registryCodes = new Set(OPERATIONS.flatMap(operation => operation.errorCodes));
		for (const code of ["revision_conflict", "busy", "resource_gone"]) expect(registryCodes.has(code)).toBe(true);
		const envelope = {
			cursorVersion: 1 as const,
			protocolMajor: 3 as const,
			sessionId: "s1",
			resource: "transcript",
			revision: "r1",
			highWatermark: 12,
			position: { offset: 4 },
			direction: "forward",
			pageShape: { limit: 10 },
		};
		expect(cursorMac(envelope, "session-token")).toBe(
			"4b4d7428b20b857fad243e40105cec6f11a1299fcf526fd7f2718fd77b8c86fa",
		);
	});

	it("exposes the v3 pagination, MVCC, and reverse lease bounds", () => {
		expect([
			RESPONSE_CEILING_BYTES,
			TARGET_PAGE_BYTES,
			CURSOR_TTL_MS / 1000,
			MAX_CURSORS_PER_CONNECTION,
			MAX_CURSORS_PER_SESSION,
		]).toEqual([1024 * 1024, 256 * 1024, 900, 32, 128]);
		expect([MAX_REVISIONS_PER_RESOURCE, MAX_PINNED_REVISIONS, MAX_MEMORY_BYTES]).toEqual([8, 128, 16 * 1024 * 1024]);
		expect(SNAPSHOT_TTL_MS).toBe(15 * 60 * 1000);
		expect([
			REVERSE_LEASE_TTL_MS / 1000,
			REVERSE_HEARTBEAT_MS / 1000,
			MAX_REVERSE_OUTSTANDING,
			MAX_REVERSE_PAYLOAD_BYTES,
		]).toEqual([15, 5, 64, 256 * 1024]);
	});
});
