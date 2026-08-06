import { expect, test } from "bun:test";
import { createSdkPermissionAskAnswerSource } from "../src/sdk/bus/index";
import { GJC_ASK_TIMEOUT_CODE } from "../src/tools/ask-answer-registry";

test("bridges selector asks to the ACP permission channel and maps optionId to the answer", async () => {
	const requests: Array<Record<string, unknown>> = [];
	const source = createSdkPermissionAskAnswerSource(async params => {
		requests.push(params);
		// Paseo returns the nested `{ outcome: { outcome, optionId } }` shape.
		return { outcome: { outcome: "selected", optionId: "option:1" } };
	});
	const answer = await source.awaitAnswer("Approve the plan?", ["Approve", "Revise"], undefined);
	expect(answer).toBe("Revise");
	expect(requests).toHaveLength(1);
	const request = requests[0] as {
		toolCall: { toolName: string; title: string; toolCallId: string };
		options: Array<Record<string, string>>;
	};
	expect(request.toolCall.toolName).toBe("ask");
	expect(request.toolCall.title).toBe("Approve the plan?");
	expect(request.toolCall.toolCallId).toBeTypeOf("string");
	expect(request.options).toEqual([
		{ optionId: "option:0", name: "Approve", kind: "allow_once" },
		{ optionId: "option:1", name: "Revise", kind: "allow_once" },
	]);
});

test("accepts the flat legacy permission outcome as well", async () => {
	const source = createSdkPermissionAskAnswerSource(async () => ({ outcome: "selected", optionId: "option:0" }));
	const answer = await source.awaitAnswer("Continue?", ["Yes", "No"], undefined);
	expect(answer).toBe("Yes");
});
test("omits the synthetic trailing transition options from the permission request", async () => {
	const requests: Array<Record<string, unknown>> = [];
	const source = createSdkPermissionAskAnswerSource(async params => {
		requests.push(params);
		return { outcome: { outcome: "selected", optionId: "option:0" } };
	});
	await source.awaitAnswerRequest!({
		question: "Pick one:",
		options: ["Yes", "No", "Other (type your own)", "Ask about these choices"],
		interaction: "selector",
		controls: [],
		transitionCount: 2,
	});
	const options = (requests[0] as { options: Array<{ name: string }> }).options;
	expect(options.map(option => option.name)).toEqual(["Yes", "No"]);
});

test("preserves legitimate options that match transition labels", async () => {
	const requests: Array<Record<string, unknown>> = [];
	const source = createSdkPermissionAskAnswerSource(async params => {
		requests.push(params);
		return { outcome: { outcome: "selected", optionId: "option:1" } };
	});
	// A legit option named like a transition is preserved; only the single
	// synthetic trailing entry is removed, and recommendedIndex stays valid.
	await source.awaitAnswerRequest!({
		question: "Pick one:",
		options: ["Yes", "Ask about these choices", "Other (type your own)"],
		interaction: "selector",
		controls: [],
		transitionCount: 1,
		recommendedIndex: 1,
	});
	const options = (requests[0] as { options: Array<{ optionId: string; name: string }> }).options;
	expect(options.map(option => option.name)).toEqual(["Yes", "Ask about these choices (Recommended)"]);
});
test("skips the permission request when only synthetic transitions remain", async () => {
	let called = false;
	const source = createSdkPermissionAskAnswerSource(async () => {
		called = true;
		return { outcome: { outcome: "selected", optionId: "option:0" } };
	});
	const result = await source.awaitAnswerRequest!({
		question: "Describe the change",
		options: ["Other (type your own)"],
		interaction: "selector",
		controls: [],
		transitionCount: 1,
	});
	expect(result).toBeUndefined();
	expect(called).toBe(false);
});
test("sends the request when an enabled control can commit an empty selection", async () => {
	const requests: Array<Record<string, unknown>> = [];
	const source = createSdkPermissionAskAnswerSource(async params => {
		requests.push(params);
		return { outcome: { outcome: "selected", optionId: "control:navigation_forward" } };
	});
	const result = await source.awaitAnswerRequest!({
		question: "Select any:",
		options: ["Other (type your own)"],
		interaction: "selector",
		controls: [{ id: "navigation_forward", kind: "navigation", label: "Done", enabled: true }],
		transitionCount: 1,
	});
	expect(requests).toHaveLength(1);
	const options = (requests[0] as { options: Array<{ optionId: string }> }).options;
	expect(options.map(option => option.optionId)).toEqual(["control:navigation_forward"]);
	expect(result && typeof result === "object" ? result.interaction : undefined).toEqual({
		kind: "control",
		controlId: "navigation_forward",
	});
});

