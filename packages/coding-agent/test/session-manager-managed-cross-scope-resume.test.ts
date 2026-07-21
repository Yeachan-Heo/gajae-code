import { describe, expect, it } from "bun:test";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { type ConfiguredModelChain, SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

function chain(entries: string[], origin = "startup-profile"): ConfiguredModelChain {
	return {
		role: "default",
		entries,
		origin,
		identity: "profile-id",
		explicitHead: true,
	};
}

describe("SessionManager managed cross-scope resume", () => {
	// Regression: resuming a managed session from a working directory whose
	// managed scope differs from where the session file actually lives (e.g. a
	// teammate/worktree session resumed by a controller in another directory)
	// used to abort the process with "Managed transcript escaped its session
	// directory" on the first persist (such as startup model-profile activation).
	it("persists after resume from a different working directory", async () => {
		using tempDir = TempDir.createSync("@pi-session-managed-cross-scope-resume-");
		const agentDir = tempDir.path();
		const cwdA = path.join(agentDir, "projA");
		const cwdB = path.join(agentDir, "projB");
		fsSync.mkdirSync(cwdA);
		fsSync.mkdirSync(cwdB);

		const originDestination = SessionManager.managedDestination(cwdA, agentDir);
		const creator = SessionManager.create(cwdA, originDestination);
		creator.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await creator.ensureOnDisk();
		await creator.flush();
		const sessionFile = creator.getSessionFile();
		if (!sessionFile) throw new Error("Expected managed session file");
		await creator.close();

		// The resume scope is derived from cwdB and does not own the session file.
		const resumeDestination = SessionManager.managedDestination(cwdB, agentDir);
		expect(path.resolve(path.dirname(sessionFile))).not.toBe(path.resolve(resumeDestination.directory));

		const reopened = await SessionManager.open(sessionFile, resumeDestination);
		try {
			expect(() => reopened.appendConfiguredModelChain(chain(["anthropic/claude", "openai/gpt"]))).not.toThrow();
			await reopened.flush();
			// The record must land in the origin session file, not the resume scope.
			expect(fsSync.readFileSync(sessionFile, "utf8")).toContain("configured_model_chain");
		} finally {
			await reopened.close();
		}
	});
});
