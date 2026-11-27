import { afterEach, describe, expect, it } from "bun:test";
import type { AskAnswerRequest, AskRemoteReceipt, AskSettlement } from "../../src/tools";
import { answerPendingAsk, closePendingAsks, listPendingAsks, openPendingAsk } from "../../src/tools/pending-asks";

const sessionId = "pending-ask-lifecycle";
const selector: AskAnswerRequest & { questionId: string } = {
	questionId: "logical-question",
	question: "Choose",
	options: ["A", "B", "Other"],
	interaction: "selector",
	controls: [],
	multi: false,
};
afterEach(() => closePendingAsks(sessionId));

async function receiptOf(promise: Promise<AskRemoteReceipt | string | undefined>): Promise<AskRemoteReceipt> {
	const receipt = await promise;
	if (!receipt || typeof receipt === "string") throw new Error("Expected a typed receipt");
	return receipt;
}

describe("pending ordinary ask lifecycle", () => {
	it("rejects malformed answers and disabled controls without consuming the request", async () => {
		const wait = openPendingAsk(
			sessionId,
			{ ...selector, controls: [{ id: "navigation_forward", kind: "navigation", label: "Done", enabled: false }] },
			undefined,
			new AbortController().signal,
		);
		const id = listPendingAsks(sessionId)[0]!.id;
		const invalid: unknown[] = [
			null,
			"A",
			{ kind: "value", value: "A", extra: true },
			{ kind: "control", controlId: "navigation_forward" },
			{ kind: "value", value: "unknown" },
		];
		for (const answer of invalid) {
			await expect(answerPendingAsk(sessionId, id, answer)).rejects.toMatchObject({ code: "invalid_input" });
			expect(listPendingAsks(sessionId)[0]!.id).toBe(id);
		}
		wait.close();
		expect(await wait.promise).toBeUndefined();
	});

	it("keeps snapshots detached and rotates IDs on editor entry and back navigation", async () => {
		const controller = new AbortController();
		const wait = openPendingAsk(sessionId, selector, undefined, controller.signal);
		const first = listPendingAsks(sessionId)[0]!;
		first.options.push("Injected");
		expect(listPendingAsks(sessionId)[0]!.options).not.toContain("Injected");
		wait.update({ ...selector, interaction: "custom_editor", options: [], editor: { title: "Type", prefill: "" } });
		const editor = listPendingAsks(sessionId)[0]!;
		expect(editor.id).not.toBe(first.id);
		expect(editor.questionId).toBe(first.questionId);
		await expect(answerPendingAsk(sessionId, first.id, { kind: "value", value: "A" })).rejects.toMatchObject({
			code: "stale_request",
		});
		wait.update(selector);
		expect(listPendingAsks(sessionId)[0]!.id).not.toBe(editor.id);
		expect(listPendingAsks(sessionId)[0]!.questionId).toBe(first.questionId);
		await expect(answerPendingAsk(sessionId, editor.id, { kind: "value", value: "text" })).rejects.toMatchObject({
			code: "stale_request",
		});
		controller.abort();
		expect(await wait.promise).toBeUndefined();
		expect(listPendingAsks(sessionId)).toEqual([]);
	});

	it("accepts one submission and reports the actual first settlement, not a fake commit", async () => {
		const wait = openPendingAsk(sessionId, selector, undefined, new AbortController().signal);
		const request = listPendingAsks(sessionId)[0]!;
		const answer = answerPendingAsk(sessionId, request.id, { kind: "value", value: "A" });
		await expect(answerPendingAsk(sessionId, request.id, { kind: "value", value: "B" })).rejects.toMatchObject({
			code: "stale_request",
		});
		const receipt = await receiptOf(wait.promise);
		const localWon: AskSettlement = { kind: "resolve_without_commit", reason: "aborted" };
		expect(await receipt.settle(localWon)).toEqual({ kind: "resolved_without_commit" });
		expect(await receipt.settle({ kind: "commit" })).toEqual({ kind: "resolved_without_commit" });
		expect(await answer).toEqual({ id: request.id, sessionId, settlement: localWon });
		wait.close();
	});

	it("keeps notification answers alive during observation and retires the SDK ID when they win", async () => {
		const notification = Promise.withResolvers<string | undefined>();
		const wait = openPendingAsk(
			sessionId,
			selector,
			{ awaitAnswer: () => notification.promise },
			new AbortController().signal,
		);
		const id = listPendingAsks(sessionId)[0]!.id;
		notification.resolve("B");
		expect(await wait.promise).toBe("B");
		expect(listPendingAsks(sessionId)).toEqual([]);
		await expect(answerPendingAsk(sessionId, id, { kind: "value", value: "A" })).rejects.toMatchObject({
			code: "stale_request",
		});
		wait.close();
	});

	it("settles late notification receipts without letting them commit", async () => {
		const notification = Promise.withResolvers<AskRemoteReceipt>();
		const settlements: AskSettlement[] = [];
		const wait = openPendingAsk(
			sessionId,
			selector,
			{
				awaitAnswer: async () => undefined,
				awaitAnswerRequest: () => notification.promise,
			},
			new AbortController().signal,
		);
		const id = listPendingAsks(sessionId)[0]!.id;
		const answer = answerPendingAsk(sessionId, id, { kind: "value", value: "A" });
		const receipt = await receiptOf(wait.promise);
		notification.resolve({
			source: "remote",
			interaction: { kind: "value", value: "B" },
			settle: async value => {
				settlements.push(value);
				return { kind: "resolved_without_commit" };
			},
		});
		await receipt.settle({ kind: "commit" });
		await answer;
		await notification.promise;
		expect(settlements).toEqual([{ kind: "resolve_without_commit", reason: "aborted" }]);
		wait.close();
	});

	it("cleans both waiting and submitted interactions on session teardown", async () => {
		const waiting = openPendingAsk(sessionId, selector, undefined, new AbortController().signal);
		const submitting = openPendingAsk(sessionId, selector, undefined, new AbortController().signal);
		const id = listPendingAsks(sessionId)[1]!.id;
		const answer = answerPendingAsk(sessionId, id, { kind: "value", value: "A" });
		await receiptOf(submitting.promise);
		closePendingAsks(sessionId);
		expect(await waiting.promise).toBeUndefined();
		expect(await answer).toMatchObject({ settlement: { kind: "resolve_without_commit", reason: "shutdown" } });
		expect(listPendingAsks(sessionId)).toEqual([]);
	});
});
