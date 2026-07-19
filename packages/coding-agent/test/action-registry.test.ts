import { describe, expect, it } from "bun:test";
import { ActionRegistry } from "../src/modes/action-registry";

describe("ActionRegistry", () => {
	it("serializes an asynchronous action", async () => {
		let release: (() => void) | undefined;
		let calls = 0;
		const registry = new ActionRegistry({ context: undefined, showError: () => {} });
		registry.register({
			id: "app.clear",
			title: "Clear",
			category: "Test",
			bindingId: "app.clear",
			domains: ["global"],
			availability: () => true,
			execute: async () => {
				calls++;
				await new Promise<void>(resolve => {
					release = resolve;
				});
			},
		});
		const first = registry.execute("app.clear");
		expect(await registry.execute("app.clear")).toBe(false);
		expect(calls).toBe(1);
		release?.();
		expect(await first).toBe(true);
	});

	it("does not execute unavailable actions and reports failures without throwing", async () => {
		const errors: string[] = [];
		const registry = new ActionRegistry({ context: undefined, showError: id => errors.push(id) });
		registry.register({
			id: "app.exit",
			title: "Exit",
			category: "Test",
			domains: ["global"],
			availability: () => false,
			execute: () => {
				throw new Error("unreachable");
			},
		});
		registry.register({
			id: "app.suspend",
			title: "Suspend",
			category: "Test",
			domains: ["global"],
			availability: () => true,
			execute: async () => {
				throw new Error("failure");
			},
		});
		expect(await registry.execute("app.exit")).toBe(false);
		expect(await registry.execute("app.suspend")).toBe(false);
		expect(errors).toEqual(["Action app.suspend execution failed: failure"]);
	});
	it("contains reporter failures when availability or execution fails", async () => {
		const registry = new ActionRegistry({
			context: undefined,
			showError: () => {
				throw new Error("reporter failure");
			},
		});
		registry.register({
			id: "app.clear",
			title: "Availability",
			category: "Test",
			domains: ["global"],
			availability: () => {
				throw new Error("availability failure");
			},
			execute: () => {},
		});
		registry.register({
			id: "app.exit",
			title: "Execution",
			category: "Test",
			domains: ["global"],
			availability: () => true,
			execute: () => {
				throw new Error("execution failure");
			},
		});
		expect(registry.isAvailable("app.clear")).toBe(false);
		expect(await registry.execute("app.clear")).toBe(false);
		expect(await registry.execute("app.exit")).toBe(false);
	});

	it("serializes default actions while allowing an interrupt and deduplicating an availability probe", async () => {
		let availabilityCalls = 0;
		const release = Promise.withResolvers<void>();
		let interrupted = false;
		const registry = new ActionRegistry({ context: undefined, showError: () => {} });
		registry.register({
			id: "app.clear",
			title: "Busy action",
			category: "Test",
			domains: ["global"],
			availability: () => {
				availabilityCalls++;
				return true;
			},
			execute: () => release.promise,
		});
		registry.register({
			id: "app.interrupt",
			title: "Interrupt",
			category: "Test",
			domains: ["global"],
			exclusiveGroup: false,
			availability: () => true,
			execute: () => {
				interrupted = true;
			},
		});
		registry.register({
			id: "app.exit",
			title: "Competing action",
			category: "Test",
			domains: ["global"],
			availability: () => true,
			execute: () => {},
		});

		expect(registry.isAvailable("app.clear")).toBe(true);
		const busy = registry.execute("app.clear");
		expect(availabilityCalls).toBe(1);
		expect(await registry.execute("app.exit")).toBe(false);
		expect(await registry.execute("app.interrupt")).toBe(true);
		expect(interrupted).toBe(true);
		release.resolve();
		expect(await busy).toBe(true);
	});

	it("reports the original error with its action and phase", async () => {
		const errors: string[] = [];
		const registry = new ActionRegistry({ context: undefined, showError: error => errors.push(error) });
		registry.register({
			id: "app.exit",
			title: "Exit",
			category: "Test",
			domains: ["global"],
			availability: () => true,
			execute: () => {
				throw new Error("root cause");
			},
		});

		expect(await registry.execute("app.exit")).toBe(false);
		expect(errors).toEqual(["Action app.exit execution failed: root cause"]);
	});
});
