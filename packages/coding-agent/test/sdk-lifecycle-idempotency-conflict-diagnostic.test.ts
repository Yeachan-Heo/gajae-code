import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import {
	PUBLIC_COMMAND_DIAGNOSTICS,
	type PublicCommandErrorEnvelope,
	type RenderedPublicCommandFailure,
	renderPublicCommandFailure,
} from "../src/cli/public-command-errors";
import { lifecyclePublicFailure, runSdkSessionCli } from "../src/sdk/cli/session-cli";
import {
	type SessionLifecycleClient,
	type SessionLifecycleClientRequestOptions,
	type SessionLifecycleOperation,
	type SessionLifecycleResult,
	SessionLifecycleService,
} from "../src/sdk/lifecycle";

/**
 * A broker idempotency conflict collapses into the generic `operation_failed`
 * public code, which cannot distinguish it from any other failed operation. The
 * conflict must therefore survive as exactly one fixed diagnostic whose text is
 * pinned here literally, not derived from the production constant.
 *
 * The broker reaches this code from several distinct causes — a reused key with
 * different input, and the ledger's legacy-row admission guard among them — so
 * the text must not name a cause, and must not suggest that retrying under a new
 * key is safe. The broker's own message is never rendered: it may carry request
 * keys, agent paths, or credentials, and the public envelope cannot inspect it.
 */

const CONFLICT_DIAGNOSTIC = "lifecycle_idempotency_conflict";
/** Pinned independently of the production constant: this is the reviewed public text. */
const CONFLICT_MESSAGE =
	"The broker reported an idempotency conflict. Reconcile existing lifecycle state before deciding whether another request is safe.";
/** Synthetic hostile broker text: credential, absolute path, and internal identity in one message. */
const HOSTILE_BROKER_MESSAGE =
	"requestKey 7ab collides with /Users/operator/.gjc/agent/sdk/lifecycle-ledger.jsonl token=sk-live-SECRET";
const actor = { id: "operator-1", namespace: "telegram:account-1" } as const;

class FakeLifecycleClient implements SessionLifecycleClient {
	readonly calls: SessionLifecycleOperation[] = [];

	constructor(
		readonly response: unknown,
		readonly failure?: Error,
	) {}

	async global(
		operation: SessionLifecycleOperation,
		_input: Record<string, unknown>,
		_options: SessionLifecycleClientRequestOptions,
	): Promise<unknown> {
		this.calls.push(operation);
		if (this.failure) throw this.failure;
		return this.response;
	}
}

function failureOutcome(outcome: SessionLifecycleResult): Extract<SessionLifecycleResult, { ok: false }> {
	expect(outcome.ok).toBe(false);
	return outcome as Extract<SessionLifecycleResult, { ok: false }>;
}

async function closeOutcome(brokerCode: string): Promise<Extract<SessionLifecycleResult, { ok: false }>> {
	const service = new SessionLifecycleService(
		new FakeLifecycleClient({ ok: false, error: { code: brokerCode, message: HOSTILE_BROKER_MESSAGE } }),
	);
	return failureOutcome(
		await service.close({
			actor,
			capability: "session.close",
			requestKey: "close-request",
			target: { sessionId: "session-1" },
		}),
	);
}

async function createOutcome(brokerCode: string): Promise<Extract<SessionLifecycleResult, { ok: false }>> {
	const service = new SessionLifecycleService(
		new FakeLifecycleClient({ ok: false, error: { code: brokerCode, message: HOSTILE_BROKER_MESSAGE } }),
	);
	return failureOutcome(
		await service.create({
			actor,
			capability: "session.create",
			requestKey: "create-request",
			target: { cwd: "/repo" },
		}),
	);
}

async function lookupOutcome(brokerCode: string): Promise<Extract<SessionLifecycleResult, { ok: false }>> {
	const service = new SessionLifecycleService(
		new FakeLifecycleClient({ ok: false, error: { code: brokerCode, message: HOSTILE_BROKER_MESSAGE } }),
	);
	return failureOutcome(
		await service.lookup({
			actor,
			capability: "session.lookup",
			operation: "session.create",
			requestKey: "lookup-request",
			target: { cwd: "/repo" },
		}),
	);
}

