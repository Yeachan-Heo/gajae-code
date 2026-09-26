import { describe, expect, it } from "bun:test";
import { detectMacOSAppearance, getWorkProfile } from "../native/index.js";

type Golden = {
	preSyncObservedOnCurrentHost: "dark" | "light";
	darwinAllowed: Array<"dark" | "light">;
	otherPlatformValue: null;
};

const golden = JSON.parse(
	await Bun.file(`${import.meta.dir}/fixtures/goldens/appearance/native-domain.json`).text(),
) as Golden;

describe("appearance re-sync differential golden", () => {
	it("retains the recorded native appearance domain and profiles detection", () => {
		expect(golden.darwinAllowed).toContain(golden.preSyncObservedOnCurrentHost);
		const appearance = detectMacOSAppearance();
		if (process.platform === "darwin" && appearance !== null) expect(golden.darwinAllowed).toContain(appearance);
		else expect(appearance).toBe(golden.otherPlatformValue);
		expect(getWorkProfile(60).folded).toContain("appearance.detect");
	});
});
