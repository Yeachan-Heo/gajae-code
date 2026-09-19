/**
 * Issue #5664: a long-running turn died with a post-start terminal carrying
 * `retryability: "transient"` / `providerCode: "server_is_overloaded"`, and the operator saw only
 * `Internal error: Provider failure after execution started.` — wording that reads as "your task
 * failed" when the bounded classification says the upstream provider fell over.
 *
 * These pin the one behaviour this PR ships: a `provider_transport` post-start failure gains a
 * human-readable `operatorMessage` on the wire, beside the untouched `code`/`details` pair. The
 * classification keys (`phase`, `category`, `retryability`, `providerCode`) already shipped
 * separately and are asserted here only to prove they are UNCHANGED.
 *
 * The message deliberately says nothing about uncommitted work: nothing on this path inspects the
 * worktree, so any claim about it would assert a check that never ran. Preserving the worktree is a
 * separate, unresolved problem — #5664 stays open for it.
 */
import { describe, expect, it } from "bun:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { AcpPromptFailureError, acpRequestFailure } from "@gajae-code/coding-agent/modes/acp/acp-agent";
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

describe("post-start terminal wording names the upstream provider (issue #5664)", () => {
	it("tells the operator the provider failed, not their task", () => {
		const data = wireData(promptFailure({ providerCode: "server_is_overloaded", phase: "post_start" }));

		// The classification that already shipped is unchanged.
		expect(data).toMatchObject({
			code: "prompt_failed",
			phase: "post_start",
			category: "provider_transport",
			retryability: "transient",
			providerCode: "server_is_overloaded",
		});
		// The defect: `details` alone reads as "your task failed". It stays exactly as it is —
		// pinned ACP core-v1 conformance asserts on it — and the operator wording arrives beside it.
		expect(data.details).toBe("Provider failure after execution started.");
		expect(typeof data.operatorMessage).toBe("string");
		const operator = String(data.operatorMessage);
		expect(operator).toContain("Upstream provider failure");
		expect(operator).toContain("server_is_overloaded");
		expect(operator).toContain("the model provider ended this turn");
		// Finding 2: `post_start` proves execution began, so the wording must NOT absolve the task.
		expect(operator).not.toContain("not your task");
		expect(operator).toContain("may have taken effect");
	});

	it("says nothing for a post-start failure that is not a provider transport failure", () => {
		// `phase` and `category` are already on the wire, so prose restating them tells an operator
		// nothing new. Silence also keeps the message honest about the worktree: nothing here
		// inspects it, so nothing here may claim anything about it.
		const data = wireData(promptFailure({ providerCode: "internal", phase: "post_start" }));

		expect(data).toMatchObject({ phase: "post_start", category: "agent_runtime" });
		expect(data).not.toHaveProperty("operatorMessage");
	});

	it("keeps -32603 and the redacted message for the prompt-failure class", () => {
		const failure = acpRequestFailure(promptFailure({ providerCode: "server_is_overloaded", phase: "post_start" }));

		expect((failure as RequestError).code).toBe(-32603);
		expect((failure as Error).message).toBe("Internal error: Provider failure after execution started.");
	});

	it("builds the wording only from bounded safe tokens, never from provider text", () => {
		const leak = "Request failed: 503 overloaded for user@example.com";
		const failure = promptFailure({ providerCode: leak, phase: "post_start" });
		const serialized = JSON.stringify(acpRequestFailure(failure));

		expect(serialized).not.toContain("user@example.com");
		// An unbounded provider code is not a classifier, so it never selects `provider_transport`
		// and never reaches the wording.
		expect(wireData(failure)).not.toHaveProperty("providerCode");
		expect(wireData(failure)).not.toHaveProperty("operatorMessage");
	});

	it("says nothing extra when there is nothing an operator would not already know", () => {
		// A submission-phase agent-runtime rejection ran nothing. Its payload must stay
		// byte-identical to what shipped before this change.
		const data = wireData(promptFailure({}));

		expect(data).toEqual({
			code: "prompt_failed",
			details: "Prompt submission failed.",
			phase: "submission",
			category: "agent_runtime",
			retryability: "terminal",
		});
	});

	it("says nothing for a SUBMISSION-phase provider transport failure (review finding 1)", () => {
		// A submission-phase rejection never started executing. Selecting the wording on `category`
		// alone gave this case "the model provider ended this turn", describing a turn that never ran.
		// The phase gate is what makes the claim true of the case it is attached to.
		const data = wireData(promptFailure({ providerCode: "server_is_overloaded", phase: "submission" }));

		expect(data).toMatchObject({
			phase: "submission",
			category: "provider_transport",
			retryability: "transient",
			providerCode: "server_is_overloaded",
		});
		expect(data).not.toHaveProperty("operatorMessage");
	});

	it("does not claim the operator's work is unaffected by a post-start failure (review finding 2)", () => {
		// `post_start` proves execution began: tools may have run and had effects before the provider
		// died. The wording must attribute the failure upstream WITHOUT asserting the task was
		// untouched, because neither `phase` nor `category` establishes that.
		const data = wireData(promptFailure({ providerCode: "server_is_overloaded", phase: "post_start" }));
		const operator = String(data.operatorMessage);

		expect(operator).toContain("Upstream provider failure");
		expect(operator).not.toContain("not your task");
		expect(operator).toMatch(/already performed may have taken effect/);
		expect(operator).toContain("check before retrying");
	});
});
