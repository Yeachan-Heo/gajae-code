import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";

import { HookInputComponent } from "@gajae-code/coding-agent/modes/components/hook-input";
import { getThemeByName, setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import type { TUI } from "@gajae-code/tui";

beforeAll(async () => {
	const theme = await getThemeByName("red-claw");
	if (!theme) {
		throw new Error("Failed to load dark theme for tests");
	}
	setThemeInstance(theme);
});
describe("HookInputComponent timeout", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("resets timeout on user activity and still expires when idle", () => {
		vi.useFakeTimers();

		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const onTimeout = vi.fn();
		const tui = { requestRender: vi.fn() } as unknown as TUI;

		const component = new HookInputComponent("Prompt", undefined, onSubmit, onCancel, {
			timeout: 1_000,
			tui,
			onTimeout,
		});

		vi.advanceTimersByTime(900);
		component.handleInput("a");

		vi.advanceTimersByTime(900);
		component.handleInput("\x7f");

		vi.advanceTimersByTime(900);
		expect(onTimeout).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();

		vi.advanceTimersByTime(200);
		expect(onTimeout).toHaveBeenCalledTimes(1);
		expect(onCancel).toHaveBeenCalledTimes(1);

		component.dispose();
	});

	it("preserves submit behavior", () => {
		vi.useFakeTimers();

		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const onTimeout = vi.fn();
		const tui = { requestRender: vi.fn() } as unknown as TUI;

		const component = new HookInputComponent("Prompt", undefined, onSubmit, onCancel, {
			timeout: 1_000,
			tui,
			onTimeout,
		});

		component.handleInput("h");
		component.handleInput("i");
		component.handleInput("\n");

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith("hi");
		expect(onCancel).not.toHaveBeenCalled();
		expect(onTimeout).not.toHaveBeenCalled();
		component.dispose();
	});

	it("keeps placeholder text out of the submitted value", () => {
		const onSubmit = vi.fn();
		const component = new HookInputComponent("Prompt", "Existing preset", onSubmit, vi.fn());

		component.handleInput("\n");

		expect(onSubmit).toHaveBeenCalledWith("");

		component.dispose();
	});

	it("prefills the submitted value when an explicit initial value is provided", () => {
		const onSubmit = vi.fn();
		const component = new HookInputComponent("Prompt", undefined, onSubmit, vi.fn(), {
			initialValue: "Existing preset",
		});

		component.handleInput("\n");

		expect(onSubmit).toHaveBeenCalledWith("Existing preset");

		component.dispose();
	});
});
