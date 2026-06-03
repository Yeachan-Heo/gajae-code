import { describe, expect, it } from "bun:test";
import {
	DEFERRED_SEAMS,
	isHarnessSupported,
	SUPPORTED_HARNESSES,
	unsupportedSeam,
} from "../../src/harness-control-plane/seams";

describe("v1 seams", () => {
	it("only gajae-code is supported in v1", () => {
		expect(SUPPORTED_HARNESSES).toEqual(["gajae-code"]);
		expect(isHarnessSupported("gajae-code")).toBe(true);
		expect(isHarnessSupported("codex")).toBe(false);
		expect(isHarnessSupported("omx")).toBe(false);
	});

	it("unsupportedSeam fails closed with a clear signal + deferral list", () => {
		const res = unsupportedSeam("codex-adapter");
		expect(res.ok).toBe(false);
		expect(res.error).toBe("seam_unsupported_in_v1:codex-adapter");
		expect(res.evidence.deferred).toContain("codex-adapter");
		expect(res.evidence.deferred).toContain("remote-transport");
		expect(res.evidence.supported).toEqual(["gajae-code"]);
	});

	it("documents the deferred (designed-not-built) surfaces", () => {
		for (const seam of [
			"codex-adapter",
			"omx-adapter",
			"remote-transport",
			"global-daemon",
			"capability-token-auth",
		]) {
			expect(DEFERRED_SEAMS as readonly string[]).toContain(seam);
		}
	});
});
