import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createKindAwareReconciliation, type KindAwareReconciliation } from "../src/sdk/bus/kind-aware-reconciliation";
import { createReconciliationStore } from "../src/sdk/bus/reconciliation-store";
import { createInvocationReconciliation, type InvocationReconciliation } from "../src/sdk/host/session-runtime";
import { failedPromptOutcome, publicTerminalOutcome, rephaseFailedOutcome } from "../src/sdk/prompt-failure";

/**
 * Hardening counterexamples from the independent review.
 *
 * Each test is the minimal input that the shipped code accepts but the
 * contract forbids: a diagnostic whose core fields are valid and which
 * therefore skipped canonicalization (R1), a host hydrate that never validated
 * at all (R2), a late reason or finalization that dropped an already collected
 * diagnostic (R3), and an enrichment that ignored which failure it belonged to
 * (R7).
 */

const MARKER = "SYNTHETIC-SECRET-MARKER-sdk";

const AUTH_DIAGNOSTIC = {
	category: "auth",
	httpStatus: 401,
	code: "authentication_error",
	evidence: "structured_code",
} as const;

const correlation = { commandId: "c1", turnId: "t1" };

type FailedOutcome = {
	kind: string;
	code: string;
	message: string;
	provenance?: string;
	phase?: string;
	category?: string;
	providerCode?: string;
	providerDiagnostic?: Record<string, unknown>;
};

type TerminalRow = {
	status: string;
	receiptState?: string;
	terminalAt?: number;
	error?: { code: string; message: string };
	outcome?: FailedOutcome;
};

