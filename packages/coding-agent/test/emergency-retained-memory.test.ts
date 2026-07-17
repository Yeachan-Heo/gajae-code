import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	emergencyCompactionReason,
	resetEmergencyRetainedMemoryDiagnosticsForTests,
} from "@gajae-code/agent-core/compaction";
import { logger } from "@gajae-code/utils";

const MIB = 1024 * 1024;
const sample = { heapUsedBytes: 0, providerBytes: 0, messageCount: 0, imageBytes: 0 };
const limits = {
	heapUsedBytes: 512 * MIB,
	providerBytes: 24 * MIB,
	messageCount: 4000,
	imageBytes: 64 * MIB,
	retainedMemoryBytes: 128 * MIB,
	retainedMemoryDiagnosticBytes: 64 * MIB,
	tuiChatChildren: 1000,
	tuiChatChildrenDiagnostic: 700,
};

describe("emergency retained-memory compaction", () => {
	afterEach(() => {
		resetEmergencyRetainedMemoryDiagnosticsForTests();
		vi.restoreAllMocks();
	});

	it("fires retainedMemory at exactly 128MiB combined retained bytes", () => {
		expect(
			emergencyCompactionReason(
				{ ...sample, materializedResidentBytes: 64 * MIB, tuiCachedRenderBytes: 64 * MIB },
				limits,
			),
		).toBe("retainedMemory");
	});

	it("fires retainedMemory at exactly 1000 TUI chat children", () => {
		expect(emergencyCompactionReason({ ...sample, tuiChatChildren: 1000 }, limits)).toBe("retainedMemory");
	});

	it("does not fire retainedMemory below retained byte and child floors", () => {
		expect(
			emergencyCompactionReason(
				{ ...sample, materializedResidentBytes: 63 * MIB, tuiCachedRenderBytes: 64 * MIB, tuiChatChildren: 999 },
				limits,
			),
		).toBeNull();
	});

	it("preserves ordering with heap before retainedMemory before providerBytes", () => {
		expect(
			emergencyCompactionReason(
				{
					...sample,
					heapUsedBytes: limits.heapUsedBytes + 1,
					materializedResidentBytes: 128 * MIB,
					providerBytes: limits.providerBytes + 1,
				},
				limits,
			),
		).toBe("heap");
		expect(
			emergencyCompactionReason(
				{ ...sample, materializedResidentBytes: 128 * MIB, providerBytes: limits.providerBytes + 1 },
				limits,
			),
		).toBe("retainedMemory");
	});

	it("logs retained diagnostics once per threshold crossing", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		expect(emergencyCompactionReason({ ...sample, materializedResidentBytes: 64 * MIB }, limits)).toBeNull();
		expect(emergencyCompactionReason({ ...sample, materializedResidentBytes: 65 * MIB }, limits)).toBeNull();
		expect(emergencyCompactionReason({ ...sample, materializedResidentBytes: 63 * MIB }, limits)).toBeNull();
		expect(emergencyCompactionReason({ ...sample, materializedResidentBytes: 64 * MIB }, limits)).toBeNull();
		expect(warn).toHaveBeenCalledTimes(2);
	});

	it("does not double count provider bytes as retained memory", () => {
		expect(
			emergencyCompactionReason(
				{
					...sample,
					providerBytes: limits.providerBytes + 1,
					sessionResidentImageBytes: 256 * MIB,
					materializedResidentBytes: 1,
					tuiCachedRenderBytes: 1,
				},
				limits,
			),
		).toBe("providerBytes");
	});
});
