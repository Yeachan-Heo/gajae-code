import { afterEach, describe, expect, it, vi } from "bun:test";
import { STREAM_FIRST_EVENT_TIMEOUT_PROVIDER_CODE, transportFailureFacts } from "../src/utils/fallback-transport";
import { FirstEventTimeoutError, iterateWithIdleTimeout } from "../src/utils/idle-iterator";

async function waitForTimerRegistration(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("iterateWithIdleTimeout transport facts", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("normalizes the typed first-event timeout fact idempotently", () => {
		const error = new FirstEventTimeoutError("first event timed out");
		const facts = transportFailureFacts(error);

		expect(error.providerCode).toBe(STREAM_FIRST_EVENT_TIMEOUT_PROVIDER_CODE);
		expect(facts).toEqual({
			kind: "transport",
			status: undefined,
			providerCode: STREAM_FIRST_EVENT_TIMEOUT_PROVIDER_CODE,
			anthropicErrorType: undefined,
			openaiErrorCode: undefined,
			headers: undefined,
		});
		expect(transportFailureFacts(facts)).toEqual(facts);
	});

	it("keeps post-progress idle expiry distinct from first-event expiry", async () => {
		vi.useFakeTimers();
		const source = (async function* () {
			yield "progress";
			await new Promise<never>(() => {});
		})();
		const iterator = iterateWithIdleTimeout(source, {
			firstItemTimeoutMs: 10,
			idleTimeoutMs: 10,
			errorMessage: "stream idle",
		});

		expect((await iterator.next()).value).toBe("progress");
		const pending = iterator.next();
		await waitForTimerRegistration();
		vi.advanceTimersByTime(10);
		const error = await pending.catch(error => error);

		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(FirstEventTimeoutError);
		expect(transportFailureFacts(error)).toBeUndefined();
	});

	it("stamps first-item expiry as FirstEventTimeoutError with transport facts", async () => {
		vi.useFakeTimers();
		const source = (async function* () {
			await new Promise<never>(() => {});
		})();
		const abortReasons: Error[] = [];
		const iterator = iterateWithIdleTimeout(source, {
			firstItemTimeoutMs: 10,
			idleTimeoutMs: 10,
			errorMessage: "stream idle",
			firstItemErrorMessage: "Provider stream timed out while waiting for the first event",
			onFirstItemTimeout: () => {
				abortReasons.push(
					new FirstEventTimeoutError("Provider stream timed out while waiting for the first event"),
				);
			},
		});

		const pending = iterator.next();
		await waitForTimerRegistration();
		vi.advanceTimersByTime(10);
		const error = await pending.catch(error => error);

		expect(error).toBeInstanceOf(FirstEventTimeoutError);
		expect(transportFailureFacts(error)).toEqual({
			kind: "transport",
			status: undefined,
			providerCode: STREAM_FIRST_EVENT_TIMEOUT_PROVIDER_CODE,
			anthropicErrorType: undefined,
			openaiErrorCode: undefined,
			headers: undefined,
		});
		expect(abortReasons).toHaveLength(1);
		expect(transportFailureFacts(abortReasons[0])).toMatchObject({
			kind: "transport",
			providerCode: STREAM_FIRST_EVENT_TIMEOUT_PROVIDER_CODE,
		});
	});
});
