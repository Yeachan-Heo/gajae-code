import { describe, expect, it } from "bun:test";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateKeybindingsDocument } from "../scripts/generate-hotkeys-docs";

const DOC_PATH = join(import.meta.dir, "../../../docs/keybindings.md");

describe("hotkeys documentation", () => {
	it("matches the deterministic action catalog output", () => {
		const document = readFileSync(DOC_PATH, "utf8");
		expect(document).toBe(generateKeybindingsDocument(document));
	});

	it.each(["darwin", "linux", "win32"] as const)("is identical when the host platform is %s", platform => {
		const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
		if (!descriptor) throw new Error("process.platform descriptor is unavailable");
		Object.defineProperty(process, "platform", { configurable: true, value: platform });
		try {
			const document = readFileSync(DOC_PATH, "utf8");
			expect(generateKeybindingsDocument(document)).toBe(document);
		} finally {
			Object.defineProperty(process, "platform", descriptor);
		}
	});
});
