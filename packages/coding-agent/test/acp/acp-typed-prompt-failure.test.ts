/**
 * Issue #5615: a mid-session prompt failure reached the ACP client as an untyped
 * `-32603 {code: "prompt_failed", details: "Prompt submission failed."}`. The
 * terminal's classification — phase, bounded origin category, provider classifier —
 * was already computed and already carried on the rejection, then discarded at the
 * one translation point, so a client could not tell a transient provider blip from
 * a dead session without parsing English.
 *
 * These assert on the wire `data`, never on message text.
 */
import { describe, expect, it } from "bun:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { AcpPromptFailureError, acpRequestFailure } from "@gajae-code/coding-agent/modes/acp/acp-agent";
import { AcpSdkAdapterError } from "../../src/sdk/acp";
import { failedPromptOutcome } from "../../src/sdk/prompt-failure";

/** Build the rejection production settles with, through the same builder `terminalOutcome` uses. */
function promptFailure(input: {
	code?: "prompt_failed" | "prompt_deadline_exceeded";
	provenance?: "agent_failed" | "deadline";
	providerCode?: string;
	phase?: "submission" | "post_start";
}): AcpPromptFailureError {
	return new AcpPromptFailureError(
		failedPromptOutcome({
			code: input.code ?? "prompt_failed",
			provenance: input.provenance ?? "agent_failed",
			...(input.providerCode === undefined ? {} : { providerCode: input.providerCode }),
			...(input.phase === undefined ? {} : { phase: input.phase }),
			evidence: {},
		}),
	);
}

function wireData(error: unknown): Record<string, unknown> {
	const failure = acpRequestFailure(error);
	expect(failure).toBeInstanceOf(RequestError);
	return (failure as RequestError).data as Record<string, unknown>;
}

describe("acpRequestFailure carries the prompt terminal's classification (issue #5615)", () => {
	it("publishes phase and category instead of a bare code/details pair", () => {
		// The reported mid-session shape: a bare `prompt_failed` with no provider
		// classifier. It is an agent-runtime failure the host claimed as submission-phase,
		// and both of those facts now reach the client.
		const data = wireData(promptFailure({}));

		expect(data).toMatchObject({
			code: "prompt_failed",
			details: "Prompt submission failed.",
			phase: "submission",
			category: "agent_runtime",
		});
	});

	it("distinguishes a transient provider failure from the terminal classes", () => {
		const transient = wireData(promptFailure({ providerCode: "upstream_stream_interrupted" }));
		expect(transient).toMatchObject({ category: "provider_transport", retryability: "transient" });

		// Each terminal class must differ from the transient one, not merely be present.
		const terminal = [
			{ label: "provider rejection", input: { providerCode: "provider_http_429" }, category: "provider_rejected" },
			{
				label: "deadline",
				input: { code: "prompt_deadline_exceeded" as const, provenance: "deadline" as const },
				category: "deadline",
			},
			{ label: "agent runtime", input: { providerCode: "internal" }, category: "agent_runtime" },
		];
		for (const { label, input, category } of terminal) {
			const data = wireData(promptFailure(input));
			expect({ label, ...data }).toMatchObject({ label, category, retryability: "terminal" });
			expect(data.retryability).not.toBe(transient.retryability);
		}
	});

	it("preserves an uncertain attribution instead of claiming the turn is unrecoverable", () => {
		// A provider code in none of the bounded sets — including, today, any
		// context-overflow classifier — stays `unknown` rather than being guessed into
		// a recovery or a terminal verdict. The classifier itself still reaches the
		// client, so the cause is at least identifiable.
		const data = wireData(promptFailure({ providerCode: "context_length_exceeded" }));

		expect(data).toMatchObject({
			category: "unknown",
			retryability: "unknown",
			providerCode: "context_length_exceeded",
		});
	});

	it("omits providerCode rather than nulling it when the terminal carried none", () => {
		const data = wireData(promptFailure({}));

		expect(data).not.toHaveProperty("providerCode");
	});

	it("drops a providerCode that is not a bounded safe token", () => {
		// `terminalOutcome` admits the host's `providerCode` on a `typeof` check alone, and
		// this is the first path that puts it on the wire. Provider prose must not ride out
		// on it, and neither `message` nor `details` may restate it.
		const leak = "Request failed: 400 tokens exceeded for user@example.com";
		const failure = acpRequestFailure(promptFailure({ providerCode: leak })) as RequestError;

		expect((failure.data as Record<string, unknown>)).not.toHaveProperty("providerCode");
		expect(JSON.stringify(failure)).not.toContain("tokens exceeded");
		// `RequestError` prefixes its own class wording; the redacted body is unchanged.
		expect(failure.message).toBe("Internal error: Prompt submission failed.");
		expect((failure.data as Record<string, unknown>).details).toBe("Prompt submission failed.");
	});

	it("keeps -32603 for the prompt-failure class", () => {
		// Pinned ACP core-v1 conformance expects -32603/-32000 here; the classification
		// travels in `data`, never in a renumbered code.
		for (const error of [promptFailure({}), promptFailure({ code: "prompt_deadline_exceeded", provenance: "deadline" })])
			expect((acpRequestFailure(error) as RequestError).code).toBe(-32603);
	});

	it("leaves every non-prompt-failure error exactly as it was", () => {
		for (const { code, expectedCode } of [
			{ code: "authentication_failed", expectedCode: -32000 },
			{ code: "invalid_input", expectedCode: -32602 },
			{ code: "unsupported", expectedCode: -32602 },
			{ code: "unsupported_content", expectedCode: -32602 },
			{ code: "not_found", expectedCode: -32603 },
			{ code: "conflict", expectedCode: -32603 },
		]) {
			const failure = acpRequestFailure(new AcpSdkAdapterError(code, `failure: ${code}`)) as RequestError;

			expect(failure.code).toBe(expectedCode);
			expect(failure.data).toEqual({ code, details: `failure: ${code}` });
		}

		const requestError = RequestError.invalidParams({ code: "already_request_error" }, "already wrapped");
		expect(acpRequestFailure(requestError)).toBe(requestError);
		expect(acpRequestFailure({ code: 7 })).toEqual({ code: 7 });
	});
});
