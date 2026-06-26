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
			{ plugin: "p", event: "tool_result", handler: handlerB },
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

	test("registers nothing for an empty hook list", () => {
		const registered: string[] = [];
		const factory = createPluginHooksExtension([]);
		factory({ on: (e: string) => registered.push(e) } as any);
		expect(registered).toHaveLength(0);
	});
});
