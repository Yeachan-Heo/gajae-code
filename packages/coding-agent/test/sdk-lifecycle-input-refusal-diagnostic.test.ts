import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import {
	PUBLIC_COMMAND_DIAGNOSTICS,
	type PublicCommandErrorEnvelope,
	PublicCommandFailure,
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
 * A broker that refuses a `session.delete` payload — the missing durable transcript path, say —
 * answers `invalid_input: session.delete requires sessionPath and its configured cwd.` That
 * outcome is decided before the request is dispatched, but every non-allowlisted lifecycle code
 * collapses into `operation_failed` with `outcomeCertainty: unknown`: the caller reads "a
 * destructive operation may have half-applied, do not retry" and cannot recover the typed refusal
 * from the envelope. Callers therefore cannot tell a request they should correct from an operation
 * they must reconcile first, so the refusal class has to survive as a diagnostic.
 *
 * The diagnostic names the class only. The broker's own message is never rendered (it may carry
 * request keys, paths, or credentials), no effect proof is invented from the code, and the text
 * never implies that another request is safe.
 */

const INPUT_REFUSAL_DIAGNOSTIC = "lifecycle_input_refused";
/** Pinned independently of the production constant: this is the reviewed public text. */
const INPUT_REFUSAL_MESSAGE =
	"The broker refused the request as invalid input. Correct the request payload and reconcile existing lifecycle state before deciding whether another request is safe.";
const DELETE_REFUSAL_MESSAGE = "session.delete requires sessionPath and its configured cwd.";
const UNKNOWN_OUTCOME_MESSAGE = "The operation failed. Its outcome could not be established.";
/** Synthetic hostile broker text: credential, absolute path, and internal identity in one message. */
const HOSTILE_BROKER_MESSAGE =
	"requestKey 7ab collides with /Users/operator/.gjc/agent/sdk/lifecycle-ledger.jsonl token=sk-live-SECRET";
const actor = { id: "operator-1", namespace: "telegram:account-1" } as const;
const DELETE_COMMAND = ["sdk", "session", "raw", "global"] as const;

class FakeLifecycleClient implements SessionLifecycleClient {
	readonly calls: SessionLifecycleOperation[] = [];

	constructor(readonly response: unknown) {}

	async global(
		operation: SessionLifecycleOperation,
		_input: Record<string, unknown>,
		_options: SessionLifecycleClientRequestOptions,
	): Promise<unknown> {
		this.calls.push(operation);
		return this.response;
	}
}

function failureOutcome(outcome: SessionLifecycleResult): Extract<SessionLifecycleResult, { ok: false }> {
	expect(outcome.ok).toBe(false);
	return outcome as Extract<SessionLifecycleResult, { ok: false }>;
}

/** Drives the same service call the CLI makes for a delete; the refusal is the broker's response. */
async function deleteOutcome(brokerCode: string, message = HOSTILE_BROKER_MESSAGE) {
	const service = new SessionLifecycleService(
		new FakeLifecycleClient({ ok: false, error: { code: brokerCode, message } }),
	);
	return failureOutcome(
		await service.delete({
			actor,
			capability: "session.delete",
			requestKey: "delete-request",
			target: { sessionId: "session-1", cwd: "/repo" },
		}),
	);
}

async function render(outcome: Extract<SessionLifecycleResult, { ok: false }>): Promise<RenderedPublicCommandFailure> {
	return await renderPublicCommandFailure(lifecyclePublicFailure(outcome), {
		command: [...DELETE_COMMAND],
		json: true,
	});
}

function renderedText(result: RenderedPublicCommandFailure): string {
	return result.stdout + result.stderr;
}

function diagnosticCodes(envelope: PublicCommandErrorEnvelope): string[] {
	return (envelope.diagnostics ?? []).map(diagnostic => diagnostic.code);
}