async function render(
	outcome: Extract<SessionLifecycleResult, { ok: false }>,
	json: boolean,
): Promise<RenderedPublicCommandFailure> {
	return await renderPublicCommandFailure(lifecyclePublicFailure(outcome), {
		command: ["sdk", "session", "close"],
		json,
	});
}

function rendered(result: RenderedPublicCommandFailure): string {
	return result.stdout + result.stderr;
}

function diagnosticCodes(envelope: PublicCommandErrorEnvelope): string[] {
	return (envelope.diagnostics ?? []).map(diagnostic => diagnostic.code);
}

describe("lifecycle idempotency conflict diagnostic", () => {
	it("preserves the conflict as one fixed diagnostic in JSON without leaking broker text", async () => {
		const result = await render(await closeOutcome("idempotency_conflict"), true);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("");
		const envelope = JSON.parse(result.stdout) as PublicCommandErrorEnvelope;
		expect(envelope.error.code).toBe("operation_failed");
		expect(envelope.error.message).toBe("The operation failed. Its outcome could not be established.");
		expect(envelope.diagnostics).toEqual([{ code: CONFLICT_DIAGNOSTIC, message: CONFLICT_MESSAGE }]);
		expect(PUBLIC_COMMAND_DIAGNOSTICS[CONFLICT_DIAGNOSTIC]).toBe(CONFLICT_MESSAGE);

		for (const secret of ["sk-live-SECRET", "/Users/operator", "lifecycle-ledger.jsonl", "7ab", "token="])
			expect(result.stdout).not.toContain(secret);
	});

	/**
	 * `session.create` is the route that motivated this diagnostic: a conflict there
	 * can come from the ledger's legacy-row admission guard rather than a reused key,
	 * so the rendered text must stay cause-neutral.
	 */
	it("renders the cause-neutral text for a conflicting session.create", async () => {
		const result = await render(await createOutcome("idempotency_conflict"), true);

		expect(result.envelope.error.code).toBe("operation_failed");
		expect(result.envelope.diagnostics).toEqual([{ code: CONFLICT_DIAGNOSTIC, message: CONFLICT_MESSAGE }]);
		for (const cause of [
			"same request key",
			"same key",
			"different operation",
			"different input",
			"new key",
			"new request key",
			"retry with",
			"legacy",
		])
			expect(CONFLICT_MESSAGE.toLowerCase()).not.toContain(cause);
	});

	it("renders the same fixed diagnostic on the text surface", async () => {
		const result = await render(await closeOutcome("idempotency_conflict"), false);

		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(
			`DIAGNOSTICS [{"code":"${CONFLICT_DIAGNOSTIC}","message":${JSON.stringify(CONFLICT_MESSAGE)}}]`,
		);
		expect(result.stderr).not.toContain("sk-live-SECRET");
		expect(result.stderr).not.toContain("/Users/operator");
		expect(diagnosticCodes(result.envelope)).toEqual([CONFLICT_DIAGNOSTIC]);
	});

	/**
	 * Helper-level contract only. The session CLI returns a `session.lookup` outcome
	 * directly and never routes it through `lifecyclePublicFailure`, so this pins the
	 * projection helper for any future caller; the live route is covered separately
	 * by the raw global lookup suite below.
	 */
	it("projects a conflicting lookup outcome without changing its public code (helper-only)", async () => {
		const outcome = await lookupOutcome("idempotency_conflict");
		expect(outcome).toMatchObject({ status: "conflict", certainty: "uncertain" });

		const result = await render(outcome, true);
		expect(result.envelope.error.code).toBe("operation_failed");
		expect(diagnosticCodes(result.envelope)).toEqual([CONFLICT_DIAGNOSTIC]);
	});

	it("keeps conflict proof, retryability, and exit code conservative", async () => {
		for (const json of [true, false]) {
			const result = await render(await closeOutcome("idempotency_conflict"), json);
			expect(result.exitCode).toBe(1);
			expect(result.envelope.error.outcomeCertainty).toBe("unknown");
			expect(result.envelope.error.retryability).toBe("unknown");
			expect(result.envelope.error.category).toBe("operation");
			expect(result.envelope.error.nextSteps.map(next => next.description)).toContain(
				"The operation outcome is unknown. Reconcile available evidence and do not blindly retry.",
			);
		}
	});

	it("stays inside the public output byte budget on both surfaces", async () => {
		for (const json of [true, false]) {
			const result = await render(await closeOutcome("idempotency_conflict"), json);
			expect(Buffer.byteLength(rendered(result))).toBeLessThanOrEqual(8192);
			expect(result.envelope.complete).toBe(true);
			expect(result.envelope.omittedOptional).toEqual([]);
		}
	});

	it("refuses unknown and prototype-shaped broker codes as diagnostics", async () => {
		for (const hostile of [
			"__proto__",
			"constructor",
			"prototype",
			"toString",
			CONFLICT_DIAGNOSTIC,
			"IDEMPOTENCY_CONFLICT",
			" idempotency_conflict",
			"idempotency_conflict ",
			"idempotency_conflict\n",
		]) {
			const result = await render(await closeOutcome(hostile), true);
			expect(result.envelope.error.code).toBe("operation_failed");
			expect(result.envelope.diagnostics).toBeUndefined();
			expect(result.stdout).not.toContain(CONFLICT_DIAGNOSTIC);
			expect(result.stdout).not.toContain("sk-live-SECRET");
		}
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(Object.getPrototypeOf(PUBLIC_COMMAND_DIAGNOSTICS)).toBe(Object.prototype);
	});

	it("leaves a pre-send protocol classification unchanged", async () => {
		const service = new SessionLifecycleService(
			new FakeLifecycleClient(
				undefined,
				Object.assign(new Error("malformed Broker frame"), {
					code: "protocol_error",
					details: { code: "protocol_error", message: "malformed Broker frame", requestSent: false },
				}),
			),
		);
		const outcome = failureOutcome(
			await service.close({
				actor,
				capability: "session.close",
				requestKey: "pre-send",
				target: { sessionId: "session-1" },
			}),
		);
		expect(outcome).toMatchObject({ certainty: "retryable", error: { code: "protocol_error" } });

		const result = await render(outcome, true);
		expect(result.envelope.error.code).toBe("operation_failed");
		expect(result.envelope.error.outcomeCertainty).toBe("not-applied");
		expect(result.envelope.diagnostics).toBeUndefined();
		expect(result.exitCode).toBe(1);
	});

	it("leaves post-send timeout uncertainty unchanged", async () => {
		const service = new SessionLifecycleService(
			new FakeLifecycleClient(
				undefined,
				Object.assign(new Error("SDK request timed out"), {
					code: "timeout",
					details: { code: "timeout", message: "SDK request timed out", requestSent: true },
				}),
			),
		);
		const outcome = failureOutcome(
			await service.close({
				actor,
				capability: "session.close",
				requestKey: "post-send",
				target: { sessionId: "session-1" },
			}),
		);
		expect(outcome).toMatchObject({ certainty: "uncertain", error: { code: "timeout" } });

		const result = await render(outcome, true);
		expect(result.envelope.error.code).toBe("timeout");
		expect(result.envelope.error.category).toBe("timeout");
		expect(result.envelope.error.outcomeCertainty).toBe("unknown");
		expect(result.envelope.diagnostics).toBeUndefined();
	});
});

