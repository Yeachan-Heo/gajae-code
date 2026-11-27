import { describe, expect, it } from "bun:test";
import {
	deriveSessionLifecycleIdempotencyKey,
	type SessionLifecycleClient,
	type SessionLifecycleClientRequestOptions,
	type SessionLifecycleOperation,
	SessionLifecycleService,
	type SessionReviseRequest,
} from "../src/sdk/lifecycle/service";

interface LifecycleCall {
	readonly operation: SessionLifecycleOperation;
	readonly input: Record<string, unknown>;
	readonly options: SessionLifecycleClientRequestOptions;
}

const actor = { id: "operator-1", namespace: "sdk:workspace-1" } as const;
const target = { sessionId: "session-1", entryId: "prompt-1", body: "private replacement prompt" } as const;
const revision = {
	sessionId: target.sessionId,
	revised: true,
	entryId: target.entryId,
	replacementEntryId: "prompt-2",
	assistantEntryId: "assistant-2",
	status: "completed",
} as const;
const request: Omit<SessionReviseRequest, "operation"> = {
	actor,
	capability: "session.revise",
	requestKey: "revision-1",
	target,
};

class RecordingLifecycleClient implements SessionLifecycleClient {
	readonly calls: LifecycleCall[] = [];
	response: unknown = { ok: true, result: revision };
	thrown: unknown;

	async global(
		operation: SessionLifecycleOperation,
		input: Record<string, unknown>,
		options: SessionLifecycleClientRequestOptions,
	): Promise<unknown> {
		this.calls.push({ operation, input, options });
		if (this.thrown !== undefined) throw this.thrown;
		return this.response;
	}
}

function fixture(): { client: RecordingLifecycleClient; service: SessionLifecycleService } {
	const client = new RecordingLifecycleClient();
	return { client, service: new SessionLifecycleService(client) };
}

