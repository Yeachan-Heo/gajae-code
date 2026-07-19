import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { resolveMemoryBackend } from "@gajae-code/coding-agent/memory-backend";

describe("resolveMemoryBackend", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("preserves the existing off, local, and hindsight runtime selections without a filesystem backend", () => {
		const off = Settings.isolated({ "memory.backend": "off" });
		const local = Settings.isolated({ "memory.backend": "local" });
		const hindsightDisabled = Settings.isolated({ "memory.backend": "hindsight", "memories.enabled": false });
		const hindsightEnabled = Settings.isolated({ "memory.backend": "hindsight", "memories.enabled": true });

		expect(resolveMemoryBackend(off).id).toBe("off");
		expect(resolveMemoryBackend(local).id).toBe("local");
		expect(resolveMemoryBackend(hindsightDisabled).id).toBe("hindsight");
		expect(resolveMemoryBackend(hindsightEnabled).id).toBe("hindsight");
		expect(["off", "local", "hindsight"]).not.toContain("filesystem");
	});
});
