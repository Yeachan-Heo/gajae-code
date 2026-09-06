import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as brokerEnsure from "../src/sdk/broker/ensure";
import { resolveSessionLocator } from "../src/sdk/broker/session-index";
import { resolveScopeRequest } from "../src/sdk/broker/session-scope";
import { lifecycleRequestTimeoutMs } from "../src/sdk/broker/startup-budget";
import { SdkClient } from "../src/sdk/client/client";
import * as sdkDiscovery from "../src/sdk/client/discovery";
import {
	AgentDirSessionLifecycleService,
	deriveSessionLifecycleIdempotencyKey,
	type SessionLifecycleClient,
	type SessionLifecycleClientRequestOptions,
	type SessionLifecycleOperation,
	SessionLifecycleService,
	type SessionReconcileUncertainTarget,
	validateSessionLifecycleMutationRequest,
} from "../src/sdk/lifecycle";
import { AgentDirSessionLifecycleClient } from "../src/sdk/lifecycle/broker-client";

type Call = {
	operation: SessionLifecycleOperation;
	input: Record<string, unknown>;
	options: SessionLifecycleClientRequestOptions;
};

class FakeLifecycleClient implements SessionLifecycleClient {
	readonly calls: Call[] = [];
	response: unknown = { ok: true, result: { sessionId: "session-1" } };
	failure: Error | undefined;
	responses: unknown[] = [];

	async global(
		operation: SessionLifecycleOperation,
		input: Record<string, unknown>,
		options: SessionLifecycleClientRequestOptions,
	): Promise<unknown> {
		this.calls.push({ operation, input, options });
		if (this.failure) throw this.failure;
		return this.responses.length > 0 ? this.responses.shift() : this.response;
	}
}

const actor = { id: "operator-1", namespace: "telegram:account-1" } as const;
const target = { cwd: "/repo" } as const;
const savedTranscriptIdentity = {
	dev: "1",
	ino: "2",
	nlink: "1",
	size: 3,
	mtimeMs: 4,
	mtimeNs: "4000000",
	ctimeNs: "5000000",
	sha256: "a".repeat(64),
} as const;

function serviceWith(response: unknown = { ok: true, result: { sessionId: "session-1" } }): {
	service: SessionLifecycleService;
	client: FakeLifecycleClient;
} {
	const client = new FakeLifecycleClient();
	client.response = response;
	return { service: new SessionLifecycleService(client), client };
}

