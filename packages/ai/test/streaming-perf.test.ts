import { describe, expect, it } from "bun:test";
import { registerCustomApi, unregisterCustomApis } from "../src/api-registry";
import { createMockModel } from "../src/providers/mock";
import { complete, completeSimple } from "../src/stream";
import type { AssistantMessage } from "../src/types";
import { AssistantMessageEventStream } from "../src/utils/event-stream";
import { iterateWithIdleTimeout } from "../src/utils/idle-iterator";
import {
	collectUnsafeUnicodeEscapeEvidence,
	findUnnecessaryUnicodeEscape,
	parseJsonWithRepair,
} from "../src/utils/json-parse";

describe("streaming lifetime regressions", () => {
	for (const exit of ["break", "consumer-error", "source-error", "natural", "timeout"] as const) {
		it(`closes the source exactly once on ${exit}, without waiting for return`, async () => {
			let closes = 0;
			let reads = 0;
			const failure = new Error("source failed");
			const source: AsyncIterableIterator<number> = {
				[Symbol.asyncIterator]() {
					return this;
				},
				async next() {
					if (exit === "source-error") throw failure;
					if (exit === "timeout") return Promise.withResolvers<IteratorResult<number>>().promise;
					return reads++ === 0 ? { done: false, value: 7 } : { done: true, value: undefined };
				},
				return() {
					closes++;
					return Promise.withResolvers<IteratorResult<number>>().promise;
				},
			};
			const values: number[] = [];
			const consume = async () => {
				for await (const value of iterateWithIdleTimeout(source, {
					errorMessage: "timeout",
					idleTimeoutMs: exit === "timeout" ? 5 : undefined,
				})) {
					values.push(value);
					if (exit === "break") break;
					if (exit === "consumer-error") throw failure;
				}
			};
			if (exit === "consumer-error" || exit === "source-error") await expect(consume()).rejects.toBe(failure);
			else if (exit === "timeout") await expect(consume()).rejects.toThrow("timeout");
			else await consume();
			expect(values).toEqual(exit === "source-error" || exit === "timeout" ? [] : [7]);
			expect(closes).toBe(exit === "natural" ? 0 : 1);
		});
	}

	it("preserves a source error when iterator cleanup throws synchronously", async () => {
		const sourceFailure = new Error("source failed");
		const cleanupFailure = new Error("cleanup failed");
		const source: AsyncIterableIterator<number> = {
			[Symbol.asyncIterator]() {
				return this;
			},
			async next() {
				throw sourceFailure;
			},
			return() {
				throw cleanupFailure;
			},
		};

		await expect(
			(async () => {
				for await (const _value of iterateWithIdleTimeout(source, { errorMessage: "timeout" })) {
					// The source fails before yielding.
				}
			})(),
		).rejects.toBe(sourceFailure);
	});

	for (const finish of [complete, completeSimple]) {
		for (const outcome of ["done", "error", "throw"] as const) {
			it(`${finish.name} drains events and preserves ${outcome} result semantics`, async () => {
				const api = `perf-${finish.name}-${outcome}`;
				const mock = createMockModel();
				const model = { ...mock.model, api };
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "answer" }],
					api,
					provider: model.provider,
					model: model.id,
					timestamp: 0,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: outcome === "error" ? "error" : "stop",
					...(outcome === "error" ? { errorMessage: "provider error" } : {}),
				};
				const events = new AssistantMessageEventStream();
				const failure = new Error("transport failed");
				registerCustomApi(
					api,
					() => {
						for (let i = 0; i < 4096; i++)
							events.push({ type: "text_delta", contentIndex: 0, delta: "x", partial: message });
						if (outcome === "throw") events.fail(failure);
						else if (outcome === "error") events.push({ type: "error", reason: "error", error: message });
						else events.push({ type: "done", reason: "stop", message });
						return events;
					},
					api,
				);
				try {
					if (outcome === "throw") await expect(finish(model, { messages: [] })).rejects.toBe(failure);
					else expect(await finish(model, { messages: [] })).toBe(message);
					expect(events.queue).toEqual([]);
					expect(events.hasActiveConsumer).toBe(false);
				} finally {
					unregisterCustomApis(api);
				}
			});
		}
	}

	it("preserves escape-dense JSON and detects a final printable escape", () => {
		const value = { text: '\\"\n\t'.repeat(20_000), other: ["plain", "한글"] };
		const json = JSON.stringify(value);
		expect(parseJsonWithRepair(json)).toEqual(JSON.parse(json));
		expect(findUnnecessaryUnicodeEscape(json)).toBeUndefined();
		expect(collectUnsafeUnicodeEscapeEvidence(json)).toBeUndefined();
		const escaped = json.slice(0, -1) + String.raw`,"end":"\u0061"}`;
		expect(findUnnecessaryUnicodeEscape(escaped)).toBe(String.raw`\u0061`);
		expect(parseJsonWithRepair(escaped)).toEqual(JSON.parse(escaped));
		expect(collectUnsafeUnicodeEscapeEvidence(escaped)).toBeUndefined();
	});
});
