import { describe, expect, it } from "bun:test";
import { decideProfilePosture } from "../../src/tools/browser/profile-posture";

describe("decideProfilePosture", () => {
	it("auto default uses the real profile with a warning when available", () => {
		const d = decideProfilePosture({ realProfileAvailable: true });
		expect(d.mode).toBe("real");
		expect(d.reason).toBe("auto-real");
		expect(d.warning).toContain("isolated copy");
	});

	it("falls back to synthetic when no real profile is available (even under auto)", () => {
		const d = decideProfilePosture({ posture: "auto", realProfileAvailable: false });
		expect(d.mode).toBe("synthetic");
		expect(d.reason).toBe("synthetic-fallback");
		expect(d.warning).toBeNull();
	});

	it("opt-in stays synthetic unless explicitly requested", () => {
		const d = decideProfilePosture({ posture: "opt-in", realProfileAvailable: true });
		expect(d.mode).toBe("synthetic");
		expect(d.reason).toBe("synthetic-opt-in");
	});

	it("opt-in uses the real profile when explicitly requested", () => {
		const d = decideProfilePosture({ posture: "opt-in", realProfileAvailable: true, explicitlyRequested: true });
		expect(d.mode).toBe("real");
		expect(d.reason).toBe("explicit-real");
		expect(d.warning).toContain("Real logged-in credentials");
	});
});
