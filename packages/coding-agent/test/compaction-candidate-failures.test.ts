/**
 * Auto-compaction walks a candidate chain: the session model, each preset role,
 * then the same-provider largest-context fallback. When every candidate fails,
 * the error the user sees must lead with the *first* failure and list the rest,
 * not name whichever fallback the chain happened to end on.
 */
import { describe, expect, it } from "bun:test";
import { describeCompactionCandidateFailures } from "@gajae-code/coding-agent/session/fallback-chain-controller";

describe("describeCompactionCandidateFailures", () => {
	const failures = [
		{ model: "openai-codex/gpt-6-astra", message: "Model openai-codex/gpt-6-astra does not support thinking" },
		{ model: "openai-codex/gpt-5.6-luna", message: "Model openai-codex/gpt-5.6-luna does not support thinking" },
		{ model: "openai-codex/gpt-5.4", message: "Model openai-codex/gpt-5.4 does not support thinking" },
	];

	it("leads with the first candidate's failure, not the last fallback's", () => {
		const last = new Error(failures[2]!.message);
		const error = describeCompactionCandidateFailures(failures, last);
		expect(
			error.message.startsWith(
				"Model openai-codex/gpt-6-astra does not support thinking (openai-codex/gpt-6-astra)",
			),
		).toBe(true);
	});

	it("lists every candidate that was tried with its own error", () => {
		const error = describeCompactionCandidateFailures(failures, new Error("x"));
		expect(error.message).toContain("3 compaction candidates failed:");
		for (const failure of failures) expect(error.message).toContain(`  ${failure.model}: ${failure.message}`);
	});

	it("keeps the final error reachable as cause for callers that classify by type", () => {
		const last = new Error("final");
		expect(describeCompactionCandidateFailures(failures, last).cause).toBe(last);
	});

	it("redacts credentials and provider base URLs from every listed failure", () => {
		const error = describeCompactionCandidateFailures(
			[
				{
					model: "provider/first",
					message: "Request failed at https://secret.example/v1?trace=private-id",
				},
				{ model: "provider/second", message: 'authorization: "Bearer secret-token"' },
			],
			new Error("final"),
		);

		expect(error.message).not.toContain("secret.example");
		expect(error.message).not.toContain("secret-token");
		expect(error.message).toContain("[redacted URL]");
		expect(error.message).toContain("Credential diagnostic unavailable.");
	});
});
