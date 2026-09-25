import { describe, expect, it } from "bun:test";
import {
	getDefault,
	getEnumValues,
	getUi,
	reconcileSettingsSchema,
	validateSettingPatch,
} from "../src/config/settings-schema";
import {
	createKevDecisionFetcher,
	DELEGATION_HINT_TIMEOUT_MS,
	DelegationHintController,
	type DelegationHintMetrics,
	KEV_SYSTEMONE_ENDPOINT,
	KEV_SYSTEMONE_MODEL,
	type KevFetchImplementation,
} from "../src/task/delegation-hint";

function response(content: unknown, status = 200, contentType = "application/json"): Response {
	return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), {
		status,
		headers: { "content-type": contentType },
	});
}

function controller(options?: {
	mode?: unknown;
	autoroutingEnabled?: unknown;
	tiers?: unknown;
	fetcher?: KevFetchImplementation;
	notify?: (message: string) => void;
}): DelegationHintController {
	return new DelegationHintController({
		getMode: () => options?.mode ?? "off",
		getAutoroutingEnabled: () => options?.autoroutingEnabled ?? false,
		getAutoroutingTiers: () => options?.tiers ?? {},
		notify: message => options?.notify?.(message),
		fetcher: options?.fetcher,
	});
}

function fixtureFetch(
	content: unknown,
	onRequest?: (input: string | URL | Request, init?: RequestInit) => void,
): KevFetchImplementation {
	return async (input, init) => {
		onRequest?.(input, init);
		return response(content);
	};
}

function edit(path: string): { path: string } {
	return { path };
}

const positiveDecision = { noul: true, p_delegate: 0.05, choice: "strong" };

async function flushTurn(): Promise<void> {
	await Bun.sleep(10);
}

async function triggerMultiPackageHint(hint: DelegationHintController): Promise<void> {
	hint.onTurnStart();
	for (const path of [
		"/synthetic/packages/alpha/src/a.ts",
		"/synthetic/packages/alpha/src/b.ts",
		"/synthetic/packages/beta/src/c.ts",
	]) {
		hint.observeAfterToolCall({ toolName: "edit", args: edit(path), isError: false });
	}
	await flushTurn();
}