/**
 * Live route coverage for the raw global `session.lookup` output boundary.
 *
 * `SessionLifecycleService.lookup` preserves the broker's `error.message`, the CLI returns
 * that outcome directly, and `stripSecretFields` only drops secret-shaped *keys* — never a
 * message body — so this route also bypasses the public error envelope and its byte budget.
 * These tests drive `runSdkSessionCli` itself over a real `SessionLifecycleService`, so a
 * hostile broker message reaches the same code path an operator would hit.
 */

const AGENT_DIR = path.join(os.tmpdir(), "gjc-sdk-lookup-conflict-test-agent");
const LOOKUP_REQUEST_KEY = "lookup-request";
/** Oversized hostile text: multi-byte body well past the 8192-byte public output budget. */
const OVERSIZED_BROKER_MESSAGE = `${"곰".repeat(4096)} token=sk-live-SECRET /Users/operator/.gjc`;

function lookupService(response: unknown): SessionLifecycleService {
	return new SessionLifecycleService(new FakeLifecycleClient(response));
}

function brokerFailure(code: string, message: string): unknown {
	return { ok: false, error: { code, message } };
}

async function runLookupCli(
	service: SessionLifecycleService,
	input: Record<string, unknown> = { cwd: "/repo" },
): Promise<{ output: unknown; exitCode: number | undefined }> {
	const outputs: unknown[] = [];
	let exitCode: number | undefined;
	await runSdkSessionCli(
		{
			action: "raw",
			rawAction: "global",
			operation: "session.lookup",
			idempotencyKey: LOOKUP_REQUEST_KEY,
			jsonInput: JSON.stringify(input),
			agentDir: AGENT_DIR,
		},
		value => outputs.push(value),
		code => {
			exitCode = code;
		},
		{ lifecycleService: service },
	);
	expect(outputs).toHaveLength(1);
	return { output: outputs[0], exitCode };
}