async function withTempSession<T>(run: (sessionFile: string, root: string) => Promise<T>): Promise<T> {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "provider-diagnostic-hardening-"));
	try {
		const sessionFile = path.join(root, "s.jsonl");
		await fs.writeFile(sessionFile, "");
		return await run(sessionFile, root);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

/** A durable failed row whose diagnostic has a valid core plus forbidden extras. */
function rowWithDiagnostic(diagnostic: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown {
	return {
		kind: "prompt",
		commandId: correlation.commandId,
		turnId: correlation.turnId,
		clientRef: "ref",
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
			providerDiagnostic: diagnostic,
		},
		receiptState: "missing",
		...extra,
	};
}

describe("R1 durable diagnostic canonicalization", () => {
	test("replaces a valid-core diagnostic that carries extra keys, on disk and in the public result", async () => {
		await withTempSession(async sessionFile => {
			const store = createReconciliationStore({ sessionFile, sessionId: "r1", now: () => 1_000 });
			await store.transact(
				() => [rowWithDiagnostic({ ...AUTH_DIAGNOSTIC, detail: MARKER, padding: "x".repeat(4_096) })] as never,
			);

			const reopened = createKindAwareReconciliation({
				store: createReconciliationStore({ sessionFile, sessionId: "r1", now: () => 2_000 }),
				now: () => 2_000,
			});
			await reopened.hydrateFromStore();
			const reloaded = reopened.lookup("prompt", { clientRef: "ref" }) as TerminalRow;

			expect(reloaded.status).toBe("failed");
			expect(reloaded.receiptState).toBe("missing");
			expect(reloaded.error).toEqual({ code: "provider_rejected", message: "Prompt submission failed." });
			expect(reloaded.outcome?.providerCode).toBe("provider_rejected");
			expect(reloaded.outcome?.providerDiagnostic).toEqual(AUTH_DIAGNOSTIC);
			expect(JSON.stringify(reloaded)).not.toContain(MARKER);

			// The durable document itself must not keep the extras either.
			const documentPath = path.join(path.dirname(sessionFile), ".sdk-reconciliation", "r1.json");
			const persisted = await fs.readFile(documentPath, "utf8");
			expect(persisted).not.toContain(MARKER);
			expect(persisted).toContain("authentication_error");
		});
	});

	test("canonicalizes a pendingOutcome diagnostic through restart settlement", async () => {
		await withTempSession(async sessionFile => {
			const store = createReconciliationStore({ sessionFile, sessionId: "r1p", now: () => 1_000 });
			await store.transact(
				() =>
					[
						{
							kind: "prompt",
							commandId: correlation.commandId,
							turnId: correlation.turnId,
							clientRef: "ref",
							status: "in_flight",
							acceptedAt: 1,
							startedAt: 1,
							pendingOutcome: {
								kind: "failed",
								code: "prompt_failed",
								message: "Provider failure after execution started.",
								provenance: "agent_failed",
								phase: "post_start",
								category: "provider_rejected",
								providerCode: "provider_rejected",
								providerDiagnostic: { ...AUTH_DIAGNOSTIC, detail: MARKER },
							},
							pendingReceiptState: "missing",
						},
					] as never,
			);

			const reopened = createKindAwareReconciliation({
				store: createReconciliationStore({ sessionFile, sessionId: "r1p", now: () => 2_000 }),
				now: () => 2_000,
			});
			await reopened.hydrateFromStore();
			const settled = reopened.lookup("prompt", { clientRef: "ref" }) as TerminalRow;

			expect(settled.status).toBe("failed");
			expect(settled.outcome?.providerDiagnostic).toEqual(AUTH_DIAGNOSTIC);
			expect(JSON.stringify(settled)).not.toContain(MARKER);
		});
	});

	test("survives hostile durable shapes and never shares mutable internal state", async () => {
		await withTempSession(async sessionFile => {
			const store = createReconciliationStore({ sessionFile, sessionId: "r1h", now: () => 1_000 });
			await store.transact(() => [rowWithDiagnostic({ ...AUTH_DIAGNOSTIC })] as never);
			const reconciliation = createKindAwareReconciliation({
				store: createReconciliationStore({ sessionFile, sessionId: "r1h", now: () => 2_000 }),
				now: () => 2_000,
			});
			await reconciliation.hydrateFromStore();

			const first = reconciliation.lookup("prompt", { clientRef: "ref" }) as TerminalRow;
			expect(first.outcome?.providerDiagnostic).toEqual(AUTH_DIAGNOSTIC);
			// A caller mutating the returned DTO must not rewrite stored state.
			(first.outcome as { providerDiagnostic?: unknown }).providerDiagnostic = { category: "quota", detail: MARKER };
			const second = reconciliation.lookup("prompt", { clientRef: "ref" }) as TerminalRow;
			expect(second.outcome?.providerDiagnostic).toEqual(AUTH_DIAGNOSTIC);
			expect(JSON.stringify(second)).not.toContain(MARKER);
		});
	});

	test("drops a diagnostic whose accessors throw or whose prototype lies", async () => {
		await withTempSession(async sessionFile => {
			const store = createReconciliationStore({ sessionFile, sessionId: "r1x", now: () => 1_000 });
			// Written through JSON, a getter/toJSON trap degrades to its serialized
			// shape; the durable row therefore carries the hostile *result*.
			await store.transact(
				() => [rowWithDiagnostic({ category: "auth", evidence: "structured_code", detail: MARKER })] as never,
			);
			const reconciliation = createKindAwareReconciliation({
				store: createReconciliationStore({ sessionFile, sessionId: "r1x", now: () => 2_000 }),
				now: () => 2_000,
			});
			await reconciliation.hydrateFromStore();

			const row = reconciliation.lookup("prompt", { clientRef: "ref" }) as TerminalRow;
			expect(row.status).toBe("failed");
			expect(row.outcome?.providerDiagnostic).toBeUndefined();
			expect(JSON.stringify(row)).not.toContain(MARKER);
		});
	});
});

describe("R1 residual: canonical replacement must not depend on the value it replaces", () => {
	const core = {
		category: "auth",
		httpStatus: 401,
		code: "authentication_error",
		evidence: "structured_code",
	} as const;

	function failedBase() {
		return failedPromptOutcome({
			code: "prompt_failed",
			provenance: "agent_failed",
			providerCode: "provider_rejected",
			evidence: { startedAt: 1 },
		});
	}

	test("public projection drops a malformed diagnostic instead of spreading nothing over it", () => {
		const malformed = {
			...failedBase(),
			providerDiagnostic: { category: "quota", evidence: "message_text", detail: MARKER },
		};

		const projected = publicTerminalOutcome(malformed as never) as FailedOutcome;

		expect(projected.providerDiagnostic).toBeUndefined();
		expect(JSON.stringify(projected)).not.toContain(MARKER);
		// The legacy failure is untouched by the drop.
		expect(projected.code).toBe("prompt_failed");
		expect(projected.providerCode).toBe("provider_rejected");
		expect(projected.message).toBe(malformed.message);
	});

	test("rephase replaces a diagnostic whose payload hides behind the prototype", () => {
		// Own data properties match the canonical value exactly; the hostile part
		// is an inherited toJSON, which a key/value comparison cannot see.
		const hostile = Object.assign(
			Object.create({
				toJSON() {
					return { detail: MARKER };
				},
			}),
			core,
		);
		const input = { ...failedBase(), providerDiagnostic: hostile };

		const rephased = rephaseFailedOutcome(input as never, { startedAt: 1 }) as FailedOutcome;

		expect(JSON.stringify(rephased)).not.toContain(MARKER);
		expect(rephased).not.toBe(input);
		expect(rephased.providerDiagnostic).toEqual(core);
		expect(Object.getPrototypeOf(rephased.providerDiagnostic as object)).toBe(Object.prototype);
	});

	test("rephase replaces a diagnostic whose core fields are getters", () => {
		const trapped = Object.defineProperties(
			{},
			{
				category: { get: () => "auth", enumerable: true },
				httpStatus: { get: () => 401, enumerable: true },
				code: { get: () => "authentication_error", enumerable: true },
				evidence: { get: () => "structured_code", enumerable: true },
				toJSON: { value: () => ({ detail: MARKER }), enumerable: false },
			},
		);
		const input = { ...failedBase(), providerDiagnostic: trapped };

		const rephased = rephaseFailedOutcome(input as never, { startedAt: 1 }) as FailedOutcome;

		expect(JSON.stringify(rephased)).not.toContain(MARKER);
		expect(rephased.providerDiagnostic).toEqual(core);
		expect(Object.getOwnPropertyNames(rephased.providerDiagnostic as object).sort()).toEqual([
			"category",
			"code",
			"evidence",
			"httpStatus",
		]);
	});

	test("an already canonical diagnostic is left alone", () => {
		const input = { ...failedBase(), providerDiagnostic: { ...core } };
		const rephased = rephaseFailedOutcome(input as never, { startedAt: 1 });
		expect(rephased).toBe(input);
	});
});

describe("R2 host hydrate validation", () => {
	test("canonicalizes durable diagnostics when the host reconciler reloads from the store", async () => {
		await withTempSession(async sessionFile => {
			const store = createReconciliationStore({ sessionFile, sessionId: "r2", now: () => 1_000 });
			await store.transact(() => [rowWithDiagnostic({ ...AUTH_DIAGNOSTIC, detail: MARKER })] as never);

			const host = createInvocationReconciliation({
				store: createReconciliationStore({ sessionFile, sessionId: "r2", now: () => 2_000 }),
			});
			await host.hydrate();
			const row = host.lookupResult("prompt", { clientRef: "ref" }) as TerminalRow;

			expect(row.status).toBe("failed");
			expect(row.receiptState).toBe("missing");
			expect(row.outcome?.providerCode).toBe("provider_rejected");
			expect(row.outcome?.providerDiagnostic).toEqual(AUTH_DIAGNOSTIC);
			expect(JSON.stringify(row)).not.toContain(MARKER);
		});
	});

	test("strips a fully malformed durable diagnostic without invalidating the legacy row", async () => {
		await withTempSession(async sessionFile => {
			const store = createReconciliationStore({ sessionFile, sessionId: "r2m", now: () => 1_000 });
			await store.transact(
				() => [rowWithDiagnostic({ category: "quota", evidence: "message_text", detail: MARKER })] as never,
			);

			const host = createInvocationReconciliation({
				store: createReconciliationStore({ sessionFile, sessionId: "r2m", now: () => 2_000 }),
			});
			await host.hydrate();
			const row = host.lookupResult("prompt", { clientRef: "ref" }) as TerminalRow;

			expect(row.status).toBe("failed");
			expect(row.receiptState).toBe("missing");
			expect(row.outcome?.code).toBe("prompt_failed");
			expect(row.outcome?.providerCode).toBe("provider_rejected");
			expect(row.outcome?.providerDiagnostic).toBeUndefined();
			expect(JSON.stringify(row)).not.toContain(MARKER);
		});
	});

	test("never shares mutable diagnostic state through the host projection", async () => {
		await withTempSession(async sessionFile => {
			const store = createReconciliationStore({ sessionFile, sessionId: "r2s", now: () => 1_000 });
			await store.transact(() => [rowWithDiagnostic({ ...AUTH_DIAGNOSTIC })] as never);
			const host = createInvocationReconciliation({
				store: createReconciliationStore({ sessionFile, sessionId: "r2s", now: () => 2_000 }),
			});
			await host.hydrate();

			const first = host.lookupResult("prompt", { clientRef: "ref" }) as TerminalRow;
			(first.outcome as { providerDiagnostic?: unknown }).providerDiagnostic = { category: "quota", detail: MARKER };
			const second = host.lookupResult("prompt", { clientRef: "ref" }) as TerminalRow;

			expect(second.outcome?.providerDiagnostic).toEqual(AUTH_DIAGNOSTIC);
			expect(JSON.stringify(second)).not.toContain(MARKER);
		});
	});

	test("hydrates a legacy row that has no diagnostic at all without inventing one", async () => {
		await withTempSession(async sessionFile => {
			const store = createReconciliationStore({ sessionFile, sessionId: "r2a", now: () => 1_000 });
			const row = rowWithDiagnostic({}) as Record<string, unknown>;
			delete (row.outcome as Record<string, unknown>).providerDiagnostic;
			await store.transact(() => [row] as never);

			const host = createInvocationReconciliation({
				store: createReconciliationStore({ sessionFile, sessionId: "r2a", now: () => 2_000 }),
			});
			await host.hydrate();
			const hydrated = host.lookupResult("prompt", { clientRef: "ref" }) as TerminalRow;

			expect(hydrated.status).toBe("failed");
			expect(hydrated.receiptState).toBe("missing");
			expect(hydrated.terminalAt).toBe(2);
			expect(hydrated.outcome?.code).toBe("prompt_failed");
			expect(hydrated.outcome?.providerCode).toBe("provider_rejected");
			expect(hydrated.outcome?.providerDiagnostic).toBeUndefined();
			expect(Object.hasOwn(hydrated.outcome as object, "providerDiagnostic")).toBe(false);
		});
	});

	test("canonicalizes the legacy stateRoot/sessionId hydrate path", async () => {
		await withTempSession(async (_sessionFile, root) => {
			const stateRoot = path.join(root, "state");
			await fs.mkdir(path.join(stateRoot, ".sdk-reconciliation"), { recursive: true });
			await fs.writeFile(
				path.join(stateRoot, ".sdk-reconciliation", "legacy.json"),
				JSON.stringify({
					version: 1,
					sessionId: "legacy",
					records: [rowWithDiagnostic({ ...AUTH_DIAGNOSTIC, detail: MARKER })],
				}),
			);

			const host = createInvocationReconciliation({ stateRoot, sessionId: "legacy" });
			await host.hydrate();
			const row = host.lookupResult("prompt", { clientRef: "ref" }) as TerminalRow;

			expect(row.status).toBe("failed");
			expect(row.outcome?.providerDiagnostic).toEqual(AUTH_DIAGNOSTIC);
			expect(JSON.stringify(row)).not.toContain(MARKER);
		});
	});
});

describe("R3 host late enrichment and finalization", () => {
	test("admits a same-code late diagnostic onto a settled host terminal", async () => {
		await withTempSession(async sessionFile => {
			const host = createInvocationReconciliation({
				store: createReconciliationStore({ sessionFile, sessionId: "r3", now: () => 1_000 }),
			});
			host.admit("prompt", "ref");
			await host.noteAccepted("prompt", correlation, "ref");
			await host.noteTransition("prompt", correlation, { type: "agent_start" });
			await host.noteTransition("prompt", correlation, {
				type: "agent_failed",
				error: { code: "provider_rejected", message: "Agent run failed." },
			});
			await host.noteTransition("prompt", correlation, { type: "agent_end" });
			const before = host.lookupResult("prompt", { clientRef: "ref" }) as TerminalRow;
			expect(before.outcome?.providerDiagnostic).toBeUndefined();

			await host.noteTransition("prompt", correlation, {
				type: "agent_failed",
				error: { code: "provider_rejected", message: "Agent run failed.", providerDiagnostic: AUTH_DIAGNOSTIC },
			});
			const after = host.lookupResult("prompt", { clientRef: "ref" }) as TerminalRow;

			expect(after.outcome?.providerDiagnostic).toEqual(AUTH_DIAGNOSTIC);
			expect(after.status).toBe(before.status);
			expect(after.terminalAt).toBe(before.terminalAt);
			expect(after.receiptState).toBe(before.receiptState);
			expect(after.error?.code).toBe(before.error?.code);
			expect(after.outcome?.code).toBe(before.outcome?.code);
			expect(after.outcome?.providerCode).toBe(before.outcome?.providerCode);
		});
	});

	test("keeps a collected diagnostic through finalizeOutcome", async () => {
		await withTempSession(async sessionFile => {
			const host = createInvocationReconciliation({
				store: createReconciliationStore({ sessionFile, sessionId: "r3f", now: () => 1_000 }),
			});
			host.admit("prompt", "ref");
			await host.noteAccepted("prompt", correlation, "ref");
			await host.noteTransition("prompt", correlation, { type: "agent_start" });
			await host.noteTransition("prompt", correlation, {
				type: "agent_failed",
				error: { code: "provider_rejected", message: "Agent run failed.", providerDiagnostic: AUTH_DIAGNOSTIC },
			});

			await host.finalizeOutcome("prompt", correlation);
			const row = host.lookupResult("prompt", { clientRef: "ref" }) as TerminalRow;

			expect(row.status).toBe("failed");
			expect(row.error?.code).toBe("provider_rejected");
			expect(row.outcome?.code).toBe("prompt_failed");
			expect(row.outcome?.providerCode).toBe("provider_rejected");
			expect(row.outcome?.providerDiagnostic).toEqual(AUTH_DIAGNOSTIC);
		});
	});
});

describe("R7 same-primary-code attribution", () => {
	const rateLimitDiagnostic = {
		category: "rate_limit",
		httpStatus: 429,
		code: "rate_limit_error",
		evidence: "structured_code",
	} as const;

	async function settledFailure(sessionFile: string, sessionId: string) {
		const reconciliation = createKindAwareReconciliation({
			store: createReconciliationStore({ sessionFile, sessionId, now: () => 1_000 }),
			now: () => 1_000,
		});
		reconciliation.admit("prompt", "ref");
		await reconciliation.noteAccepted("prompt", correlation, "ref");
		await reconciliation.noteTransition("prompt", correlation, { type: "agent_start" });
		await reconciliation.noteTransition("prompt", correlation, {
			type: "agent_failed",
			error: { code: "provider_rejected", message: "Agent run failed." },
		});
		await reconciliation.noteTransition("prompt", correlation, { type: "agent_end" });
		return reconciliation;
	}

	test("ignores a late diagnostic that belongs to a different primary code (bus)", async () => {
		await withTempSession(async sessionFile => {
			const reconciliation = await settledFailure(sessionFile, "r7bus");
			const before = reconciliation.lookup("prompt", { clientRef: "ref" }) as TerminalRow;

			await reconciliation.noteTransition("prompt", correlation, {
				type: "agent_failed",
				error: { code: "provider_http_429", message: "Agent run failed.", providerDiagnostic: rateLimitDiagnostic },
			});
			const after = reconciliation.lookup("prompt", { clientRef: "ref" }) as TerminalRow;

			expect(after.error?.code).toBe("provider_rejected");
			expect(after.outcome?.providerCode).toBe(before.outcome?.providerCode);
			expect(after.outcome?.providerDiagnostic).toBeUndefined();
			expect(after.terminalAt).toBe(before.terminalAt);
			expect(after.status).toBe(before.status);
		});
	});

	test("ignores a different-code late diagnostic on the host and keeps an existing one", async () => {
		await withTempSession(async sessionFile => {
			const host = createInvocationReconciliation({
				store: createReconciliationStore({ sessionFile, sessionId: "r7host", now: () => 1_000 }),
			});
			host.admit("prompt", "ref");
			await host.noteAccepted("prompt", correlation, "ref");
			await host.noteTransition("prompt", correlation, { type: "agent_start" });
			await host.noteTransition("prompt", correlation, {
				type: "agent_failed",
				error: { code: "provider_rejected", message: "Agent run failed.", providerDiagnostic: AUTH_DIAGNOSTIC },
			});
			await host.noteTransition("prompt", correlation, { type: "agent_end" });
			const before = host.lookupResult("prompt", { clientRef: "ref" }) as TerminalRow;
			expect(before.outcome?.providerDiagnostic).toEqual(AUTH_DIAGNOSTIC);

			// Different code: must not attach. Same code with a conflicting value:
			// the settled diagnostic wins.
			await host.noteTransition("prompt", correlation, {
				type: "agent_failed",
				error: { code: "provider_http_429", message: "Agent run failed.", providerDiagnostic: rateLimitDiagnostic },
			});
			await host.noteTransition("prompt", correlation, {
				type: "agent_failed",
				error: { code: "provider_rejected", message: "Agent run failed.", providerDiagnostic: rateLimitDiagnostic },
			});
			const after = host.lookupResult("prompt", { clientRef: "ref" }) as TerminalRow;

			expect(after.outcome?.providerDiagnostic).toEqual(AUTH_DIAGNOSTIC);
			expect(after.error?.code).toBe(before.error?.code);
			expect(after.terminalAt).toBe(before.terminalAt);
			expect(after.receiptState).toBe(before.receiptState);
		});
	});

	test("ignores a late duplicate and a cross-kind diagnostic", async () => {
		await withTempSession(async sessionFile => {
			const reconciliation = await settledFailure(sessionFile, "r7dup");
			await reconciliation.noteTransition("prompt", correlation, {
				type: "agent_failed",
				error: { code: "provider_rejected", message: "Agent run failed.", providerDiagnostic: AUTH_DIAGNOSTIC },
			});
			const enriched = reconciliation.lookup("prompt", { clientRef: "ref" }) as TerminalRow;
			expect(enriched.outcome?.providerDiagnostic).toEqual(AUTH_DIAGNOSTIC);

			// An identical late duplicate changes nothing.
			await reconciliation.noteTransition("prompt", correlation, {
				type: "agent_failed",
				error: { code: "provider_rejected", message: "Agent run failed.", providerDiagnostic: AUTH_DIAGNOSTIC },
			});
			// A same-correlation frame aimed at the OTHER kind must not touch it.
			await reconciliation.noteTransition("skill", correlation, {
				type: "agent_failed",
				error: {
					code: "provider_rejected",
					message: "Agent run failed.",
					providerDiagnostic: rateLimitDiagnostic,
				},
			});

			const after = reconciliation.lookup("prompt", { clientRef: "ref" }) as TerminalRow;
			expect(after.outcome?.providerDiagnostic).toEqual(AUTH_DIAGNOSTIC);
			expect(after.terminalAt).toBe(enriched.terminalAt);
			expect(after.status).toBe(enriched.status);
			expect(after.error?.code).toBe(enriched.error?.code);
		});
	});

	test("ignores a late diagnostic aimed at a different correlation", async () => {
		await withTempSession(async sessionFile => {
			const reconciliation = await settledFailure(sessionFile, "r7corr");
			await reconciliation.noteTransition(
				"prompt",
				{ commandId: "other", turnId: "other" },
				{
					type: "agent_failed",
					error: { code: "provider_rejected", message: "Agent run failed.", providerDiagnostic: AUTH_DIAGNOSTIC },
				},
			);
			const after = reconciliation.lookup("prompt", { clientRef: "ref" }) as TerminalRow;
			expect(after.outcome?.providerDiagnostic).toBeUndefined();
		});
	});
});

describe("F1 both reconcilers deliver the same diagnostic on an agent_end that carries an outcome", () => {
	const ids = { commandId: "f1-c", turnId: "f1-t" };
	const sameFrameOutcome = () =>
		failedPromptOutcome({
			code: "prompt_failed",
			provenance: "agent_failed",
			providerCode: "provider_rejected",
			evidence: { startedAt: 1 },
		});

	for (const engine of ["bus", "host"] as const) {
		test(`${engine} reconciler keeps the earlier diagnostic when the terminal frame supplies the same primary outcome`, async () => {
			const reconciliation = engine === "bus" ? createKindAwareReconciliation() : createInvocationReconciliation();
			reconciliation.admit("prompt", "ref");
			await reconciliation.noteAccepted("prompt", ids, "ref");
			await reconciliation.noteTransition("prompt", ids, { type: "agent_start" });
			await reconciliation.noteTransition("prompt", ids, {
				type: "agent_failed",
				error: { code: "provider_rejected", message: "Agent run failed.", providerDiagnostic: AUTH_DIAGNOSTIC },
			} as never);
			await reconciliation.noteTransition("prompt", ids, {
				type: "agent_end",
				outcome: sameFrameOutcome(),
			} as never);

			const settled = reconciliation.lookup("prompt", { clientRef: "ref" }) as TerminalRow;
			// The chosen outcome and every legacy field stay exactly as the engine built them.
			expect(settled.status).toBe("failed");
			expect(settled.receiptState).toBe("missing");
			expect(settled.error?.code).toBe("provider_rejected");
			expect(settled.outcome?.code).toBe("prompt_failed");
			expect(settled.outcome?.provenance).toBe("agent_failed");
			expect(settled.outcome?.phase).toBe("post_start");
			expect(settled.outcome?.category).toBe("provider_rejected");
			expect(settled.outcome?.providerCode).toBe("provider_rejected");
			// Only the missing canonical field is filled.
			expect(settled.outcome?.providerDiagnostic).toEqual(AUTH_DIAGNOSTIC);
		});

		test(`${engine} reconciler leaves a terminal frame outcome undiagnosed when no diagnostic was recorded`, async () => {
			const reconciliation = engine === "bus" ? createKindAwareReconciliation() : createInvocationReconciliation();
			reconciliation.admit("prompt", "ref");
			await reconciliation.noteAccepted("prompt", ids, "ref");
			await reconciliation.noteTransition("prompt", ids, { type: "agent_start" });
			await reconciliation.noteTransition("prompt", ids, {
				type: "agent_failed",
				error: { code: "provider_rejected", message: "Agent run failed." },
			} as never);
			await reconciliation.noteTransition("prompt", ids, {
				type: "agent_end",
				outcome: sameFrameOutcome(),
			} as never);

			const settled = reconciliation.lookup("prompt", { clientRef: "ref" }) as TerminalRow;
			expect(settled.status).toBe("failed");
			expect(settled.outcome?.providerDiagnostic).toBeUndefined();
		});
	}
});

describe("F1 conflicting primary: a diagnostic is inherited only by its own failure", () => {
	const ids = { commandId: "cp-c", turnId: "cp-t" };
	const outcomeWithPrimary = (providerCode: string, diagnostic?: Record<string, unknown>) =>
		failedPromptOutcome({
			code: "prompt_failed",
			provenance: "agent_failed",
			providerCode,
			evidence: { startedAt: 1 },
			...(diagnostic === undefined ? {} : { providerDiagnostic: diagnostic as never }),
		});

	async function settle(
		engine: "bus" | "host",
		frameOutcome: ReturnType<typeof outcomeWithPrimary>,
		claimPendingFirst: boolean,
	): Promise<TerminalRow> {
		const reconciliation: KindAwareReconciliation | InvocationReconciliation =
			engine === "bus" ? createKindAwareReconciliation() : createInvocationReconciliation();
		reconciliation.admit("prompt", "ref");
		await reconciliation.noteAccepted("prompt", ids, "ref");
		await reconciliation.noteTransition("prompt", ids, { type: "agent_start" });
		await reconciliation.noteTransition("prompt", ids, {
			type: "agent_failed",
			error: { code: "provider_rejected", message: "Agent run failed.", providerDiagnostic: AUTH_DIAGNOSTIC },
		} as never);
		if (claimPendingFirst) {
			// Each engine exposes the pending claim under its own name; both stage the
			// same durable pendingOutcome the terminal branch then selects.
			if (engine === "bus")
				await (reconciliation as KindAwareReconciliation).claimPendingOutcome("prompt", ids, frameOutcome);
			else
				await (reconciliation as InvocationReconciliation).stagePendingTerminalOutcome(
					"prompt",
					ids,
					frameOutcome,
					true,
					undefined,
				);
		}
		await reconciliation.noteTransition("prompt", ids, { type: "agent_end", outcome: frameOutcome } as never);
		return reconciliation.lookup("prompt", { clientRef: "ref" }) as TerminalRow;
	}

	for (const engine of ["bus", "host"] as const) {
		for (const claimPendingFirst of [false, true]) {
			const branch = claimPendingFirst ? "pending" : "ordinary";

			test(`${engine}/${branch} keeps the diagnostic when the selected outcome has the same primary`, async () => {
				const settled = await settle(engine, outcomeWithPrimary("provider_rejected"), claimPendingFirst);
				expect(settled.status).toBe("failed");
				expect(settled.outcome?.providerCode).toBe("provider_rejected");
				expect(settled.outcome?.providerDiagnostic).toEqual(AUTH_DIAGNOSTIC);
			});

			test(`${engine}/${branch} does not inherit the diagnostic of a different failure`, async () => {
				const settled = await settle(engine, outcomeWithPrimary("provider_down"), claimPendingFirst);
				// Selection, legacy classification and receipt are untouched.
				expect(settled.status).toBe("failed");
				expect(settled.receiptState).toBe("missing");
				expect(settled.error?.code).toBe("provider_rejected");
				expect(settled.outcome?.code).toBe("prompt_failed");
				expect(settled.outcome?.providerCode).toBe("provider_down");
				// An auth/401 classification must never describe a provider_down terminal.
				expect(settled.outcome?.providerDiagnostic).toBeUndefined();
			});

			test(`${engine}/${branch} keeps an explicit carrier that the selected outcome brought itself`, async () => {
				const ownDiagnostic = {
					category: "provider_unavailable",
					httpStatus: 503,
					code: "overloaded_error",
					evidence: "structured_code",
				} as const;
				const settled = await settle(
					engine,
					outcomeWithPrimary("provider_down", { ...ownDiagnostic }),
					claimPendingFirst,
				);
				expect(settled.outcome?.providerCode).toBe("provider_down");
				expect(settled.outcome?.providerDiagnostic).toEqual(ownDiagnostic);
			});
		}
	}
});
