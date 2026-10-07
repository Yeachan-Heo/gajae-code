import { describe, expect, it } from "bun:test";
import { detectMacOSAppearance, getWorkProfile, MacAppearanceObserver } from "../native/index.js";

type Golden = {
	preSyncObservedOnCurrentHost: "dark" | "light";
	darwinAllowed: Array<"dark" | "light">;
	otherPlatformValue: null;
};

const golden = JSON.parse(
	await Bun.file(`${import.meta.dir}/fixtures/goldens/appearance/native-domain.json`).text(),
) as Golden;

describe("appearance re-sync differential golden", () => {
	it("retains the recorded native appearance domain and profiles the observer, not detection", () => {
		expect(golden.darwinAllowed).toContain(golden.preSyncObservedOnCurrentHost);
		const appearance = detectMacOSAppearance();
		if (process.platform === "darwin" && appearance !== null) expect(golden.darwinAllowed).toContain(appearance);
		else expect(appearance).toBe(golden.otherPlatformValue);
		// The sub-microsecond detect query is deliberately unprofiled (the guard
		// cost ~7% of it); the observer lifecycle keeps its profile tags.
		expect(getWorkProfile(60).folded).not.toContain("appearance.detect");
		MacAppearanceObserver.start(() => {}).stop();
		const folded = getWorkProfile(60).folded;
		expect(folded).toContain("appearance.observer.start");
		expect(folded).toContain("appearance.observer.stop");
	});

	it.skipIf(process.platform !== "darwin")(
		"stops an observer immediately after start without hanging",
		() => {
			// CFRunLoopStop only interrupts a running loop; a stop that landed
			// before the observer thread entered its loop used to join forever.
			for (let i = 0; i < 20; i++) MacAppearanceObserver.start(() => {}).stop();
		},
		5_000,
	);
});
