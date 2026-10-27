import { afterEach, describe, expect, test } from "bun:test";
import {
	CustomApiRegistry,
	type CustomStreamFn,
	type CustomStreamSimpleFn,
	clearCustomApis,
	getCustomApi,
	registerCustomApi,
	resolveCustomApi,
	unregisterCustomApis,
} from "../src/api-registry";
import { AssistantMessageEventStream } from "../src/utils/event-stream";

afterEach(() => {
	clearCustomApis();
});

describe("custom API registry", () => {
	const streamSimple: CustomStreamSimpleFn = () => ({}) as unknown as AssistantMessageEventStream;

	test("rejects registrations that collide with built-in API names", () => {
		const scope = new CustomApiRegistry();
		try {
			for (const api of ["openai-responses", "kiro-codewhisperer-stream"]) {
				expect(() => registerCustomApi(api, streamSimple)).toThrow(
					`Cannot register custom API "${api}": built-in API names are reserved.`,
				);
				expect(() => scope.register(api, streamSimple)).toThrow(
					`Cannot register custom API "${api}": built-in API names are reserved.`,
				);
				expect(scope.get(api)).toBeUndefined();
			}
		} finally {
			scope.dispose();
		}
	});

	test("unregisterCustomApis removes only matching source registrations", () => {
		registerCustomApi("custom-a", streamSimple, "ext-a");
		registerCustomApi("custom-b", streamSimple, "ext-b");

		unregisterCustomApis("ext-a");

		expect(getCustomApi("custom-a")).toBeUndefined();
		expect(getCustomApi("custom-b")).toBeDefined();
	});

	test("clearCustomApis removes all custom APIs", () => {
		registerCustomApi("custom-a", streamSimple, "ext-a");
		registerCustomApi("custom-b", streamSimple, "ext-b");

		clearCustomApis();

		expect(getCustomApi("custom-a")).toBeUndefined();
		expect(getCustomApi("custom-b")).toBeUndefined();
	});

	test("scoped registries and snapshots isolate same API and source metadata", () => {
		const scopeA = new CustomApiRegistry();
		const scopeB = new CustomApiRegistry();
		const callbackA: CustomStreamSimpleFn = () => new AssistantMessageEventStream();
		const callbackB: CustomStreamSimpleFn = () => new AssistantMessageEventStream();
		const streamA: CustomStreamFn = () => new AssistantMessageEventStream();
		const streamB: CustomStreamFn = () => new AssistantMessageEventStream();
		scopeA.register("custom-shared", callbackA, "same-source", streamA);
		const capturedRecord = scopeA.get("custom-shared");
		const snapshot = scopeA.snapshot();
		scopeB.register("custom-shared", callbackB, "same-source", streamB);

		expect(resolveCustomApi("custom-shared", scopeA)?.streamSimple).toBe(callbackA);
		expect(resolveCustomApi("custom-shared", scopeA)?.stream).toBe(streamA);
		expect(resolveCustomApi("custom-shared", scopeB)?.streamSimple).toBe(callbackB);
		expect(resolveCustomApi("custom-shared", scopeB)?.stream).toBe(streamB);
		expect(resolveCustomApi("custom-shared", snapshot)?.streamSimple).toBe(callbackA);
		expect(resolveCustomApi("custom-shared", snapshot)?.stream).toBe(streamA);

		if (capturedRecord) {
			capturedRecord.streamSimple = callbackB;
			capturedRecord.sourceId = "mutated-source";
		}
		expect(resolveCustomApi("custom-shared", scopeA)?.streamSimple).toBe(callbackA);
		expect(resolveCustomApi("custom-shared", scopeA)?.sourceId).toBe("same-source");
		scopeB.unregisterSource("same-source");
		scopeB.clear();
		scopeA.unregisterSource("same-source");
		scopeA.clear();

		expect(resolveCustomApi("custom-shared", scopeA)).toBeUndefined();
		expect(resolveCustomApi("custom-shared", scopeB)).toBeUndefined();
		expect(resolveCustomApi("custom-shared", snapshot)?.streamSimple).toBe(callbackA);
		expect(resolveCustomApi("custom-shared", snapshot)?.stream).toBe(streamA);
		if (capturedRecord) expect(capturedRecord.streamSimple).toBe(callbackB);
		scopeA.dispose();
		scopeB.dispose();
		snapshot.dispose();
	});

	test("disposed and fabricated scopes fail closed", () => {
		const scope = new CustomApiRegistry();
		scope.register("custom-a", streamSimple, "ext-a");
		scope.dispose();
		scope.dispose();

		expect(() => scope.get("custom-a")).toThrow("Custom API registry has been disposed.");
		expect(() => scope.register("custom-b", streamSimple)).toThrow("Custom API registry has been disposed.");
		expect(() => scope.unregisterSource("ext-a")).toThrow("Custom API registry has been disposed.");
		expect(() => scope.clear()).toThrow("Custom API registry has been disposed.");
		expect(() => scope.snapshot()).toThrow("Custom API registry has been disposed.");
		expect(() => resolveCustomApi("custom-a", scope)).toThrow("Custom API registry has been disposed.");

		const fabricated = Object.create(CustomApiRegistry.prototype) as CustomApiRegistry;
		const jsonCopy = JSON.parse(JSON.stringify(new CustomApiRegistry())) as CustomApiRegistry;
		expect(() => CustomApiRegistry.assertActive(fabricated)).toThrow("Invalid custom API registry capability.");
		expect(() => resolveCustomApi("custom-a", fabricated)).toThrow("Invalid custom API registry capability.");
		expect(() => CustomApiRegistry.assertActive(jsonCopy)).toThrow("Invalid custom API registry capability.");
	});

	test("unscoped helpers use the process-wide registry while scoped misses stay empty", () => {
		const scoped = new CustomApiRegistry();
		registerCustomApi("custom-process", streamSimple, "ext-global");

		expect(resolveCustomApi("custom-process")?.streamSimple).toBe(streamSimple);
		expect(resolveCustomApi("custom-process", scoped)).toBeUndefined();
		expect(getCustomApi("custom-process")?.streamSimple).toBe(streamSimple);

		scoped.dispose();
	});
});
