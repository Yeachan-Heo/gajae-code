import { describe, expect, it } from "bun:test";

import { formatBunRuntimeError } from "../src/dirs";

describe("formatBunRuntimeError", () => {
	it("reports the required and detected Bun versions", () => {
		const message = formatBunRuntimeError({
			currentVersion: "1.3.12",
			minVersion: "1.3.14",
			platform: "linux",
		});
		expect(message).toContain("requires Bun >= 1.3.14");
		expect(message).toContain("v1.3.12");
		expect(message.endsWith("\n")).toBe(true);
	});

	it("names the detected runtime path when provided", () => {
		const message = formatBunRuntimeError({
			currentVersion: "1.3.12",
			minVersion: "1.3.14",
			execPath: "C:\\Users\\dev\\.bun\\bin\\bun.exe",
			platform: "win32",
		});
		expect(message).toContain("detected Bun runtime: C:\\Users\\dev\\.bun\\bin\\bun.exe");
	});

	it("gives a Windows-specific upgrade and PATH fix on win32", () => {
		const message = formatBunRuntimeError({
			currentVersion: "1.3.12",
			minVersion: "1.3.14",
			platform: "win32",
		});
		expect(message).toContain('powershell -c "irm bun.sh/install.ps1|iex"');
		expect(message).toContain("%USERPROFILE%\\.bun\\bin");
		expect(message).not.toContain("bun upgrade");
	});

	it("uses bun upgrade on non-Windows platforms", () => {
		const message = formatBunRuntimeError({
			currentVersion: "1.3.12",
			minVersion: "1.3.14",
			platform: "darwin",
		});
		expect(message).toContain("bun upgrade");
		expect(message).not.toContain("install.ps1");
		expect(message).not.toContain("%USERPROFILE%");
	});
});