describe("raw global session.lookup conflict output boundary", () => {
	it("sanitizes a hostile broker conflict message on the live CLI route", async () => {
		const { output, exitCode } = await runLookupCli(
			lookupService(brokerFailure("idempotency_conflict", HOSTILE_BROKER_MESSAGE)),
		);

		expect(output).toEqual({
			ok: false,
			operation: "session.lookup",
			status: "conflict",
			request: { operation: "session.create", requestKey: LOOKUP_REQUEST_KEY },
			certainty: "uncertain",
			error: { code: "idempotency_conflict", message: CONFLICT_MESSAGE },
		});
		expect(exitCode).toBe(1);
		const serialized = JSON.stringify(output);
		for (const secret of ["sk-live-SECRET", "/Users/operator", "lifecycle-ledger.jsonl", "7ab", "token="])
			expect(serialized).not.toContain(secret);
	}, 20_000);

	it("bounds an oversized multi-byte conflict message at the lookup boundary", async () => {
		expect(Buffer.byteLength(OVERSIZED_BROKER_MESSAGE)).toBeGreaterThan(8192);
		const { output, exitCode } = await runLookupCli(
			lookupService(brokerFailure("idempotency_conflict", OVERSIZED_BROKER_MESSAGE)),
		);

		const serialized = JSON.stringify(output);
		expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(8192);
		expect(serialized).not.toContain("곰");
		expect(serialized).not.toContain("sk-live-SECRET");
		expect(output).toMatchObject({
			status: "conflict",
			certainty: "uncertain",
			error: { code: "idempotency_conflict", message: CONFLICT_MESSAGE },
		});
		expect(exitCode).toBe(1);
	}, 20_000);

	/** Scope guard: only the exact conflict code is sanitized; nothing else changes. */
	it("leaves a non-conflict lookup failure untouched", async () => {
		const { output, exitCode } = await runLookupCli(
			lookupService(brokerFailure("not_found", "lifecycle operation was not found")),
		);

		expect(output).toEqual({
			ok: false,
			operation: "session.lookup",
			status: "not_found",
			request: { operation: "session.create", requestKey: LOOKUP_REQUEST_KEY },
			certainty: "uncertain",
			error: { code: "not_found", message: "lifecycle operation was not found" },
		});
		expect(exitCode).toBe(1);
	}, 20_000);

	it("refuses near-miss and prototype-shaped conflict codes", async () => {
		for (const hostile of [
			"__proto__",
			"constructor",
			"prototype",
			"IDEMPOTENCY_CONFLICT",
			" idempotency_conflict",
			"idempotency_conflict ",
			"idempotency_conflict\n",
		]) {
			const { output, exitCode } = await runLookupCli(lookupService(brokerFailure(hostile, "broker detail")));

			expect(output).toMatchObject({
				ok: false,
				operation: "session.lookup",
				status: "terminal",
				error: { code: hostile, message: "broker detail" },
			});
			expect(exitCode).toBe(1);
		}
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	}, 20_000);

	it("leaves a recovered lookup result unchanged", async () => {
		const { output, exitCode } = await runLookupCli(
			lookupService({ ok: true, result: { sessionId: "recovered-create", cwd: "/repo" } }),
		);

		expect(output).toEqual({
			ok: true,
			operation: "session.lookup",
			status: "found",
			request: { operation: "session.create", requestKey: LOOKUP_REQUEST_KEY },
			result: { sessionId: "recovered-create", cwd: "/repo" },
		});
		expect(exitCode).toBeUndefined();
	}, 20_000);
});