describe("SessionLifecycleService", () => {
	it("rejects an unauthorized capability without calling the client", async () => {
		const { service, client } = serviceWith();
		const result = await service.execute({
			operation: "session.create",
			actor,
			capability: "session.close",
			requestKey: "request-1",
			target,
		} as never);
		expect(result).toMatchObject({ ok: false, certainty: "terminal", error: { code: "capability_denied" } });
		expect(client.calls).toHaveLength(0);
	});

	it("derives deterministic keys while separating actor, request, and operation identity", async () => {
		const first = serviceWith();
		const second = serviceWith();
		await first.service.create({ actor, capability: "session.create", requestKey: "request-1", target });
		await second.service.create({ actor, capability: "session.create", requestKey: "request-1", target });
		expect(first.client.calls[0]?.options.idempotencyKey).toBe(second.client.calls[0]?.options.idempotencyKey);
		expect(first.client.calls[0]?.options.idempotencyKey).toBe(
			deriveSessionLifecycleIdempotencyKey(actor, "request-1", "session.create"),
		);

		const actorKey = deriveSessionLifecycleIdempotencyKey(
			{ ...actor, id: "operator-2" },
			"request-1",
			"session.create",
		);
		const requestKey = deriveSessionLifecycleIdempotencyKey(actor, "request-2", "session.create");
		const operationKey = deriveSessionLifecycleIdempotencyKey(actor, "request-1", "session.fork");
		expect(new Set([first.client.calls[0]?.options.idempotencyKey, actorKey, requestKey, operationKey]).size).toBe(4);
	});

	it("maps every lifecycle operation to its Broker operation and input", async () => {
		const { service, client } = serviceWith();
		await service.create({ actor, capability: "session.create", requestKey: "create", target: { cwd: "/create" } });
		await service.fork({
			actor,
			capability: "session.fork",
			requestKey: "fork",
			target: { cwd: "/fork", sourceSessionId: "source" },
		});
		await service.resume({
			actor,
			capability: "session.resume",
			requestKey: "resume",
			target: { sessionId: "resume-session" },
		});
		await service.close({
			actor,
			capability: "session.close",
			requestKey: "close",
			target: { sessionId: "close-session" },
		});
		await service.delete({
			actor,
			capability: "session.delete",
			requestKey: "delete",
			target: { sessionId: "delete-session" },
		});
		client.response = { ok: true, result: { indexSeq: 7, sessions: [], warnings: [] } };
		await service.list({ actor, capability: "session.list" });
		expect(client.calls.map(call => call.operation)).toEqual([
			"session.create",
			"session.fork",
			"session.resume",
			"session.close",
			"session.delete",
			"session.list",
		]);
		expect(client.calls.map(call => call.input)).toEqual([
			{ cwd: "/create" },
			{ cwd: "/fork", sourceSessionId: "source" },
			{ sessionId: "resume-session" },
			{ sessionId: "close-session" },
			{ sessionId: "delete-session" },
			{},
		]);
		expect(client.calls.at(-1)?.options).not.toHaveProperty("idempotencyKey");
	});
	it("aggregates every Broker session.list page", async () => {
		const { service, client } = serviceWith();
		client.responses.push(
			{
				ok: true,
				result: {
					indexSeq: 7,
					sessions: [{ sessionId: "first", live: true }],
					warnings: ["first-page-warning"],
					savedSession: { id: "saved", path: "/saved.jsonl", identity: savedTranscriptIdentity },
					continuationCursor: "page-2",
				},
			},
			{
				ok: true,
				result: {
					indexSeq: 7,
					sessions: [
						{
							sessionId: "second",
							locator: { cwd: "/workspace", worktreeRoot: null, stateRoot: "/workspace/.gjc/state" },
						},
					],
					warnings: ["second-page-warning"],
				},
			},
		);

		const result = await service.list({ actor, capability: "session.list" });

		expect(result).toEqual({
			ok: true,
			operation: "session.list",
			result: {
				indexSeq: 7,
				sessions: [
					{ sessionId: "first", live: true },
					{
						sessionId: "second",
						cwd: "/workspace",
						locator: { cwd: "/workspace", worktreeRoot: null, stateRoot: "/workspace/.gjc/state" },
					},
				],
				warnings: ["first-page-warning"],
				savedSession: { id: "saved", path: "/saved.jsonl", identity: savedTranscriptIdentity },
			},
		});
		expect(client.calls).toEqual([
			{ operation: "session.list", input: {}, options: {} },
			{ operation: "session.list", input: { cursor: "page-2" }, options: {} },
		]);
	});
	it("rejects scoped pagination when a later page drifts from the frozen observation", async () => {
		const { service, client } = serviceWith();
		const anchor = await resolveSessionLocator(process.cwd(), path.join(process.cwd(), ".gjc", "state"));
		const scopeRequest = {
			version: 1 as const,
			requested: "global" as const,
			requestAnchor: { cwd: anchor.cwd, worktreeRoot: anchor.worktreeRoot },
		};
		const scope = await resolveScopeRequest(scopeRequest);
		client.responses.push(
			{
				ok: true,
				result: {
					indexSeq: 7,
					sessions: [],
					warnings: [],
					scope,
					observedAt: "2026-08-25T03:00:00.000Z",
					continuationCursor: "next",
				},
			},
			{
				ok: true,
				result: { indexSeq: 8, sessions: [], warnings: [], scope, observedAt: "2026-08-25T03:00:01.000Z" },
			},
		);
		const result = await service.list({ actor, capability: "session.list", target: { scope: scopeRequest } });
		expect(result).toMatchObject({ ok: false, certainty: "uncertain", error: { code: "scope_observation_drift" } });
	});
	it("maps malformed scoped locator rows to a malformed_response failure", async () => {
		const anchor = await resolveSessionLocator(process.cwd(), path.join(process.cwd(), ".gjc", "state"));
		const scopeRequest = {
			version: 1 as const,
			requested: "global" as const,
			requestAnchor: { cwd: anchor.cwd, worktreeRoot: anchor.worktreeRoot },
		};
		const scope = await resolveScopeRequest(scopeRequest);
		const { service } = serviceWith({
			ok: true,
			result: {
				indexSeq: 7,
				sessions: [{ sessionId: "malformed", locator: { cwd: "/workspace", worktreeRoot: null } }],
				warnings: [],
				scope,
				observedAt: "2026-08-25T03:00:00.000Z",
			},
		});

		await expect(
			service.list({ actor, capability: "session.list", target: { scope: scopeRequest } }),
		).resolves.toMatchObject({
			ok: false,
			certainty: "uncertain",
			error: { code: "malformed_response" },
		});
	});
	it("fails safely when a Broker list cursor repeats", async () => {
		const { service, client } = serviceWith();
		client.responses.push(
			{
				ok: true,
				result: {
					indexSeq: 7,
					sessions: [{ sessionId: "first" }],
					warnings: [],
					continuationCursor: "repeat",
				},
			},
			{
				ok: true,
				result: {
					indexSeq: 7,
					sessions: [{ sessionId: "second" }],
					warnings: [],
					continuationCursor: "repeat",
				},
			},
		);

		expect(await service.list({ actor, capability: "session.list" })).toEqual({
			ok: false,
			operation: "session.list",
			certainty: "uncertain",
			error: {
				code: "protocol_error",
				message: "session.list returned a repeated continuation cursor",
			},
		});
		expect(client.calls).toHaveLength(2);
	});

	it("rejects malformed session.list continuation pages without returning partial data", async () => {
		const { service, client } = serviceWith();
		client.responses.push(
			{
				ok: true,
				result: { indexSeq: 7, sessions: [{ sessionId: "first" }], warnings: [], continuationCursor: "page-2" },
			},
			{ ok: true, result: { indexSeq: 7, sessions: "not-an-array", warnings: [] } },
		);

		const outcome = await service.list({ actor, capability: "session.list" });

		expect(outcome).toMatchObject({ ok: false, certainty: "uncertain", error: { code: "malformed_response" } });
		expect(outcome).not.toHaveProperty("result");
		expect(client.calls.map(call => call.input)).toEqual([{}, { cursor: "page-2" }]);
	});

	it("rejects missing and malformed session.list metadata", async () => {
		for (const result of [
			{ sessions: [], warnings: [] },
			{ indexSeq: 7, sessions: [] },
			{ indexSeq: -1, sessions: [], warnings: [] },
			{ indexSeq: 7, sessions: [], warnings: ["valid", 1] },
		]) {
			const { service } = serviceWith({ ok: true, result });
			expect(await service.list({ actor, capability: "session.list" })).toMatchObject({
				ok: false,
				certainty: "uncertain",
				error: { code: "malformed_response" },
			});
		}
	});
	it("accepts session.list responses with genuinely absent savedSession", async () => {
		const { service } = serviceWith({ ok: true, result: { indexSeq: 7, sessions: [], warnings: [] } });
		expect(await service.list({ actor, capability: "session.list" })).toEqual({
			ok: true,
			operation: "session.list",
			result: { indexSeq: 7, sessions: [], warnings: [] },
		});
	});
	it("rejects present malformed session.list savedSession identities", async () => {
		for (const savedSession of [
			undefined,
			{
				id: "saved",
				path: "/saved.jsonl",
				identity: { ...savedTranscriptIdentity, nlink: "invalid" },
			},
			{
				id: "saved",
				path: "/saved.jsonl",
				identity: { ...savedTranscriptIdentity, ctimeNs: "invalid" },
			},
		]) {
			const { service } = serviceWith({
				ok: true,
				result: { indexSeq: 7, sessions: [], warnings: [], savedSession },
			});
			expect(await service.list({ actor, capability: "session.list" })).toMatchObject({
				ok: false,
				certainty: "uncertain",
				error: { code: "malformed_response" },
			});
		}
	});

	it("redacts endpoint credentials from create and resume results", async () => {
		const { service, client } = serviceWith({
			ok: true,
			result: {
				sessionId: "created",
				cwd: "/repo",
				endpoint: { url: "ws://127.0.0.1:9999", token: "secret" },
				token: "top-level-secret",
				pid: 1234,
				processIncarnation: "linux:1234",
				hostIncarnation: "linux:1234",
				endpointMtimeMs: 1234,
				lifecycleRequestId: "internal-request-id",
			},
		});
		const created = await service.create({ actor, capability: "session.create", requestKey: "create", target });
		expect(created).toEqual({
			ok: true,
			operation: "session.create",
			result: { sessionId: "created", cwd: "/repo" },
		});
		client.response = {
			ok: true,
			result: {
				sessionId: "resumed",
				cwd: "/repo",
				endpoint: { url: "ws://127.0.0.1:9999", token: "secret" },
				token: "top-level-secret",
				pid: 1234,
				processIncarnation: "linux:1234",
				hostIncarnation: "linux:1234",
				endpointMtimeMs: 1234,
				lifecycleRequestId: "internal-request-id",
			},
		};
		const resumed = await service.resume({
			actor,
			capability: "session.resume",
			requestKey: "resume",
			target: { sessionId: "resumed" },
		});
		expect(resumed).toEqual({
			ok: true,
			operation: "session.resume",
			result: { sessionId: "resumed", cwd: "/repo" },
		});
	});

	it("rejects empty session results for targeted lifecycle successes", async () => {
		const { service, client } = serviceWith();
		client.responses.push({ ok: true, result: {} }, { ok: true, result: {} }, { ok: true, result: {} });
		const outcomes = [
			await service.resume({
				actor,
				capability: "session.resume",
				requestKey: "empty-resume",
				target: { sessionId: "target-session" },
			}),
			await service.close({
				actor,
				capability: "session.close",
				requestKey: "empty-close",
				target: { sessionId: "target-session" },
			}),
			await service.delete({
				actor,
				capability: "session.delete",
				requestKey: "empty-delete",
				target: { sessionId: "target-session" },
			}),
		];
		for (const outcome of outcomes)
			expect(outcome).toMatchObject({ ok: false, certainty: "uncertain", error: { code: "malformed_response" } });
		expect(client.calls).toHaveLength(3);
	});

	it("rejects mismatched session identities for targeted lifecycle successes", async () => {
		const { service, client } = serviceWith();
		client.responses.push(
			{ ok: true, result: { sessionId: "other-session" } },
			{ ok: true, result: { sessionId: "other-session" } },
			{ ok: true, result: { sessionId: "other-session" } },
		);
		const outcomes = [
			await service.resume({
				actor,
				capability: "session.resume",
				requestKey: "mismatch-resume",
				target: { sessionId: "target-session" },
			}),
			await service.close({
				actor,
				capability: "session.close",
				requestKey: "mismatch-close",
				target: { sessionId: "target-session" },
			}),
			await service.delete({
				actor,
				capability: "session.delete",
				requestKey: "mismatch-delete",
				target: { sessionId: "target-session" },
			}),
		];
		for (const outcome of outcomes)
			expect(outcome).toMatchObject({ ok: false, certainty: "uncertain", error: { code: "malformed_response" } });
		expect(client.calls).toHaveLength(3);
	});

	it("maps Broker certainty codes and treats malformed responses as uncertain", async () => {
		for (const [code, certainty] of [
			["terminal_uncertain", "uncertain"],
			["cleanup_pending", "cleanup_pending"],
			["unavailable", "retryable"],
			["broker_restarting", "retryable"],
			["readiness_timeout", "retryable"],
			["startup_admission_timeout", "retryable"],
			["invalid_input", "terminal"],
		] as const) {
			const { service } = serviceWith({ ok: false, error: { code, message: "broker failure" } });
			const result = await service.close({
				actor,
				capability: "session.close",
				requestKey: code,
				target: { sessionId: "session-1" },
			});
			expect(result).toMatchObject({ ok: false, certainty, error: { code, message: "broker failure" } });
		}

		const thrown = serviceWith();
		thrown.client.failure = Object.assign(new Error("terminal uncertainty"), {
			code: "terminal_uncertain",
			details: { code: "terminal_uncertain", message: "terminal uncertainty" },
		});
		const thrownResult = await thrown.service.close({
			actor,
			capability: "session.close",
			requestKey: "thrown",
			target: { sessionId: "session-1" },
		});
		expect(thrownResult).toMatchObject({ ok: false, certainty: "uncertain", error: { code: "terminal_uncertain" } });

		for (const [details, certainty] of [
			[{ requestSent: true, requestId: "sent-timeout" }, "uncertain"],
			[{ requestSent: false, requestId: "pre-send-timeout" }, "retryable"],
		] as const) {
			const transport = serviceWith();
			transport.client.failure = Object.assign(new Error("SDK request timed out"), {
				code: "timeout",
				details,
			});
			const outcome = await transport.service.create({
				actor,
				capability: "session.create",
				requestKey: details.requestId,
				target,
			});
			expect(outcome).toMatchObject({ ok: false, certainty, error: { code: "timeout" } });
		}

		const closed = serviceWith();
		closed.client.failure = Object.assign(new Error("SDK connection closed"), { code: "connection_closed" });
		const closedOutcome = await closed.service.create({
			actor,
			capability: "session.create",
			requestKey: "ambiguous-connection",
			target,
		});
		expect(closedOutcome).toMatchObject({ ok: false, certainty: "uncertain", error: { code: "connection_closed" } });
		const protocol = serviceWith();
		protocol.client.failure = Object.assign(new Error("malformed Broker frame"), { code: "protocol_error" });
		const protocolOutcome = await protocol.service.create({
			actor,
			capability: "session.create",
			requestKey: "ambiguous-protocol",
			target,
		});
		expect(protocolOutcome).toMatchObject({ ok: false, certainty: "uncertain", error: { code: "protocol_error" } });

		const malformed = serviceWith("not-a-broker-response");
		const result = await malformed.service.list({ actor, capability: "session.list" });
		expect(result).toMatchObject({ ok: false, certainty: "uncertain", error: { code: "malformed_response" } });
	});

	it("rejects a successful lifecycle response that omits its result record", async () => {
		const { service, client } = serviceWith({ ok: true });
		const result = await service.resume({
			actor,
			capability: "session.resume",
			requestKey: "missing-result",
			target: { sessionId: "session-1" },
		});
		expect(result).toMatchObject({ ok: false, certainty: "uncertain", error: { code: "malformed_response" } });
		expect(client.calls).toHaveLength(1);
	});

	it("preserves a successful lifecycle result when SDK cleanup fails", async () => {
		const ensureSpy = spyOn(brokerEnsure, "ensureBroker").mockResolvedValue({} as never);
		const discoverySpy = spyOn(sdkDiscovery, "readSdkBrokerDiscovery").mockResolvedValue({
			url: "ws://127.0.0.1:1",
			token: "broker-token",
		} as never);
		const closeError = new Error("cleanup timed out");
		const response = { ok: true, result: { sessionId: "session-1" } };
		const fakeClient = {
			global: async () => response,
			close: async () => {
				throw closeError;
			},
		} as unknown as SdkClient;
		const connectSpy = spyOn(SdkClient, "connect").mockResolvedValue(fakeClient);
		try {
			const client = new AgentDirSessionLifecycleClient("/agent");
			await expect(client.global("session.create", target, { idempotencyKey: "request-1" })).resolves.toEqual(
				response,
			);
		} finally {
			connectSpy.mockRestore();
			discoverySpy.mockRestore();
			ensureSpy.mockRestore();
		}
	});
	it("does not create a plain_dir before lifecycle authority validation", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-lifecycle-"));
		const requested = path.join(root, "unauthorized");
		try {
			const service = new AgentDirSessionLifecycleService(root);
			const outcome = await service.createExternal({
				actor: { id: "", namespace: actor.namespace },
				capability: "session.create",
				requestKey: "unauthorized-request",
				target: { kind: "plain_dir", path: requested },
			});
			expect(outcome).toMatchObject({ ok: false, certainty: "terminal", error: { code: "unauthorized" } });
			await expect(fs.stat(requested)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("rejects invalid resume authority before enumerating saved histories", async () => {
		const service = new AgentDirSessionLifecycleService("/agent");
		const listSpy = spyOn(service, "listRecent").mockResolvedValue({ kind: "complete", entries: [], warnings: [] });
		try {
			const unauthorized = await service.resumeExternal({
				actor: { id: "", namespace: actor.namespace },
				capability: "session.resume",
				requestKey: "resume-unauthorized",
				target: { sessionIdOrPrefix: "session" },
			});
			expect(unauthorized).toMatchObject({ kind: "unavailable", message: "authenticated actor is required" });
			const emptyPrefix = await service.resumeExternal({
				actor,
				capability: "session.resume",
				requestKey: "resume-empty-prefix",
				target: { sessionIdOrPrefix: "" },
			});
			expect(emptyPrefix).toMatchObject({ kind: "unavailable" });
			const unsafePrefix = await service.resumeExternal({
				actor,
				capability: "session.resume",
				requestKey: "resume-unsafe-prefix",
				target: { sessionIdOrPrefix: "../session" },
			});
			expect(unsafePrefix).toMatchObject({ kind: "unavailable" });
			expect(listSpy).not.toHaveBeenCalled();
		} finally {
			listSpy.mockRestore();
		}
	});
	it("resolves external IDs and prefixes against the complete recent-session scan", async () => {
		const service = new AgentDirSessionLifecycleService("/agent");
		const recentEntries = Array.from({ length: 1_000 }, (_, index) => ({
			sessionId: `recent-${index}`,
			path: "/recent",
			sessionStateFile: `/recent/${index}.jsonl`,
			mtimeMs: index,
		}));
		const olderExact = {
			sessionId: "older-exact",
			path: "/workspace",
			sessionStateFile: "/workspace/older-exact.jsonl",
			mtimeMs: -1,
		};
		const listSpy = spyOn(service, "listRecent");
		const resumeSpy = spyOn(service, "resume").mockResolvedValue({
			ok: true,
			operation: "session.resume",
			result: { sessionId: olderExact.sessionId },
		});
		try {
			listSpy.mockImplementation(async input => ({
				kind: "complete",
				entries: [...recentEntries, olderExact].slice(0, input.limit ?? 20),
				warnings: [],
			}));
			const exact = await service.resumeExternal({
				actor,
				capability: "session.resume",
				requestKey: "older-exact",
				target: { sessionIdOrPrefix: olderExact.sessionId },
			});

			expect(exact).toEqual({
				kind: "result",
				outcome: { ok: true, operation: "session.resume", result: { sessionId: olderExact.sessionId } },
			});
			expect(listSpy).toHaveBeenLastCalledWith({
				cwd: "/agent",
				allWorkspaces: true,
				limit: Number.MAX_SAFE_INTEGER,
				includeInternal: false,
			});
			expect(resumeSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					target: {
						sessionId: olderExact.sessionId,
						cwd: "/workspace",
						stateRoot: "/workspace/.gjc/state",
						sessionPath: olderExact.sessionStateFile,
					},
				}),
			);

			const prefixEntries = [
				...recentEntries,
				{
					sessionId: "colliding-older-a",
					path: "/workspace/a",
					sessionStateFile: "/workspace/a/colliding-older-a.jsonl",
					mtimeMs: -2,
				},
				{
					sessionId: "colliding-older-b",
					path: "/workspace/b",
					sessionStateFile: "/workspace/b/colliding-older-b.jsonl",
					mtimeMs: -3,
				},
			];
			listSpy.mockImplementation(async input => ({
				kind: "complete",
				entries: prefixEntries.slice(0, input.limit ?? 20),
				warnings: [],
			}));
			const ambiguous = await service.resumeExternal({
				actor,
				capability: "session.resume",
				requestKey: "colliding-prefix",
				target: { sessionIdOrPrefix: "colliding" },
			});

			expect(ambiguous).toEqual({
				kind: "ambiguous",
				candidates: [
					{ sessionId: "colliding-older-a", path: "/workspace/a" },
					{ sessionId: "colliding-older-b", path: "/workspace/b" },
				],
			});
			expect(listSpy).toHaveBeenLastCalledWith({
				cwd: "/agent",
				allWorkspaces: true,
				limit: Number.MAX_SAFE_INTEGER,
				includeInternal: false,
			});
			expect(resumeSpy).toHaveBeenCalledTimes(1);
		} finally {
			resumeSpy.mockRestore();
			listSpy.mockRestore();
		}
	});
	it("validates external readiness before setup, normalizes create paths, and maps mkdir failures", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-lifecycle-external-"));
		const service = new AgentDirSessionLifecycleService(root);
		const createSpy = spyOn(service, "create").mockResolvedValue({
			ok: true,
			operation: "session.create",
			result: { sessionId: "session-1" },
		});
		const listSpy = spyOn(service, "listRecent").mockResolvedValue({ kind: "complete", entries: [], warnings: [] });
		try {
			const invalidCreate = await service.createExternal({
				actor,
				capability: "session.create",
				requestKey: "invalid-create-readiness",
				readinessTimeoutMs: -2_000,
				target: { kind: "plain_dir", path: path.join(root, "invalid") },
			});
			expect(invalidCreate).toMatchObject({ ok: false, certainty: "terminal", error: { code: "invalid_request" } });
			expect(createSpy).not.toHaveBeenCalled();

			const invalidResume = await service.resumeExternal({
				actor,
				capability: "session.resume",
				requestKey: "invalid-resume-readiness",
				readinessTimeoutMs: -2_000,
				target: { sessionIdOrPrefix: "session" },
			});
			expect(invalidResume).toMatchObject({ kind: "unavailable" });
			expect(listSpy).not.toHaveBeenCalled();

			const requested = path.join(root, "relative-target");
			const relative = path.relative(process.cwd(), requested);
			await expect(
				service.createExternal({
					actor,
					capability: "session.create",
					requestKey: "relative-create",
					target: { kind: "plain_dir", path: relative },
				}),
			).resolves.toMatchObject({ ok: true });
			expect(createSpy.mock.calls[0]?.[0]).toMatchObject({
				target: { cwd: requested, stateRoot: path.join(requested, ".gjc", "state") },
			});
			const createRequest = createSpy.mock.calls[0]?.[0];
			expect(createRequest?.timeoutMs).toBe(
				lifecycleRequestTimeoutMs("session.create", { ...(createRequest?.target ?? {}) }),
			);

			const parentFile = path.join(root, "not-a-directory");
			await fs.writeFile(parentFile, "file");
			const mkdirFailure = await service.createExternal({
				actor,
				capability: "session.create",
				requestKey: "mkdir-failure",
				target: { kind: "plain_dir", path: path.join(parentFile, "child") },
			});
			expect(mkdirFailure).toMatchObject({ ok: false, certainty: "terminal", error: { code: "ENOTDIR" } });
			expect(createSpy).toHaveBeenCalledTimes(1);
		} finally {
			createSpy.mockRestore();
			listSpy.mockRestore();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("requires complete identity-bound proof for uncertain retirement", () => {
		const result = validateSessionLifecycleMutationRequest({
			operation: "session.reconcile_uncertain",
			actor,
			capability: "session.reconcile_uncertain",
			requestKey: "retire-request",
			target: { sessionId: "retired-session" },
		});
		expect(result).toMatchObject({ ok: false, error: { code: "invalid_request" } });
	});

	it("forwards typed proof and strips internal retirement identity from the result", async () => {
		const target: SessionReconcileUncertainTarget = {
			sessionId: "retired-session",
			cwd: "/tmp/workspace",
			stateRoot: "/tmp/workspace/.gjc/state",
			endpointGeneration: 2,
			endpointMtimeMs: 1,
			endpointFileId: "dev:123",
			processIncarnation: "linux:123",
			hostIncarnation: "host:123",
			lifecycleRequestId: "retire-effect",
			remoteCreateKey: "remote-create-key",
		};
		const client = new FakeLifecycleClient();
		client.response = {
			ok: true,
			result: {
				sessionId: target.sessionId,
				retired: true,
				ledgerState: "terminal_error",
				indexType: "session_closed",
				stateRoot: target.stateRoot,
				endpointGeneration: target.endpointGeneration,
				endpointMtimeMs: target.endpointMtimeMs,
				endpointFileId: target.endpointFileId,
				processIncarnation: target.processIncarnation,
				hostIncarnation: target.hostIncarnation,
				lifecycleRequestId: target.lifecycleRequestId,
				remoteCreateKey: target.remoteCreateKey,
			},
		};
		const result = await new SessionLifecycleService(client).reconcileUncertain({
			actor,
			capability: "session.reconcile_uncertain",
			requestKey: "retire-request",
			target,
		});
		expect(result).toMatchObject({
			ok: true,
			operation: "session.reconcile_uncertain",
			result: { sessionId: target.sessionId },
		});
		expect(result.ok && result.result).toMatchObject({ endpointFileId: target.endpointFileId });
		expect(result.ok && result.result).not.toHaveProperty("stateRoot");
		expect(result.ok && result.result).not.toHaveProperty("processIncarnation");
		expect(client.calls[0]?.input).toEqual({ ...target });
	});

	it("accepts broker-proven endpoint file identity for a legacy retirement target", async () => {
		const target: SessionReconcileUncertainTarget = {
			sessionId: "legacy-retired-session",
			cwd: "/tmp/workspace",
			stateRoot: "/tmp/workspace/.gjc/state",
			endpointGeneration: 2,
			endpointMtimeMs: 1,
			processIncarnation: "linux:123",
			hostIncarnation: "host:123",
			lifecycleRequestId: "retire-effect",
			remoteCreateKey: "remote-create-key",
		};
		const client = new FakeLifecycleClient();
		client.response = {
			ok: true,
			result: {
				...target,
				endpointFileId: "dev:456",
				retired: true,
				ledgerState: "terminal_error",
				indexType: "session_closed",
			},
		};
		const result = await new SessionLifecycleService(client).reconcileUncertain({
			actor,
			capability: "session.reconcile_uncertain",
			requestKey: "legacy-retire-request",
			target,
		});
		expect(result).toMatchObject({ ok: true, result: { endpointFileId: "dev:456" } });
	});

	it("rejects a proofless successful broker envelope", async () => {
		const client = new FakeLifecycleClient();
		client.response = { ok: true, result: { sessionId: "retired-session" } };
		const result = await new SessionLifecycleService(client).reconcileUncertain({
			actor,
			capability: "session.reconcile_uncertain",
			requestKey: "retire-proofless",
			target: {
				sessionId: "retired-session",
				cwd: "/tmp/workspace",
				stateRoot: "/tmp/workspace/.gjc/state",
				endpointGeneration: 2,
				endpointMtimeMs: 1,
				endpointFileId: "dev:123",
				processIncarnation: "linux:123",
				hostIncarnation: "host:123",
				lifecycleRequestId: "retire-effect",
				remoteCreateKey: "remote-create-key",
			},
		});
		expect(result).toMatchObject({ ok: false, certainty: "uncertain", error: { code: "malformed_response" } });
	});

	it("canonicalizes equivalent proof paths before transport", async () => {
		const client = new FakeLifecycleClient();
		client.response = {
			ok: true,
			result: {
				sessionId: "retired.session",
				retired: true,
				ledgerState: "terminal_error",
				indexType: "session_closed",
				stateRoot: "/tmp/workspace/.gjc/state",
				endpointGeneration: 2,
				endpointMtimeMs: 1,
				endpointFileId: "dev:123",
				processIncarnation: "linux:123",
				hostIncarnation: "host:123",
				lifecycleRequestId: "retire-effect",
				remoteCreateKey: "remote-create-key",
			},
		};
		const result = await new SessionLifecycleService(client).reconcileUncertain({
			actor,
			capability: "session.reconcile_uncertain",
			requestKey: "retire-canonicalize",
			target: {
				sessionId: "retired.session",
				cwd: "/tmp/workspace/../workspace",
				stateRoot: "/tmp/workspace/../workspace/.gjc/state",
				endpointGeneration: 2,
				endpointMtimeMs: 1,
				endpointFileId: "dev:123",
				processIncarnation: "linux:123",
				hostIncarnation: "host:123",
				lifecycleRequestId: "retire-effect",
				remoteCreateKey: "remote-create-key",
			},
		});
		expect(result).toMatchObject({ ok: true, result: { sessionId: "retired.session" } });
		expect(client.calls[0]?.input).toMatchObject({
			cwd: "/tmp/workspace",
			stateRoot: "/tmp/workspace/.gjc/state",
		});
	});
});
