import { describe, expect, it } from "bun:test";
import {
	emergencyCompactionReason,
	DEFAULT_EMERGENCY_COMPACTION_LIMITS as LIM,
	resolveEmergencyCompactionLimits,
} from "@gajae-code/agent-core/compaction";

const under = { heapUsedBytes: 1, providerBytes: 1, messageCount: 1, imageBytes: 1 };

describe("emergencyCompactionReason (W4 / F6)", () => {
	it("returns null when every resource is under its floor", () => {
		expect(emergencyCompactionReason(under)).toBeNull();
		expect(
			emergencyCompactionReason({
				heapUsedBytes: LIM.heapUsedBytes,
				providerBytes: LIM.providerBytes,
				messageCount: LIM.messageCount,
				imageBytes: LIM.imageBytes,
			}),
		).toBeNull(); // strictly greater-than required
	});

	it("flags each exceeded floor by name", () => {
		expect(emergencyCompactionReason({ ...under, heapUsedBytes: LIM.heapUsedBytes + 1 })).toBe("heap");
		expect(emergencyCompactionReason({ ...under, providerBytes: LIM.providerBytes + 1 })).toBe("providerBytes");
		expect(emergencyCompactionReason({ ...under, imageBytes: LIM.imageBytes + 1 })).toBe("imageBytes");
		expect(emergencyCompactionReason({ ...under, messageCount: LIM.messageCount + 1 })).toBe("messageCount");
	});

	it("prioritizes heap > providerBytes > imageBytes > messageCount", () => {
		expect(
			emergencyCompactionReason({
				heapUsedBytes: LIM.heapUsedBytes + 1,
				providerBytes: LIM.providerBytes + 1,
				imageBytes: LIM.imageBytes + 1,
				messageCount: LIM.messageCount + 1,
			}),
		).toBe("heap");
		expect(
			emergencyCompactionReason({
				...under,
				providerBytes: LIM.providerBytes + 1,
				imageBytes: LIM.imageBytes + 1,
				messageCount: LIM.messageCount + 1,
			}),
		).toBe("providerBytes");
		expect(
			emergencyCompactionReason({ ...under, imageBytes: LIM.imageBytes + 1, messageCount: LIM.messageCount + 1 }),
		).toBe("imageBytes");
	});

	it("honors injected custom limits (non-disableable floor is just a different number, never off)", () => {
		const limits = { heapUsedBytes: 1e15, providerBytes: 1e15, messageCount: 10, imageBytes: 1e15 };
		expect(emergencyCompactionReason({ ...under, messageCount: 11 }, limits)).toBe("messageCount");
		expect(emergencyCompactionReason({ ...under, messageCount: 10 }, limits)).toBeNull();
	});

	it("caps heap floor at half of small total memory", () => {
		const twoGiB = 2 * 1024 * 1024 * 1024;
		const limits = resolveEmergencyCompactionLimits(twoGiB);

		expect(limits.heapUsedBytes).toBe(1024 * 1024 * 1024);
		expect(emergencyCompactionReason({ ...under, heapUsedBytes: limits.heapUsedBytes }, limits)).toBeNull();
		expect(emergencyCompactionReason({ ...under, heapUsedBytes: limits.heapUsedBytes + 1 }, limits)).toBe("heap");
	});

	it("preserves the 1.5 GiB heap floor on large total memory", () => {
		const sixtyFourGiB = 64 * 1024 * 1024 * 1024;
		const limits = resolveEmergencyCompactionLimits(sixtyFourGiB);

		expect(limits.heapUsedBytes).toBe(1_536 * 1024 * 1024);
		expect(limits.providerBytes).toBe(LIM.providerBytes);
		expect(limits.messageCount).toBe(LIM.messageCount);
		expect(limits.imageBytes).toBe(LIM.imageBytes);
	});

	it("uses injected total memory without process-global state", () => {
		const smallLimits = resolveEmergencyCompactionLimits(2 * 1024 * 1024 * 1024);
		const largeLimits = resolveEmergencyCompactionLimits(64 * 1024 * 1024 * 1024);

		expect(smallLimits.heapUsedBytes).toBe(1024 * 1024 * 1024);
		expect(largeLimits.heapUsedBytes).toBe(1_536 * 1024 * 1024);
		expect(emergencyCompactionReason({ ...under, heapUsedBytes: smallLimits.heapUsedBytes + 1 }, smallLimits)).toBe(
			"heap",
		);
		expect(
			emergencyCompactionReason({ ...under, heapUsedBytes: smallLimits.heapUsedBytes + 1 }, largeLimits),
		).toBeNull();
	});
	it("falls back to the fixed 1.5 GiB floor on invalid total memory", () => {
		const fullFloor = 1_536 * 1024 * 1024;
		expect(resolveEmergencyCompactionLimits(0).heapUsedBytes).toBe(fullFloor);
		expect(resolveEmergencyCompactionLimits(-1).heapUsedBytes).toBe(fullFloor);
		expect(resolveEmergencyCompactionLimits(Number.NaN).heapUsedBytes).toBe(fullFloor);
		expect(resolveEmergencyCompactionLimits(Number.POSITIVE_INFINITY).heapUsedBytes).toBe(fullFloor);
	});

	it("exposes a 48 MiB transcript-file floor by default", () => {
		expect(LIM.transcriptFileBytes).toBe(48 * 1024 * 1024);
	});

	it("flags transcriptFile when the transcript exceeds its floor", () => {
		expect(
			emergencyCompactionReason({
				...under,
				transcriptFileBytes: LIM.transcriptFileBytes! + 1,
			}),
		).toBe("transcriptFile");
		expect(emergencyCompactionReason({ ...under, transcriptFileBytes: LIM.transcriptFileBytes })).toBeNull();
	});

	it("does not flag transcriptFile when the value is 0 or undefined", () => {
		expect(emergencyCompactionReason({ ...under, transcriptFileBytes: 0 })).toBeNull();
		expect(emergencyCompactionReason({ ...under, transcriptFileBytes: undefined })).toBeNull();
	});

	it("prioritizes transcriptFile above providerBytes", () => {
		expect(
			emergencyCompactionReason({
				...under,
				transcriptFileBytes: LIM.transcriptFileBytes! + 1,
				providerBytes: LIM.providerBytes + 1,
			}),
		).toBe("transcriptFile");
	});

	it("prevents emergency compaction loop: requires 50% growth since last compaction", () => {
		// Initial trigger when no previous compaction state
		const floor = LIM.transcriptFileBytes!;
		const currentSize = floor + 1; // Exceeds floor

		expect(
			emergencyCompactionReason(
				{ ...under, transcriptFileBytes: currentSize },
				LIM,
				undefined, // No previous compaction
			),
		).toBe("transcriptFile");

		// After compaction, file stayed large (couldn't shrink enough)
		const afterCompactionSize = floor + 5_000_000; // Still over floor but recorded as baseline

		// File grew to exactly 1.5x - should NOT trigger (need STRICTLY greater than 1.5x)
		const slightGrowth = Math.floor(afterCompactionSize * 1.5);
		expect(
			emergencyCompactionReason({ ...under, transcriptFileBytes: slightGrowth }, LIM, afterCompactionSize),
		).toBeNull();

		// File grew to > 1.5x - SHOULD trigger
		const significantGrowth = Math.floor(afterCompactionSize * 1.5) + 1;
		expect(
			emergencyCompactionReason({ ...under, transcriptFileBytes: significantGrowth }, LIM, afterCompactionSize),
		).toBe("transcriptFile");
	});
});
