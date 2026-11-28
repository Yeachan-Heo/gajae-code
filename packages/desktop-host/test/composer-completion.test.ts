import { describe, expect, test, vi } from "bun:test";
import {
	type SdkComposerCompletionResult,
	type SdkComposerObservation,
	SdkComposerObservationError,
} from "@gajae-code/coding-agent/sdk";
import {
	DesktopComposerCompletion,
	projectDesktopCompletion,
	readDesktopCompletionInput,
} from "../src/composer-completion";

const frozen: SdkComposerCompletionResult = {
	sessionGeneration: 7,
	truncated: false,
	items: [
		{
			value: '@"space name.txt"',
			label: "space name.txt",
			description: "File from the SDK owner's working directory",
			text: 'Read @"space name.txt" and keep this suffix',
			cursor: 23,
		},
	],
};

function completion(
	complete: SdkComposerObservation["complete"] = async () => structuredClone(frozen),
	isCurrent = () => true,
) {
	return new DesktopComposerCompletion({ complete }, isCurrent);
}

describe("desktop public SDK completion mapping", () => {
	test("projects a remote owner's frozen response without leaking owner generation or truncation metadata", () => {
		expect(projectDesktopCompletion(frozen)).toEqual({ items: frozen.items });
	});

	test("forwards the exact UTF-16 draft and cursor and preserves the SDK's frozen replacement", async () => {
		const complete = vi.fn(async () => structuredClone(frozen));
		const adapter = completion(complete);
		const result = await adapter.complete("Read @spa and keep this suffix", 9);
		expect(complete).toHaveBeenCalledWith({ text: "Read @spa and keep this suffix", cursor: 9 });
		expect(result).toEqual({ items: frozen.items });
		expect(Object.keys(result)).toEqual(["items"]);
		result.items[0]!.text = "changed locally";
		expect((await adapter.complete("Read @spa and keep this suffix", 9)).items[0]!.text).toBe(frozen.items[0]!.text);
	});

	test("leaves trigger decisions and slash argument semantics entirely to the SDK", async () => {
		const complete = vi.fn(async () => ({ ...frozen, items: [] }));
		const adapter = completion(complete);
		for (const draft of ["ordinary text", "/", "  /model local", "line one\n@src/he"])
			expect(await adapter.complete(draft, draft.length)).toEqual({ items: [] });
		expect(complete.mock.calls).toHaveLength(4);
	});

	test("retains SDK omission of callback-only or unfreezable suggestions without inventing replacements", async () => {
		const adapter = completion(async () => ({ sessionGeneration: 7, items: [], truncated: true }));
		expect(await adapter.complete("/interactive", 12)).toEqual({ items: [] });
	});

	test("never calls an SDK observation for a retired desktop identity", async () => {
		const complete = vi.fn(async () => structuredClone(frozen));
		await expect(completion(complete, () => false).complete("@spa", 4)).rejects.toThrow("Session changed");
		expect(complete).not.toHaveBeenCalled();
	});

	test("rejects a frozen result that resolves after the app selection retires", async () => {
		const pending = Promise.withResolvers<SdkComposerCompletionResult>();
		let current = true;
		const result = completion(
			() => pending.promise,
			() => current,
		).complete("@spa", 4);
		current = false;
		pending.resolve(structuredClone(frozen));
		await expect(result).rejects.toThrow("Session changed");
	});

	test("lets SDK identity fencing reject asynchronous results even while the app identity remains current", async () => {
		const pending = Promise.withResolvers<SdkComposerCompletionResult>();
		const error = new SdkComposerObservationError("stale_session");
		const result = completion(() => pending.promise).complete("@spa", 4);
		pending.reject(error);
		await expect(result).rejects.toBe(error);
	});

	test("prioritizes a retired app identity over an asynchronous SDK backend failure", async () => {
		const pending = Promise.withResolvers<SdkComposerCompletionResult>();
		let current = true;
		const result = completion(
			() => pending.promise,
			() => current,
		).complete("@spa", 4);
		current = false;
		pending.reject(new SdkComposerObservationError("backend_failure"));
		await expect(result).rejects.toThrow("Session changed");
	});

	test("omits oversized executable insertions instead of truncating them", async () => {
		const item = frozen.items[0]!;
		const adapter = completion(async () => ({
			...frozen,
			items: [{ ...item, text: "x".repeat(32_001) }, { ...item, value: "x".repeat(32_001) }, item],
		}));
		expect((await adapter.complete("@spa", 4)).items).toEqual([item]);
	});
});

describe("desktop completion admission", () => {
	test("accepts a cursor outside a surrogate pair, including a multiline draft with suffix text", () => {
		expect(
			readDesktopCompletionInput({ sessionId: "app", sessionGeneration: 0, text: "😀\n@src suffix", cursor: 7 }),
		).toEqual({ sessionGeneration: 0, text: "😀\n@src suffix", cursor: 7 });
	});

	test("rejects malformed draft, cursor, generation and extra parameters", () => {
		const valid = { sessionId: "app", sessionGeneration: 7, text: "😀@src", cursor: 6 };
		for (const override of [
			{ text: "x".repeat(32_001) },
			{ text: "secret\0" },
			{ text: 42 },
			{ cursor: -1 },
			{ cursor: 1 },
			{ cursor: 7 },
			{ cursor: 2.5 },
			{ cursor: Number.NaN },
			{ sessionGeneration: -1 },
			{ sessionGeneration: Number.MAX_SAFE_INTEGER + 1 },
			{ sessionGeneration: "7" },
			{ cwd: "/renderer-selected-path" },
		])
			expect(() => readDesktopCompletionInput({ ...valid, ...override })).toThrow("Invalid completion");
	});
});
