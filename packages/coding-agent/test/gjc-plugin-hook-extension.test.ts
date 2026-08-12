import { describe, expect, test } from "bun:test";
import type { ConstrainedPluginHook } from "../src/extensibility/gjc-plugins";
import { createPluginHooksExtension } from "../src/sdk";

describe("createPluginHooksExtension", () => {
	test("registers declared events and enforces the declared tool target at execution", () => {
		let aCalls = 0;
		let bCalls = 0;
		const handlerA = () => {
			aCalls++;
		};
		const handlerB = () => {
			bCalls++;
		};
		const hooks: ConstrainedPluginHook[] = [
			{ plugin: "p", event: "tool_call", target: "read", phase: "before", handler: handlerA },
			{ plugin: "p", event: "tool_result", phase: "after", handler: handlerB },
		];
		const registered: Array<{ event: string; handler: (...a: unknown[]) => unknown }> = [];
		const fakeApi = {
			on: (event: string, handler: (...a: unknown[]) => unknown) => registered.push({ event, handler }),
		};
		const factory = createPluginHooksExtension(hooks);
		factory(fakeApi as any);

		expect(registered.map(r => r.event)).toEqual(["tool_call", "tool_result"]);

		// Targeted hook only fires for its declared tool.
		registered[0]?.handler({ toolName: "read" });
		registered[0]?.handler({ toolName: "write" });
		expect(aCalls).toBe(1);

		// Untargeted hook is registered raw and fires for its event.
		expect(registered[1]?.handler).toBe(handlerB);
		registered[1]?.handler({});
		expect(bCalls).toBe(1);
	});

	test("uses canonical plugin normalization for after-phase runtime selection", () => {
		const registered: string[] = [];
		const factory = createPluginHooksExtension([
			{ plugin: "p", event: "tool_call", target: "read", phase: "after", handler: () => undefined },
		]);
		factory({ on: (event: string) => registered.push(event) } as any);
		expect(registered).toEqual(["tool_result"]);
	});

	test("registers compiler-valid constrained lifecycle hooks", () => {
		let starts = 0;
		let shutdowns = 0;
		const registered: Array<{ event: string; handler: (...args: unknown[]) => unknown }> = [];
		const factory = createPluginHooksExtension([
			{ plugin: "p", event: "session_start", handler: () => starts++ },
			{ plugin: "p", event: "session_shutdown", handler: () => shutdowns++ },
		]);
		factory({
			on: (event: string, handler: (...args: unknown[]) => unknown) => registered.push({ event, handler }),
		} as any);
		expect(registered.map(entry => entry.event)).toEqual(["session_start", "session_shutdown"]);
		registered[0]?.handler({ type: "session_start" });
		registered[1]?.handler({ type: "session_shutdown" });
		expect({ starts, shutdowns }).toEqual({ starts: 1, shutdowns: 1 });
	});

	test("fails closed before registration for an invalid constrained descriptor", () => {
		const registered: string[] = [];
		const factory = createPluginHooksExtension([
			{ plugin: "p", event: "pre_tool_use", target: "read", phase: "before", handler: () => undefined },
		]);
		expect(() => factory({ on: (event: string) => registered.push(event) } as any)).toThrow(
			"unrecognized_plugin_event",
		);
		expect(registered).toEqual([]);
	});

	test("validates a mixed batch atomically before any registration", () => {
		const registered: string[] = [];
		const factory = createPluginHooksExtension([
			{ plugin: "p", event: "tool_call", target: "read", phase: "before", handler: () => undefined },
			{ plugin: "p", event: "tool_call", target: " read ", phase: "before", handler: () => undefined },
		]);
		expect(() => factory({ on: (event: string) => registered.push(event) } as any)).toThrow("invalid_tool_matcher");
		expect(registered).toEqual([]);
	});

	test("preserves all-valid registration order, including duplicate descriptors", () => {
		const registered: string[] = [];
		const handler = () => undefined;
		const factory = createPluginHooksExtension([
			{ plugin: "p", event: "tool_call", target: "read", phase: "before", handler },
			{ plugin: "p", event: "tool_call", target: "read", phase: "before", handler },
			{ plugin: "p", event: "tool_call", target: "write", phase: "after", handler },
			{ plugin: "p", event: "tool_result", phase: "after", handler },
		]);
		factory({ on: (event: string) => registered.push(event) } as any);
		expect(registered).toEqual(["tool_call", "tool_call", "tool_result", "tool_result"]);
	});

	test("registers nothing for an empty hook list", () => {
		const registered: string[] = [];
		const factory = createPluginHooksExtension([]);
		factory({ on: (e: string) => registered.push(e) } as any);
		expect(registered).toHaveLength(0);
	});
});
