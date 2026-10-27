import { afterEach, describe, expect, test, vi } from "bun:test";
import { logger, TempDir } from "@gajae-code/utils";
import { formatAsyncResultForFollowUp } from "../../src/async/result-formatting";
import { SessionManager } from "../../src/session/session-manager";
import { DEFAULT_ARTIFACT_MAX_BYTES } from "../../src/session/streaming-output";

describe("async completion result formatting", () => {
	let manager: SessionManager | undefined;
	let tempDir: TempDir | undefined;

	afterEach(async () => {
		await manager?.close();
		vi.restoreAllMocks();
		tempDir?.removeSync();
		manager = undefined;
		tempDir = undefined;
	});

	function createManager(): SessionManager {
		tempDir = TempDir.createSync("@gjc-async-format-");
		manager = SessionManager.inMemory(tempDir.path());
		return manager;
	}

	test("keeps the inline boundary and denied previews free of storage calls", async () => {
		const sessionManager = createManager();
		const save = vi.spyOn(sessionManager, "saveArtifact");
		const inline = "i".repeat(12_000);
		expect(await formatAsyncResultForFollowUp(sessionManager, inline)).toBe(inline);
		const denied = await formatAsyncResultForFollowUp(sessionManager, "d".repeat(12_001), false);
		expect(denied).toBe(
			`${"d".repeat(4_000)}\n\n[Output truncated. Showing first ${(4_000).toLocaleString()} characters.]`,
		);
		expect(save).not.toHaveBeenCalled();
	});

	for (const refusal of ["unavailable", "refused"] as const) {
		test(`preserves a bounded truthful preview when storage is ${refusal}`, async () => {
			const sessionManager = createManager();
			const save = vi.spyOn(sessionManager, "saveArtifact");
			if (refusal === "unavailable") save.mockResolvedValue(undefined);
			else save.mockRejectedValue(new Error("private storage failure /secret/path"));
			const result = "p".repeat(12_001);
			const formatted = await formatAsyncResultForFollowUp(sessionManager, result);
			expect(save).toHaveBeenCalledWith(result, "async");
			expect(formatted).toStartWith("p".repeat(4_000));
			expect(formatted).toContain("storage unavailable");
			expect(formatted.length).toBeLessThan(4_300);
			expect(formatted).not.toContain("artifact://");
			expect(formatted).not.toContain("private storage failure");
			expect(formatted).not.toContain("/secret/path");
		});
	}

	test("keeps the completion preview when storage diagnostics also fail", async () => {
		const sessionManager = createManager();
		vi.spyOn(sessionManager, "saveArtifact").mockRejectedValue(new Error("storage refusal"));
		vi.spyOn(logger, "warn").mockImplementation(() => {
			throw new Error("diagnostic failure");
		});
		const formatted = await formatAsyncResultForFollowUp(sessionManager, "p".repeat(12_001));
		expect(formatted).toStartWith("p".repeat(4_000));
		expect(formatted).toContain("storage unavailable");
		expect(formatted).not.toContain("artifact://");
	});

	test("publishes completion output through secured storage", async () => {
		const sessionManager = createManager();
		const result = "secured completion\n".repeat(1_000);
		const formatted = await formatAsyncResultForFollowUp(sessionManager, result);
		const artifactId = formatted.match(/artifact:\/\/(\S+)/)?.[1];
		if (!artifactId) throw new Error("expected published artifact receipt");
		const artifactPath = await sessionManager.getArtifactPath(artifactId);
		if (!artifactPath) throw new Error("expected secured artifact path");
		expect(await Bun.file(artifactPath).text()).toBe(result);
		expect(formatted).toContain("Saved completion output:");
		expect(formatted).not.toContain("Full output");
	});

	test("reports exact omitted UTF-8 bytes when secured storage caps completion output", async () => {
		const sessionManager = createManager();
		// The cap falls inside a three-byte character: one byte of headroom is unused.
		const result = "€".repeat(Math.floor(DEFAULT_ARTIFACT_MAX_BYTES / 3) + 2);
		const formatted = await formatAsyncResultForFollowUp(sessionManager, result);
		expect(formatted).toContain("incomplete; omitted 6 UTF-8 bytes");
		const artifactId = formatted.match(/artifact:\/\/(\S+)/)?.[1];
		if (!artifactId) throw new Error("expected capped artifact receipt");
		const artifactPath = await sessionManager.getArtifactPath(artifactId);
		if (!artifactPath) throw new Error("expected capped artifact path");
		const saved = await Bun.file(artifactPath).text();
		expect(saved).toContain("omitted at least 6 bytes");
		expect(saved).not.toContain("�");
	});
});
