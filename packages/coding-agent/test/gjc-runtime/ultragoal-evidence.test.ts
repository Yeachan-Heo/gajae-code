import { describe, expect, it } from "bun:test";
import { isAllowedGitReplayCommand, pngCrc32 } from "@gajae-code/coding-agent/gjc-runtime/ultragoal-evidence";

describe("ultragoal evidence extraction", () => {
	it("retains the PNG CRC32 implementation", () => {
		expect(pngCrc32(Buffer.from("123456789"))).toBe(0xcbf43926);
	});

	it("retains the conservative git replay allowlist", () => {
		expect(isAllowedGitReplayCommand(["diff", "--stat", "HEAD"])).toBe(true);
		expect(isAllowedGitReplayCommand(["diff", "--output=/tmp/out"])).toBe(false);
	});
});