test("marks selected options in multi-select reissues", async () => {
	const requests: Array<Record<string, unknown>> = [];
	const source = createSdkPermissionAskAnswerSource(async params => {
		requests.push(params);
		return { outcome: { outcome: "selected", optionId: "control:navigation_forward" } };
	});
	await source.awaitAnswerRequest!({
		question: "Select any:",
		options: ["A", "B"],
		interaction: "selector",
		controls: [{ id: "navigation_forward", kind: "navigation", label: "Done", enabled: true }],
		multi: true,
		selectedOptions: ["A"],
	});
	const options = (requests[0] as { options: Array<{ name: string }> }).options;
	expect(options.map(option => option.name)).toEqual(["[x] A", "[ ] B", "Done"]);
});

test("cancelled permission responses leave the ask unanswered", async () => {
	const source = createSdkPermissionAskAnswerSource(async () => ({ outcome: { outcome: "cancelled" } }));
	await expect(source.awaitAnswer("Proceed?", ["Yes", "No"], undefined)).resolves.toBeUndefined();
});

test("maps enabled navigation controls to permission options and returns a control interaction", async () => {
	const source = createSdkPermissionAskAnswerSource(async params => {
		const options = (params as { options: Array<{ optionId: string }> }).options;
		expect(options.map(option => option.optionId)).toEqual(["option:0", "option:1", "control:navigation_forward"]);
		return { outcome: { outcome: "selected", optionId: "control:navigation_forward" } };
	});
	const result = await source.awaitAnswerRequest!({
		question: "Select any:",
		options: ["A", "B"],
		interaction: "selector",
		controls: [{ id: "navigation_forward", kind: "navigation", label: "Done", enabled: true }],
	});
	expect(result && typeof result === "object" ? result.interaction : undefined).toEqual({
		kind: "control",
		controlId: "navigation_forward",
	});
});

test("non-selector asks are not bridged to the permission channel", async () => {
	let called = false;
	const source = createSdkPermissionAskAnswerSource(async () => {
		called = true;
		return { outcome: { outcome: "selected", optionId: "option:0" } };
	});
	const result = await source.awaitAnswerRequest!({
		question: "Describe the change",
		options: [],
		interaction: "custom_editor",
		controls: [],
	});
	expect(result).toBeUndefined();
	expect(called).toBe(false);
});
test("decorates the recommended option name", async () => {
	const requests: Array<Record<string, unknown>> = [];
	const source = createSdkPermissionAskAnswerSource(async params => {
		requests.push(params);
		return { outcome: { outcome: "selected", optionId: "option:1" } };
	});
	await source.awaitAnswerRequest!({
		question: "Approve the plan?",
		options: ["Approve", "Revise"],
		interaction: "selector",
		controls: [],
		recommendedIndex: 1,
	});
	const options = (requests[0] as { options: Array<{ optionId: string; name: string }> }).options;
	expect(options[0].name).toBe("Approve");
	expect(options[1].name).toBe("Revise (Recommended)");
	expect(requests[0].options).toEqual([
		{ optionId: "option:0", name: "Approve", kind: "allow_once" },
		{ optionId: "option:1", name: "Revise (Recommended)", kind: "allow_once" },
	]);
});

test("signals its own timeout with the marked error", async () => {
	const { promise: neverAnswer } = Promise.withResolvers<never>();
	const source = createSdkPermissionAskAnswerSource(() => neverAnswer);
	await expect(
		source.awaitAnswerRequest!({
			question: "Proceed?",
			options: ["Yes", "No"],
			interaction: "selector",
			controls: [],
			recommendedIndex: 0,
			timeoutMs: 50,
		}),
	).rejects.toMatchObject({ code: GJC_ASK_TIMEOUT_CODE });
});

test("aborts the underlying permission request on timeout", async () => {
	let sawAbortSignal = false;
	const { promise: aborted, resolve: resolveAborted } = Promise.withResolvers<void>();
	const source = createSdkPermissionAskAnswerSource(async (_params, signal) => {
		signal?.addEventListener(
			"abort",
			() => {
				sawAbortSignal = true;
				resolveAborted();
			},
			{ once: true },
		);
		await aborted;
		return { outcome: { outcome: "selected", optionId: "option:0" } };
	});
	await expect(
		source.awaitAnswerRequest!({
			question: "Proceed?",
			options: ["Yes", "No"],
			interaction: "selector",
			controls: [],
			timeoutMs: 50,
		}),
	).rejects.toMatchObject({ code: GJC_ASK_TIMEOUT_CODE });
	expect(sawAbortSignal).toBe(true);
});
