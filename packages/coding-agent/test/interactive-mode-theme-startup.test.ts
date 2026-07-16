import { describe, expect, it, vi } from "bun:test";
import { settleInitialThemeStartup } from "../src/modes/interactive-mode";

describe("InteractiveMode initial theme settlement", () => {
	it("uses one deadline for appearance and theme settlement and releases in finally", async () => {
		const appearance = Promise.withResolvers<void>();
		const theme = Promise.withResolvers<void>();
		const releaseRenderHold = vi.fn();

		const settling = settleInitialThemeStartup(
			() => appearance.promise,
			() => theme.promise,
			releaseRenderHold,
			20,
		);
		appearance.resolve();
		await settling;

		expect(releaseRenderHold).toHaveBeenCalledTimes(1);
	});

	it("releases the render hold when appearance detection rejects", async () => {
		const releaseRenderHold = vi.fn();

		await settleInitialThemeStartup(
			() => Promise.reject(new Error("terminal detached")),
			() => Promise.resolve(),
			releaseRenderHold,
			20,
		);

		expect(releaseRenderHold).toHaveBeenCalledTimes(1);
	});
});
