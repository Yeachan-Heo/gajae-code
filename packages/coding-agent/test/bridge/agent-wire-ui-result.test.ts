import { describe, expect, it } from "bun:test";
import {
	isUiCancelled,
	isUiUnsupported,
	isUiValue,
	uiCancelled,
	uiUnsupported,
	uiValue,
} from "../../src/modes/shared/agent-wire/ui-result";

describe("agent-wire typed UI results", () => {
	it("distinguishes real values from cancellation and unsupported surfaces", () => {
		const value = uiValue("choice-a");
		const cancelled = uiCancelled("timeout");
		const unsupported = uiUnsupported("editor", "client did not negotiate editor capability");

		expect(isUiValue(value)).toBe(true);
		expect(isUiCancelled(value)).toBe(false);
		expect(isUiUnsupported(value)).toBe(false);
		expect(value.value).toBe("choice-a");

		expect(isUiValue(cancelled)).toBe(false);
		expect(isUiCancelled(cancelled)).toBe(true);
		expect(isUiUnsupported(cancelled)).toBe(false);
		expect(cancelled.reason).toBe("timeout");

		expect(isUiValue(unsupported)).toBe(false);
		expect(isUiCancelled(unsupported)).toBe(false);
		expect(isUiUnsupported(unsupported)).toBe(true);
		expect(unsupported.capability).toBe("editor");
		expect(unsupported.reason).toContain("did not negotiate");
	});
});
