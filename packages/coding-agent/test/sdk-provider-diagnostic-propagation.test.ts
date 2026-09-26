import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { APIError } from "@anthropic-ai/sdk";
import { Messages } from "@anthropic-ai/sdk/resources/messages/messages";
import type { AssistantMessage, Context, Model } from "@gajae-code/ai";
import { streamAnthropic } from "@gajae-code/ai";
import { createKindAwareReconciliation } from "../src/sdk/bus/kind-aware-reconciliation";
import { createReconciliationStore } from "../src/sdk/bus/reconciliation-store";
import { createInvocationReconciliation, providerFailureFromAgentEnd } from "../src/sdk/host/session-runtime";
import { failedPromptOutcome } from "../src/sdk/prompt-failure";

/**
 * The diagnostic is only worth publishing if it is the SAME validated value at
 * every boundary a client can observe: the terminal assistant message, both
 * reconciliation implementations, the durable record after a real reload, and
 * the public status projection. None of it may change the primary outcome.
 */

const SECRET_MARKER = "sk-ant-secret-DO-NOT-LEAK";

const AUTH_DIAGNOSTIC = {
	category: "auth",
	httpStatus: 401,
	code: "authentication_error",
	evidence: "structured_code",
} as const;

const model: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

/** A terminal assistant message produced by the REAL Anthropic adapter. */
async function adapterFailure(status: number, type: string): Promise<AssistantMessage> {
	const message = `provider rejected the request ${SECRET_MARKER}`;
	vi.spyOn(Messages.prototype, "create").mockImplementation(
		() =>
			({
				async withResponse(): Promise<never> {
					throw APIError.generate(status, { type: "error", error: { type, message } }, message, new Headers());
				},
			}) as never,
	);
	const stream = streamAnthropic(model, context, { apiKey: "sk-ant-test", providerRetryWait: async () => {} });
	for await (const _ of stream) {
		// drain
	}
	return await stream.result();
}