describe("lifecycle input refusal diagnostic", () => {
	it("preserves the refusal class without inventing effect proof", async () => {
		const result = await render(await deleteOutcome("invalid_input", DELETE_REFUSAL_MESSAGE));
		const envelope = JSON.parse(result.stdout) as PublicCommandErrorEnvelope;

		// The conservative public code stays: the broker code alone is not effect proof.
		expect(envelope.error.code).toBe("operation_failed");
		expect(envelope.error.outcomeCertainty).toBe("unknown");
		expect(result.exitCode).toBe(1);
		// The class the caller needs — refused input, not an unsettled operation — survives.
		expect(envelope.diagnostics).toEqual([{ code: INPUT_REFUSAL_DIAGNOSTIC, message: INPUT_REFUSAL_MESSAGE }]);
		expect(PUBLIC_COMMAND_DIAGNOSTICS[INPUT_REFUSAL_DIAGNOSTIC]).toBe(INPUT_REFUSAL_MESSAGE);
	});

	it("renders the same diagnostic in text mode", async () => {
		const result = await renderPublicCommandFailure(
			lifecyclePublicFailure(await deleteOutcome("invalid_input", DELETE_REFUSAL_MESSAGE)),
			{ command: [...DELETE_COMMAND], json: false },
		);

		expect(renderedText(result)).toContain(INPUT_REFUSAL_DIAGNOSTIC);
		expect(renderedText(result)).toContain(UNKNOWN_OUTCOME_MESSAGE);
	});

	it("never renders the broker's refusal text, paths, or credentials", async () => {
		const result = await render(await deleteOutcome("invalid_input", HOSTILE_BROKER_MESSAGE));

		for (const secret of ["sk-live-SECRET", "/Users/operator", "lifecycle-ledger.jsonl", "7ab", "token="])
			expect(renderedText(result)).not.toContain(secret);
	});

	/** A malformed lifecycle request is the same refusal class, from the broker's own validation. */
	it("covers the malformed-request refusal", async () => {
		const result = await render(await deleteOutcome("invalid_request"));
		const envelope = JSON.parse(result.stdout) as PublicCommandErrorEnvelope;

		expect(diagnosticCodes(envelope)).toEqual([INPUT_REFUSAL_DIAGNOSTIC]);
	});

	/**
	 * Scope guard: only refusal codes carry the diagnostic. An idempotency conflict keeps its own,
	 * and an operation the broker could not establish stays unresolved with no refusal claim.
	 */
	it("leaves other lifecycle failures without the refusal diagnostic", async () => {
		for (const code of ["unavailable", "terminal_uncertain", "protocol_error", "cleanup_pending", "not_found"]) {
			const result = await render(await deleteOutcome(code));
			const envelope = JSON.parse(result.stdout) as PublicCommandErrorEnvelope;

			expect(diagnosticCodes(envelope)).not.toContain(INPUT_REFUSAL_DIAGNOSTIC);
			expect(envelope.error.outcomeCertainty).toBe("unknown");
		}

		const conflict = await render(await deleteOutcome("idempotency_conflict"));
		const conflictEnvelope = JSON.parse(conflict.stdout) as PublicCommandErrorEnvelope;
		expect(diagnosticCodes(conflictEnvelope)).toEqual(["lifecycle_idempotency_conflict"]);
	});
});

const AGENT_DIR = path.join(os.tmpdir(), "gjc-sdk-lifecycle-refusal-test-agent");

/**
 * Live route coverage: `runSdkSessionCli` must build the refusal diagnostic itself, not only the
 * exported mapping, so the classification is asserted on the failure the command throws.
 */
describe("raw global session.delete refusal output", () => {
	async function deleteFailure(brokerCode: string): Promise<PublicCommandFailure> {
		const service = new SessionLifecycleService(
			new FakeLifecycleClient({
				ok: false,
				error: { code: brokerCode, message: DELETE_REFUSAL_MESSAGE },
			}),
		);
		try {
			await runSdkSessionCli(
				{
					action: "raw",
					rawAction: "global",
					operation: "session.delete",
					idempotencyKey: "delete-request",
					jsonInput: JSON.stringify({ sessionId: "session-1", cwd: "/repo" }),
					agentDir: AGENT_DIR,
				},
				() => {},
				() => {},
				{ lifecycleService: service },
			);
		} catch (error) {
			expect(error).toBeInstanceOf(PublicCommandFailure);
			return error as PublicCommandFailure;
		}
		throw new Error("session.delete refusal did not fail the command.");
	}

	it("carries the refusal diagnostic with the conservative public code", async () => {
		const failure = await deleteFailure("invalid_input");
		const result = await renderPublicCommandFailure(failure, { command: [...DELETE_COMMAND], json: true });
		const envelope = JSON.parse(result.stdout) as PublicCommandErrorEnvelope;

		expect(envelope.error.code).toBe("operation_failed");
		expect(envelope.error.outcomeCertainty).toBe("unknown");
		expect(diagnosticCodes(envelope)).toEqual([INPUT_REFUSAL_DIAGNOSTIC]);
		expect(renderedText(result)).not.toContain(DELETE_REFUSAL_MESSAGE);
	}, 20_000);

	it("keeps a genuinely unestablished delete outcome free of the refusal claim", async () => {
		const failure = await deleteFailure("terminal_uncertain");
		const result = await renderPublicCommandFailure(failure, { command: [...DELETE_COMMAND], json: true });
		const envelope = JSON.parse(result.stdout) as PublicCommandErrorEnvelope;

		expect(envelope.error.outcomeCertainty).toBe("unknown");
		expect(envelope.diagnostics).toBeUndefined();
	}, 20_000);
});