describe("task delegation decision hint", () => {
	it("defaults off and exposes no enforce mode at either settings boundary", () => {
		const uiOptions = getUi("task.delegationHint.mode")?.options;
		expect(getDefault("task.delegationHint.mode")).toBe("off");
		expect(getEnumValues("task.delegationHint.mode")).toEqual(["off", "hint"]);
		expect(Array.isArray(uiOptions) ? uiOptions.map(option => option.value) : []).toEqual(["off", "hint"]);
		expect(reconcileSettingsSchema({ task: { delegationHint: { mode: "enforce" } } }).report).toMatchObject({
			valid: false,
			issues: [expect.objectContaining({ path: "task.delegationHint.mode", kind: "invalid" })],
		});
		expect(validateSettingPatch({ "task.delegationHint.mode": "enforce" })).toEqual([
			{ path: "task.delegationHint.mode", detail: "Expected enum." },
		]);
	});

	it("uses the fixed loopback service and sends only numeric aggregates without credentials", async () => {
		let called = false;
		const fetcher = createKevDecisionFetcher(
			fixtureFetch(positiveDecision, (input, init) => {
				called = true;
				expect(String(input)).toBe(KEV_SYSTEMONE_ENDPOINT);
				expect(init?.method).toBe("POST");
				expect(init?.redirect).toBe("error");
				expect(new Headers(init?.headers).get("authorization")).toBeNull();
				const payload = JSON.parse(String(init?.body));
				expect(payload.model).toBe(KEV_SYSTEMONE_MODEL);
				expect(payload.messages[1].content).toContain('"noul":"should delegate"');
				expect(JSON.parse(payload.messages[1].content).metrics).toEqual({
					toolCount: 4,
					editCount: 2,
					fileCount: 3,
					packageCount: 2,
					verificationCount: 1,
					consecutiveEdits: 2,
					activePlanStepCount: 4,
					remainingContextRatio: 0.625,
				});
				expect(JSON.stringify(payload)).not.toContain("private assignment text");
				expect(JSON.stringify(payload)).not.toContain("/synthetic/");
			}),
		);
		const metrics: DelegationHintMetrics = {
			toolCount: 4,
			editCount: 2,
			fileCount: 3,
			packageCount: 2,
			verificationCount: 1,
			consecutiveEdits: 2,
			activePlanStepCount: 4,
			remainingContextRatio: 0.625,
		};
		expect(await fetcher(metrics, ["fast", "strong"])).toEqual({ noul: true, pDelegate: 0.05, choice: "strong" });
		expect(called).toBe(true);
	});

	it("validates available tiers and requires null when no routing tier exists", async () => {
		const metrics: DelegationHintMetrics = {
			toolCount: 0,
			editCount: 0,
			fileCount: 0,
			packageCount: 0,
			verificationCount: 0,
			consecutiveEdits: 0,
			activePlanStepCount: 0,
		};
		const noTier = createKevDecisionFetcher(fixtureFetch({ noul: true, p_delegate: 0.7, choice: null }));
		expect(await noTier(metrics, [])).toEqual({ noul: true, pDelegate: 0.7, choice: null });

		const wrongTier = createKevDecisionFetcher(fixtureFetch({ noul: true, p_delegate: 0.7, choice: "strong" }));
		expect(await wrongTier(metrics, ["fast", "balanced"])).toBeUndefined();
		const extraKey = createKevDecisionFetcher(fixtureFetch({ ...positiveDecision, extra: true }));
		expect(await extraKey(metrics, ["strong"])).toBeUndefined();
		const badProbability = createKevDecisionFetcher(fixtureFetch({ ...positiveDecision, p_delegate: 1.1 }));
		expect(await badProbability(metrics, ["strong"])).toBeUndefined();
	});

	it("omits unknown context ratios and bounds numeric signals before serialization", async () => {
		let requestMetrics: Record<string, unknown> | undefined;
		const fetcher = createKevDecisionFetcher(
			fixtureFetch(positiveDecision, (_input, init) => {
				const payload = JSON.parse(String(init?.body));
				requestMetrics = JSON.parse(payload.messages[1].content).metrics;
			}),
		);
		const metrics: DelegationHintMetrics = {
			toolCount: 0,
			editCount: 0,
			fileCount: 0,
			packageCount: 0,
			verificationCount: 0,
			consecutiveEdits: 0,
			activePlanStepCount: 10_001,
			remainingContextRatio: 1.5,
		};
		await fetcher(metrics, []);
		expect(requestMetrics).toMatchObject({ activePlanStepCount: 10_000, remainingContextRatio: 1 });

		await fetcher({ ...metrics, activePlanStepCount: 3, remainingContextRatio: Number.NaN }, []);
		expect(requestMetrics).toEqual({
			toolCount: 0,
			editCount: 0,
			fileCount: 0,
			packageCount: 0,
			verificationCount: 0,
			consecutiveEdits: 0,
			activePlanStepCount: 3,
		});

		await fetcher({ ...metrics, activePlanStepCount: 3, remainingContextRatio: -0.25 }, []);
		expect(requestMetrics).toMatchObject({ remainingContextRatio: 0 });
	});

	it("fires only for observable multi-file activity and shows an ephemeral user notice", async () => {
		const notices: string[] = [];
		let requestMetrics: Record<string, unknown> | undefined;
		const hint = controller({
			mode: "hint",
			autoroutingEnabled: true,
			tiers: { fast: ["openai/fast"], strong: ["anthropic/strong"] },
			fetcher: fixtureFetch(positiveDecision, (_input, init) => {
				const payload = JSON.parse(String(init?.body));
				requestMetrics = JSON.parse(payload.messages[1].content).metrics;
			}),
			notify: message => notices.push(message),
		});
		hint.onTurnStart();
		for (const path of ["/synthetic/packages/alpha/a.ts", "/synthetic/packages/alpha/b.ts"]) {
			hint.observeAfterToolCall({
				toolName: "edit",
				args: edit(path),
				isError: false,
				getActivePlanStepCount: () => 2,
				getRemainingContextRatio: () => 0.35,
			});
		}
		await flushTurn();
		expect(requestMetrics).toBeUndefined();
		expect(notices).toHaveLength(0);

		const editArgs = edit("/synthetic/packages/beta/c.ts");
		const before = structuredClone(editArgs);
		hint.observeAfterToolCall({
			toolName: "edit",
			args: editArgs,
			isError: false,
			getActivePlanStepCount: () => 2,
			getRemainingContextRatio: () => 0.35,
		});
		await flushTurn();
		expect(editArgs).toEqual(before);
		expect(requestMetrics).toEqual({
			toolCount: 3,
			editCount: 3,
			fileCount: 3,
			packageCount: 2,
			verificationCount: 0,
			consecutiveEdits: 3,
			activePlanStepCount: 2,
			remainingContextRatio: 0.35,
		});
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("task(executor, tier=strong)");
		expect(notices[0]).toContain("p_delegate=0.05");
		expect(notices[0]).toContain("active_plan_steps=2");
		expect(notices[0]).toContain("remaining_context_ratio=0.35");
		expect(notices[0]).not.toContain("/synthetic/");
	});

	it("counts bounded apply_patch file headers without sending patch content", async () => {
		let metrics: unknown;
		let sent = "";
		const notices: string[] = [];
		const patch = [
			"*** Begin Patch",
			"*** Add File: packages/alpha/a.ts",
			"+private patch body alpha",
			"*** Add File: packages/beta/b.ts",
			"+private patch body beta",
			"*** Add File: packages/gamma/c.ts",
			"+private patch body gamma",
			"*** End Patch",
		].join("\n");
		const hint = controller({
			mode: "hint",
			autoroutingEnabled: true,
			tiers: { strong: ["anthropic/strong"] },
			fetcher: fixtureFetch(positiveDecision, (_input, init) => {
				const payload = JSON.parse(String(init?.body));
				metrics = JSON.parse(payload.messages[1].content).metrics;
				sent = JSON.stringify(payload);
			}),
			notify: message => notices.push(message),
		});
		hint.onTurnStart();
		hint.observeAfterToolCall({ toolName: "apply_patch", args: { input: patch }, isError: false });
		await flushTurn();
		expect(metrics).toEqual({
			toolCount: 1,
			editCount: 1,
			fileCount: 3,
			packageCount: 3,
			verificationCount: 0,
			consecutiveEdits: 1,
			activePlanStepCount: 0,
		});
		expect(sent).not.toContain("packages/alpha");
		expect(sent).not.toContain("private patch body");
		expect(notices).toHaveLength(1);
	});

	it("classifies a successful todo plan with three active steps and ignores failed writes", async () => {
		let requestMetrics: Record<string, unknown> | undefined;
		let requests = 0;
		let sent = "";
		const hint = controller({
			mode: "hint",
			fetcher: fixtureFetch(positiveDecision, (_input, init) => {
				requests++;
				const payload = JSON.parse(String(init?.body));
				requestMetrics = JSON.parse(payload.messages[1].content).metrics;
				sent = JSON.stringify(payload);
			}),
		});
		hint.onTurnStart();
		hint.observeAfterToolCall({
			toolName: "todo_write",
			args: { content: "private plan text" },
			isError: false,
			getActivePlanStepCount: () => 2,
		});
		await flushTurn();
		expect(requests).toBe(0);

		hint.observeAfterToolCall({
			toolName: "todo_write",
			args: { content: "private plan text" },
			isError: false,
			getActivePlanStepCount: () => 3,
			getRemainingContextRatio: () => 0.4,
		});
		await flushTurn();
		expect(requests).toBe(1);
		expect(requestMetrics).toMatchObject({
			toolCount: 2,
			editCount: 0,
			activePlanStepCount: 3,
			remainingContextRatio: 0.4,
		});
		expect(sent).not.toContain("private plan text");

		for (const failure of [{ isError: true }, { isError: false, resultError: true }]) {
			const failedHint = controller({
				mode: "hint",
				fetcher: fixtureFetch(positiveDecision, () => requests++),
			});
			failedHint.onTurnStart();
			failedHint.observeAfterToolCall({
				toolName: "todo_write",
				args: {},
				getActivePlanStepCount: () => 3,
				...failure,
			});
			await flushTurn();
		}
		expect(requests).toBe(1);
	});

	it("reads context usage only when an observable classification trigger fires", async () => {
		let contextReads = 0;
		let planReads = 0;
		let requests = 0;
		const hint = controller({
			mode: "hint",
			fetcher: fixtureFetch(positiveDecision, () => requests++),
		});
		const signalGetters = {
			getActivePlanStepCount: () => {
				planReads++;
				return 0;
			},
			getRemainingContextRatio: () => {
				contextReads++;
				return 0.4;
			},
		};
		hint.onTurnStart();
		hint.observeAfterToolCall({ toolName: "read", args: {}, isError: false, ...signalGetters });
		expect(planReads).toBe(0);
		expect(contextReads).toBe(0);
		for (let index = 0; index < 2; index++) {
			hint.observeAfterToolCall({
				toolName: "edit",
				args: edit("/synthetic/one/file.ts"),
				isError: false,
				...signalGetters,
			});
		}
		expect(planReads).toBe(2);
		expect(contextReads).toBe(0);

		hint.observeAfterToolCall({
			toolName: "edit",
			args: edit("/synthetic/one/file.ts"),
			isError: false,
			...signalGetters,
		});
		expect(contextReads).toBe(1);
		await flushTurn();
		expect(requests).toBe(1);
	});

	it("keeps the tier suggestion absent when no autorouting tier is configured", async () => {
		let choices: unknown;
		const notices: string[] = [];
		const hint = controller({
			mode: "hint",
			fetcher: fixtureFetch({ noul: true, p_delegate: 0.8, choice: null }, (_input, init) => {
				const payload = JSON.parse(String(init?.body));
				choices = JSON.parse(payload.messages[1].content).choice;
			}),
			notify: message => notices.push(message),
		});
		await triggerMultiPackageHint(hint);
		expect(choices).toEqual([]);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("task(executor)");
		expect(notices[0]).not.toContain("tier=");
	});

	it("limits repeated suggestions and deduplicates the same observable trigger signature", async () => {
		let requests = 0;
		let hints = 0;
		const hint = controller({
			mode: "hint",
			fetcher: fixtureFetch({ noul: true, p_delegate: 0.9, choice: null }, () => requests++),
			notify: () => {
				hints++;
			},
		});
		await triggerMultiPackageHint(hint);
		expect(requests).toBe(1);
		expect(hints).toBe(1);
		for (let turn = 0; turn < 2; turn++) {
			hint.onTurnStart();
			for (const path of [
				"/synthetic/packages/alpha/src/a.ts",
				"/synthetic/packages/alpha/src/b.ts",
				"/synthetic/packages/beta/src/c.ts",
			]) {
				hint.observeAfterToolCall({ toolName: "edit", args: edit(path), isError: false });
			}
			await flushTurn();
		}
		expect(requests).toBe(1);
		hint.onTurnStart();
		for (const path of [
			"/synthetic/packages/alpha/src/a.ts",
			"/synthetic/packages/alpha/src/b.ts",
			"/synthetic/packages/beta/src/c.ts",
		]) {
			hint.observeAfterToolCall({ toolName: "edit", args: edit(path), isError: false });
		}
		await flushTurn();
		expect(requests).toBe(2);
		expect(hints).toBe(1);
	});

	it("resets turn counters after verification and stays silent on negative decisions", async () => {
		let requests = 0;
		let hints = 0;
		const hint = controller({
			mode: "hint",
			fetcher: fixtureFetch({ noul: false, p_delegate: 0.4, choice: null }, () => requests++),
			notify: () => {
				hints++;
			},
		});
		hint.onTurnStart();
		for (let index = 0; index < 2; index++) {
			hint.observeAfterToolCall({ toolName: "edit", args: edit("/synthetic/packages/one/file.ts"), isError: false });
		}
		hint.observeAfterToolCall({ toolName: "bash", args: { command: "bun run test" }, isError: false });
		for (let index = 0; index < 2; index++) {
			hint.observeAfterToolCall({ toolName: "edit", args: edit("/synthetic/packages/one/file.ts"), isError: false });
		}
		await flushTurn();
		expect(requests).toBe(0);
		hint.observeAfterToolCall({ toolName: "edit", args: edit("/synthetic/packages/one/file.ts"), isError: false });
		await flushTurn();
		expect(requests).toBe(1);
		expect(hints).toBe(0);
	});

	it("fails open for invalid, unavailable, timed-out, and aborted local responses", async () => {
		const metrics: DelegationHintMetrics = {
			toolCount: 0,
			editCount: 0,
			fileCount: 0,
			packageCount: 0,
			verificationCount: 0,
			consecutiveEdits: 0,
			activePlanStepCount: 0,
		};
		const invalid = createKevDecisionFetcher(fixtureFetch({ noul: true, p_delegate: 2, choice: "strong" }));
		expect(await invalid(metrics, ["strong"])).toBeUndefined();
		const unavailable = createKevDecisionFetcher(async () => {
			throw new Error("synthetic local service failure");
		});
		expect(await unavailable(metrics, ["strong"])).toBeUndefined();

		let bodyCancelled = false;
		const wrongContentTypeBody = new ReadableStream<Uint8Array>({
			start(streamController) {
				streamController.enqueue(new TextEncoder().encode("not-json"));
			},
			cancel() {
				bodyCancelled = true;
			},
		});
		const wrongContentType = createKevDecisionFetcher(
			async () => new Response(wrongContentTypeBody, { status: 200, headers: { "content-type": "text/plain" } }),
		);
		expect(await wrongContentType(metrics, ["strong"])).toBeUndefined();
		expect(bodyCancelled).toBe(true);

		const timedOut = createKevDecisionFetcher(async (_input, init) => {
			const pending = Promise.withResolvers<Response>();
			init?.signal?.addEventListener("abort", () => pending.reject(new Error("synthetic timeout")), { once: true });
			return pending.promise;
		});
		const beforeTimeout = Date.now();
		expect(await timedOut(metrics, ["strong"])).toBeUndefined();
		expect(Date.now() - beforeTimeout).toBeGreaterThanOrEqual(DELEGATION_HINT_TIMEOUT_MS - 50);

		let called = false;
		const aborted = new AbortController();
		aborted.abort();
		const abortedFetcher = createKevDecisionFetcher(async () => {
			called = true;
			return response(positiveDecision);
		});
		expect(await abortedFetcher(metrics, ["strong"], aborted.signal)).toBeUndefined();
		expect(called).toBe(false);
	});

	it("aborts pending inference at a user-message boundary", async () => {
		const pending = Promise.withResolvers<Response>();
		const notices: string[] = [];
		let started = false;
		let requestSignal: AbortSignal | null | undefined;
		const hint = controller({
			mode: "hint",
			fetcher: async (_input, init) => {
				started = true;
				requestSignal = init?.signal;
				return pending.promise;
			},
			notify: message => notices.push(message),
		});
		hint.onTurnStart();
		for (let index = 0; index < 3; index++) {
			hint.observeAfterToolCall({
				toolName: "edit",
				args: edit(`/synthetic/packages/one/${index}.ts`),
				isError: false,
			});
		}
		await flushTurn();
		expect(started).toBe(true);
		hint.onUserMessage();
		expect(requestSignal?.aborted).toBe(true);
		pending.resolve(response(positiveDecision));
		await flushTurn();
		expect(notices).toHaveLength(0);
	});

	it("aborts an in-flight request immediately when hint mode is disabled", async () => {
		const pending = Promise.withResolvers<Response>();
		let requestSignal: AbortSignal | null | undefined;
		const hint = controller({
			mode: "hint",
			fetcher: async (_input, init) => {
				requestSignal = init?.signal;
				return pending.promise;
			},
		});
		await triggerMultiPackageHint(hint);
		expect(requestSignal?.aborted).toBe(false);
		hint.setEnabled(false);
		expect(requestSignal?.aborted).toBe(true);
		pending.resolve(response(positiveDecision));
		await flushTurn();
	});

	it("does not request hints while off or when the delegation trigger is absent", async () => {
		let requests = 0;
		const off = controller({ mode: "off", fetcher: fixtureFetch(positiveDecision, () => requests++) });
		off.onTurnStart();
		for (let index = 0; index < 3; index++) {
			off.observeAfterToolCall({
				toolName: "edit",
				args: edit(`/synthetic/packages/one/${index}.ts`),
				isError: false,
			});
		}
		const hint = controller({ mode: "hint", fetcher: fixtureFetch(positiveDecision, () => requests++) });
		hint.onTurnStart();
		hint.observeAfterToolCall({ toolName: "edit", args: edit("/synthetic/packages/one/one.ts"), isError: false });
		await flushTurn();
		expect(requests).toBe(0);
	});
});