async function withTempSession<T>(run: (sessionFile: string) => Promise<T>): Promise<T> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "provider-diagnostic-"));
	try {
		const sessionFile = path.join(root, "s.jsonl");
		await fs.writeFile(sessionFile, "");
		return await run(sessionFile);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

const correlation = { commandId: "c1", turnId: "t1" };

afterEach(() => {
	vi.restoreAllMocks();
});

describe("provider diagnostic across SDK reconciliation boundaries", () => {
	test("keeps the failed outcome primary fields exact while carrying the diagnostic", async () => {
		const failure = await adapterFailure(429, "rate_limit_error");
		const withDiagnostic = failedPromptOutcome({
			code: "prompt_failed",
			provenance: "agent_failed",
			providerCode: "provider_rejected",
			evidence: { startedAt: 5 },
			providerDiagnostic: failure.providerDiagnostic,
		});
		const without = failedPromptOutcome({
			code: "prompt_failed",
			provenance: "agent_failed",
			providerCode: "provider_rejected",
			evidence: { startedAt: 5 },
		});

		expect(withDiagnostic).toEqual({ ...without, providerDiagnostic: failure.providerDiagnostic });
		expect(withDiagnostic.message).toBe(without.message);
		expect(withDiagnostic.category).toBe(without.category);
		expect(withDiagnostic.phase).toBe(without.phase);
		expect(withDiagnostic.providerCode).toBe("provider_rejected");
		expect(JSON.stringify(withDiagnostic)).not.toContain(SECRET_MARKER);
	});

	test("drops a malformed diagnostic without disturbing the legacy outcome", () => {
		const outcome = failedPromptOutcome({
			code: "prompt_failed",
			provenance: "agent_failed",
			evidence: {},
			providerDiagnostic: {
				category: "quota",
				httpStatus: 401,
				code: "authentication_error",
				evidence: "structured_code",
			} as never,
		});

		expect(outcome.providerDiagnostic).toBeUndefined();
		expect(outcome.code).toBe("prompt_failed");
		// Primary classification is exactly the baseline value for this classifier.
		expect(outcome.category).toBe("agent_runtime");
	});

	test("publishes the diagnostic from a provider stream that ended with an error message", async () => {
		const failure = await adapterFailure(401, "authentication_error");
		const published = providerFailureFromAgentEnd({ messages: [failure] }) as
			| { code: string; message: string; providerCode?: string; providerDiagnostic?: unknown }
			| undefined;

		// Primary classification is untouched; only the diagnostic is additive.
		expect(published?.code).toBe("provider_rejected");
		expect(published?.message).toBe("Prompt submission failed.");
		expect(published?.providerDiagnostic).toEqual(AUTH_DIAGNOSTIC);
		expect(JSON.stringify(published)).not.toContain(SECRET_MARKER);

		// Legacy and forged shapes publish no diagnostic.
		const legacy = providerFailureFromAgentEnd({
			messages: [{ ...failure, providerDiagnostic: undefined, errorStatus: 401 }],
		}) as { providerDiagnostic?: unknown } | undefined;
		expect(legacy?.providerDiagnostic).toBeUndefined();
		const forged = providerFailureFromAgentEnd({
			messages: [
				{
					...failure,
					providerDiagnostic: {
						category: "quota",
						httpStatus: 401,
						code: "authentication_error",
						evidence: "structured_code",
					},
				},
			],
		}) as { providerDiagnostic?: unknown } | undefined;
		expect(forged?.providerDiagnostic).toBeUndefined();
	});

	test("carries the diagnostic through the host reconciler onto the public status", async () => {
		const failure = await adapterFailure(401, "authentication_error");
		await withTempSession(async sessionFile => {
			const store = createReconciliationStore({ sessionFile, sessionId: "host", now: () => 1_000 });
			const reconciliation = createInvocationReconciliation({ store });
			reconciliation.admit("prompt", "ref");
			await reconciliation.noteAccepted("prompt", correlation, "ref");
			await reconciliation.noteTransition("prompt", correlation, { type: "agent_start" });
			await reconciliation.noteTransition("prompt", correlation, {
				type: "agent_failed",
				error: {
					code: "provider_rejected",
					message: "Agent run failed.",
					providerDiagnostic: failure.providerDiagnostic,
				},
			});
			await reconciliation.noteTransition("prompt", correlation, { type: "agent_end" });

			const result = reconciliation.lookupResult("prompt", { clientRef: "ref" }) as {
				status: string;
				error: { code: string; message: string };
				outcome?: { kind: string; code: string; providerCode?: string; providerDiagnostic?: unknown };
			};
			expect(result.status).toBe("failed");
			expect(result.error.code).toBe("provider_rejected");
			expect(result.outcome?.kind).toBe("failed");
			expect(result.outcome?.code).toBe("prompt_failed");
			expect(result.outcome?.providerDiagnostic).toEqual(AUTH_DIAGNOSTIC);
			expect(JSON.stringify(result)).not.toContain(SECRET_MARKER);
		});
	});

	test("persists the diagnostic and reloads it from disk in the bus reconciler", async () => {
		const failure = await adapterFailure(500, "api_error");
		await withTempSession(async sessionFile => {
			const store = createReconciliationStore({ sessionFile, sessionId: "bus", now: () => 1_000 });
			const reconciliation = createKindAwareReconciliation({ store, now: () => 1_000 });
			reconciliation.admit("prompt", "ref");
			await reconciliation.noteAccepted("prompt", correlation, "ref");
			await reconciliation.noteTransition("prompt", correlation, { type: "agent_start" });
			await reconciliation.noteTransition("prompt", correlation, {
				type: "agent_failed",
				error: {
					code: "provider_rejected",
					message: "Agent run failed.",
					providerDiagnostic: failure.providerDiagnostic,
				},
			});
			await reconciliation.noteTransition("prompt", correlation, { type: "agent_end" });

			// Assert against the bytes actually on disk, not an in-memory snapshot.
			const documentPath = path.join(path.dirname(sessionFile), ".sdk-reconciliation", "bus.json");
			const persisted = await fs.readFile(documentPath, "utf8");
			expect(persisted).not.toContain(SECRET_MARKER);
			expect(persisted).toContain("api_error");

			// A genuinely new process: fresh store, fresh reconciler, real reload.
			const reopenedStore = createReconciliationStore({ sessionFile, sessionId: "bus", now: () => 2_000 });
			const reopened = createKindAwareReconciliation({ store: reopenedStore, now: () => 2_000 });
			await reopened.hydrateFromStore();
			const reloaded = reopened.lookup("prompt", { clientRef: "ref" }) as {
				status: string;
				outcome?: { kind: string; providerDiagnostic?: unknown };
				error: { code: string };
			};

			expect(reloaded.status).toBe("failed");
			expect(reloaded.error.code).toBe("provider_rejected");
			expect(reloaded.outcome?.providerDiagnostic).toEqual({
				category: "provider_unavailable",
				httpStatus: 500,
				code: "api_error",
				evidence: "structured_code",
			});
		});
	});

	test("strips a malformed durable diagnostic without invalidating the legacy record", async () => {
		await withTempSession(async sessionFile => {
			const store = createReconciliationStore({ sessionFile, sessionId: "legacy", now: () => 1_000 });
			await store.transact(() => [
				{
					kind: "prompt",
					commandId: "c1",
					turnId: "t1",
					clientRef: "legacy-ref",
					status: "failed",
					acceptedAt: 1,
					startedAt: 1,
					terminalAt: 2,
					error: { code: "provider_rejected", message: "Provider failure after execution started." },
					outcome: {
						kind: "failed",
						code: "prompt_failed",
						message: "Provider failure after execution started.",
						provenance: "agent_failed",
						phase: "post_start",
						category: "provider_rejected",
						providerCode: "provider_rejected",
						providerDiagnostic: { category: "quota", evidence: "message_text", detail: SECRET_MARKER } as never,
					},
					receiptState: "missing",
				},
			]);

			const reopened = createKindAwareReconciliation({
				store: createReconciliationStore({ sessionFile, sessionId: "legacy", now: () => 2_000 }),
				now: () => 2_000,
			});
			await reopened.hydrateFromStore();
			const reloaded = reopened.lookup("prompt", { clientRef: "legacy-ref" }) as {
				status: string;
				receiptState: string;
				error: { code: string; message: string };
				outcome?: { kind: string; code: string; providerCode?: string; providerDiagnostic?: unknown };
			};

			expect(reloaded.status).toBe("failed");
			expect(reloaded.receiptState).toBe("missing");
			// Legacy sanitization of the durable error is untouched by this change.
			expect(reloaded.error).toEqual({ code: "provider_rejected", message: "Prompt submission failed." });
			expect(reloaded.outcome?.code).toBe("prompt_failed");
			expect(reloaded.outcome?.providerCode).toBe("provider_rejected");
			expect(reloaded.outcome?.providerDiagnostic).toBeUndefined();
			expect(JSON.stringify(reloaded)).not.toContain(SECRET_MARKER);
		});
	});

	test("preserves the diagnostic through pending-outcome restart settlement", async () => {
		const failure = await adapterFailure(429, "rate_limit_error");
		await withTempSession(async sessionFile => {
			const store = createReconciliationStore({ sessionFile, sessionId: "restart", now: () => 1_000 });
			const reconciliation = createKindAwareReconciliation({ store, now: () => 1_000 });
			reconciliation.admit("prompt", "ref");
			await reconciliation.noteAccepted("prompt", correlation, "ref");
			await reconciliation.noteTransition("prompt", correlation, { type: "agent_start" });
			await reconciliation.claimPendingOutcome("prompt", correlation, {
				kind: "failed",
				code: "prompt_failed",
				message: "Provider failure after execution started.",
				provenance: "agent_failed",
				phase: "post_start",
				category: "provider_rejected",
				providerCode: "provider_rejected",
				providerDiagnostic: failure.providerDiagnostic,
			} as never);

			const reopened = createKindAwareReconciliation({
				store: createReconciliationStore({ sessionFile, sessionId: "restart", now: () => 2_000 }),
				now: () => 2_000,
			});
			await reopened.hydrateFromStore();
			const settled = reopened.lookup("prompt", { clientRef: "ref" }) as {
				status: string;
				outcome?: { kind: string; providerDiagnostic?: unknown };
			};

			expect(settled.status).toBe("failed");
			expect(settled.outcome?.providerDiagnostic).toEqual({
				category: "rate_limit",
				httpStatus: 429,
				code: "rate_limit_error",
				evidence: "structured_code",
			});
		});
	});

	test("admits a late missing-to-valid enrichment but never rewrites a settled terminal", async () => {
		const failure = await adapterFailure(401, "authentication_error");
		await withTempSession(async sessionFile => {
			const store = createReconciliationStore({ sessionFile, sessionId: "late", now: () => 1_000 });
			const reconciliation = createKindAwareReconciliation({ store, now: () => 1_000 });
			reconciliation.admit("prompt", "ref");
			await reconciliation.noteAccepted("prompt", correlation, "ref");
			await reconciliation.noteTransition("prompt", correlation, { type: "agent_start" });
			await reconciliation.noteTransition("prompt", correlation, {
				type: "agent_failed",
				error: { code: "provider_rejected", message: "Agent run failed." },
			});
			await reconciliation.noteTransition("prompt", correlation, { type: "agent_end" });

			const before = reconciliation.lookup("prompt", { clientRef: "ref" }) as {
				status: string;
				terminalAt: number;
				outcome?: { providerDiagnostic?: unknown; providerCode?: string };
			};
			expect(before.outcome?.providerDiagnostic).toBeUndefined();

			await reconciliation.noteTransition("prompt", correlation, {
				type: "agent_failed",
				error: {
					code: "provider_rejected",
					message: "Agent run failed.",
					providerDiagnostic: failure.providerDiagnostic,
				},
			});

			const enriched = reconciliation.lookup("prompt", { clientRef: "ref" }) as {
				status: string;
				terminalAt: number;
				error: { code: string };
				outcome?: { providerDiagnostic?: unknown; providerCode?: string };
			};
			expect(enriched.status).toBe(before.status);
			expect(enriched.terminalAt).toBe(before.terminalAt);
			expect(enriched.error.code).toBe("provider_rejected");
			expect(enriched.outcome?.providerCode).toBe(before.outcome?.providerCode);
			expect(enriched.outcome?.providerDiagnostic).toEqual(AUTH_DIAGNOSTIC);

			// A conflicting late diagnostic does not overwrite the settled one.
			await reconciliation.noteTransition("prompt", correlation, {
				type: "agent_failed",
				error: {
					code: "provider_rejected",
					message: "Agent run failed.",
					providerDiagnostic: {
						category: "provider_unavailable",
						httpStatus: 500,
						code: "api_error",
						evidence: "structured_code",
					},
				},
			});
			const afterConflict = reconciliation.lookup("prompt", { clientRef: "ref" }) as {
				outcome?: { providerDiagnostic?: unknown };
			};
			expect(afterConflict.outcome?.providerDiagnostic).toEqual(AUTH_DIAGNOSTIC);
		});
	});
});