describe("SessionLifecycleService.revise", () => {
	it("forwards answered sibling selection without edit text or provider work", async () => {
		const { client, service } = fixture();
		const selection = { sessionId: target.sessionId, entryId: target.entryId, action: "select" } as const;
		client.response = {
			ok: true,
			result: {
				sessionId: target.sessionId,
				entryId: target.entryId,
				selected: true,
				status: "selected",
				leafEntryId: "original-answer",
			},
		};
		expect(await service.revise({ ...request, target: selection })).toMatchObject({
			ok: true,
			result: { selected: true, leafEntryId: "original-answer" },
		});
		expect(client.calls[0]?.input).toEqual(selection);
	});
	it("sends exactly the canonical Broker request and returns a validated content-free outcome", async () => {
		const { client, service } = fixture();
		const outcome = await service.revise({ ...request, timeoutMs: 12_345 });
		expect(client.calls).toEqual([
			{
				operation: "session.revise",
				input: { ...target, action: "edit" },
				options: {
					idempotencyKey: deriveSessionLifecycleIdempotencyKey(actor, request.requestKey, "session.revise"),
					timeoutMs: 12_345,
				},
			},
		]);
		expect(outcome).toEqual({ ok: true, operation: "session.revise", result: revision });
		expect(JSON.stringify(outcome)).not.toContain(target.body);
	});

	it("uses the existing execute union without a separate transport", async () => {
		const { client, service } = fixture();
		expect(await service.execute({ ...request, operation: "session.revise" })).toEqual({
			ok: true,
			operation: "session.revise",
			result: revision,
		});
		expect(client.calls).toEqual([
			{
				operation: "session.revise",
				input: { ...target, action: "edit" },
				options: {
					idempotencyKey: deriveSessionLifecycleIdempotencyKey(actor, request.requestKey, "session.revise"),
				},
			},
		]);
	});

	it("separates actor, namespace, request, and operation keys while replaying the same identity", async () => {
		const { client, service } = fixture();
		await service.revise(request);
		await service.revise(request);
		await service.revise({ ...request, actor: { ...actor, id: "operator-2" } });
		await service.revise({ ...request, actor: { ...actor, namespace: "sdk:workspace-2" } });
		await service.revise({ ...request, requestKey: "revision-2" });
		const keys = client.calls.map(call => call.options.idempotencyKey);
		expect(keys[0]).toBe(keys[1]);
		const forkKey = deriveSessionLifecycleIdempotencyKey(actor, request.requestKey, "session.fork");
		expect(new Set([keys[0], ...keys.slice(2), forkKey]).size).toBe(5);
		expect(keys.every(key => typeof key === "string" && /^[a-f0-9]{64}$/u.test(key))).toBe(true);
	});

	it("rejects a non-actor-scoped override before contacting Broker", async () => {
		const { client, service } = fixture();
		const rejected = await service.executeWithIdempotencyKey(
			{ ...request, operation: "session.revise" },
			"shared-key",
		);
		expect(rejected).toMatchObject({
			ok: false,
			operation: "session.revise",
			certainty: "terminal",
			error: { code: "invalid_input" },
		});
		expect(client.calls).toEqual([]);
		const key = deriveSessionLifecycleIdempotencyKey(actor, request.requestKey, "session.revise");
		expect(await service.executeWithIdempotencyKey({ ...request, operation: "session.revise" }, key)).toMatchObject({
			ok: true,
			operation: "session.revise",
		});
		expect(client.calls[0]?.options.idempotencyKey).toBe(key);
	});

	it("validates actor, capability, and required request key before effects", async () => {
		const { client, service } = fixture();
		for (const [override, code] of [
			[{ actor: undefined }, "unauthorized"],
			[{ actor: { id: "", namespace: actor.namespace } }, "unauthorized"],
			[{ actor: { id: actor.id, namespace: " \n" } }, "unauthorized"],
			[{ actor: { id: "\ud800", namespace: actor.namespace } }, "unauthorized"],
			[{ capability: "session.fork" }, "capability_denied"],
			[{ requestKey: undefined }, "invalid_request"],
			[{ requestKey: "" }, "invalid_request"],
			[{ requestKey: " \t" }, "invalid_request"],
			[{ requestKey: "bad\nkey" }, "invalid_request"],
			[{ requestKey: "\ud800" }, "invalid_request"],
		] as const) {
			const outcome = await service.revise({ ...request, ...override } as never);
			expect(outcome).toMatchObject({
				ok: false,
				operation: "session.revise",
				certainty: "terminal",
				error: { code },
			});
			expect(JSON.stringify(outcome)).not.toContain(target.body);
		}
		expect(client.calls).toEqual([]);
	});

	it("rejects malformed or unsafe targets without effects or body disclosure", async () => {
		const { client, service } = fixture();
		const invalidTargets: unknown[] = [undefined, null, [], "target"];
		for (const sessionId of [
			undefined,
			null,
			"",
			"../session",
			"session/child",
			"session\n",
			"x".repeat(129),
			"\ud800",
		])
			invalidTargets.push({ ...target, sessionId });
		for (const entryId of [undefined, null, "", "entry\n", "entry\u007f", "x".repeat(129), "\ud800"])
			invalidTargets.push({ ...target, entryId });
		for (const body of [undefined, null, 7, {}, [], "", " \n\t", "x".repeat(65_537), "\ud800", "\udc00"])
			invalidTargets.push({ ...target, body });
		for (const extra of [{ sourceEntryId: "other" }, { rawManager: {} }, { capability: "forged" }])
			invalidTargets.push({ ...target, ...extra });
		for (const invalidTarget of invalidTargets) {
			const outcome = await service.revise({ ...request, target: invalidTarget } as never);
			expect(outcome).toMatchObject({
				ok: false,
				operation: "session.revise",
				certainty: "terminal",
				error: { code: expect.stringMatching(/^invalid_(input|request)$/u) },
			});
			expect(JSON.stringify(outcome)).not.toContain(target.body);
		}
		expect(client.calls).toEqual([]);
	});

	it("accepts the body limit and preserves exact well-formed text, including whitespace and Unicode", async () => {
		const { client, service } = fixture();
		for (const body of ["x".repeat(65_536), "  revised 𝄞\n\t", "𝄞".repeat(32_768)]) {
			expect(await service.revise({ ...request, target: { ...target, body } })).toMatchObject({ ok: true });
			expect(client.calls.at(-1)?.input).toEqual({ ...target, action: "edit", body });
		}
	});

	it("rejects incomplete, mismatched, unsafe, or content-bearing success results as uncertain", async () => {
		const { client, service } = fixture();
		const malformed: unknown[] = [
			undefined,
			null,
			[],
			{},
			{ ...revision, sessionId: "wrong" },
			{ ...revision, entryId: "wrong" },
			{ ...revision, revised: false },
			{ ...revision, status: "running" },
		];
		for (const field of Object.keys(revision)) {
			const missing: Record<string, unknown> = { ...revision };
			delete missing[field];
			malformed.push(missing);
		}
		for (const id of [undefined, null, "", "bad\nentry", "x".repeat(129), "\ud800", target.entryId]) {
			malformed.push({ ...revision, replacementEntryId: id }, { ...revision, assistantEntryId: id });
		}
		malformed.push(
			{ ...revision, assistantEntryId: revision.replacementEntryId },
			{ ...revision, body: target.body },
			{ ...revision, endpoint: { token: target.body } },
		);
		for (const result of malformed) {
			client.response = { ok: true, result };
			const outcome = await service.revise(request);
			expect(outcome).toEqual({
				ok: false,
				operation: "session.revise",
				certainty: "uncertain",
				error: { code: "malformed_response", message: "lifecycle broker returned a malformed revision result" },
			});
			expect(JSON.stringify(outcome)).not.toContain(target.body);
		}
		for (const response of [null, {}, { ok: false }, { ok: "true", result: revision }]) {
			client.response = response;
			expect(await service.revise(request)).toMatchObject({
				ok: false,
				certainty: "uncertain",
				error: { code: "malformed_response" },
			});
		}
	});

	it("retains Broker certainty rules without reflecting sensitive Broker diagnostics", async () => {
		const { client, service } = fixture();
		for (const [code, certainty] of [
			["busy", "retryable"],
			["unavailable", "retryable"],
			["terminal_uncertain", "uncertain"],
			["cleanup_pending", "cleanup_pending"],
			["invalid_input", "terminal"],
		] as const) {
			client.response = { ok: false, error: { code, message: `Rejected ${target.body}` } };
			const outcome = await service.revise(request);
			expect(outcome).toEqual({
				ok: false,
				operation: "session.revise",
				certainty,
				error: { code, message: "lifecycle broker revision request failed" },
			});
			expect(JSON.stringify(outcome)).not.toContain(target.body);
		}
		client.response = { ok: false, error: { code: target.body, message: target.body } };
		expect(await service.revise(request)).toMatchObject({
			ok: false,
			error: { code: "broker_error", message: "lifecycle broker revision request failed" },
		});
	});

	it("retains transport send certainty and never includes thrown prompt text", async () => {
		const { client, service } = fixture();
		for (const [code, requestSent, certainty] of [
			["timeout", false, "retryable"],
			["timeout", true, "uncertain"],
			["connection_closed", undefined, "uncertain"],
			["protocol_error", false, "retryable"],
			["protocol_error", true, "uncertain"],
			["uncertain_after_send", undefined, "uncertain"],
		] as const) {
			client.thrown = { details: { code, requestSent, message: target.body } };
			const outcome = await service.revise(request);
			expect(outcome).toEqual({
				ok: false,
				operation: "session.revise",
				certainty,
				error: { code, message: "lifecycle broker revision request failed" },
			});
			expect(JSON.stringify(outcome)).not.toContain(target.body);
		}
		client.thrown = new Error(target.body);
		expect(await service.revise(request)).toEqual({
			ok: false,
			operation: "session.revise",
			certainty: "retryable",
			error: { code: "unavailable", message: "lifecycle broker request was unavailable" },
		});
	});
});
