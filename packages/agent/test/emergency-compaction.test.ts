import { describe, expect, it } from "bun:test";
import {
	emergencyCompactionReason,
	DEFAULT_EMERGENCY_COMPACTION_LIMITS as LIM,
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
});
