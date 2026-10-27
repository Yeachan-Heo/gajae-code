import { describe, expect, it } from "bun:test";
import * as native from "../native/index.js";

type Golden = {
	options: { reason: string; idle: boolean; system: boolean; user: boolean; display: boolean };
	baselineExport: string;
	baselineResult: string;
};

const golden = JSON.parse(
	await Bun.file(`${import.meta.dir}/fixtures/goldens/power/native-session-start.json`).text(),
) as Golden;

const { getWorkProfile, PowerAssertion } = native;

describe("power re-sync differential golden", () => {
	it("preserves macOS session lifecycle, removes the old export, and profiles operations", () => {
		expect(Reflect.get(native, golden.baselineExport)).toBeUndefined();
		let result = "";
		let released = false;
		try {
			const assertion = PowerAssertion.start(golden.options);
			assertion.stop();
			assertion.stop();
			released = true;
			result = "start-stop-idempotent";
		} catch (error) {
			if (process.platform !== "linux") throw error;
			expect(String(error)).toMatch(
				/Unable to connect to the system bus|login1 Inhibit failed|Invalid login1 inhibitor response/,
			);
			result = "linux-login1-unavailable";
		}
		if (process.platform === "linux" && result === "linux-login1-unavailable") {
			expect(getWorkProfile(60).folded).toContain("power.start");
			return;
		}
		expect(result).toBe(golden.baselineResult);
		expect(released).toBe(true);
		const profile = getWorkProfile(60).folded;
		expect(profile).toContain("power.start");
		expect(profile).toContain("power.stop");
	});
});
