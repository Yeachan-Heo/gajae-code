import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ConfiguredModelChain, SessionManager } from "@gajae-code/coding-agent/session/session-manager";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-configured-model-chain-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
});

function chain(entries: string[], origin = "model_selection"): ConfiguredModelChain {
	return {
		role: "default",
		entries,
		origin,
		identity: "profile-id",
		explicitHead: true,
	};
}

describe("SessionManager configured model chain persistence", () => {
	it("appends and reloads configured chains without sticky controller fields", async () => {
		const root = makeTempDir();
		const session = SessionManager.create(root, path.join(root, "sessions"));
		session.appendConfiguredModelChain({
			...chain(["anthropic/claude", "openai/gpt"]),
			activeIndex: 1,
			attemptsUsed: 2,
		} as ConfiguredModelChain);

		await session.ensureOnDisk();
		await session.flush();
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		await session.close();

		const persisted = await Bun.file(sessionFile).text();
		expect(persisted).toContain('"type":"configured_model_chain"');
		expect(persisted).not.toContain("activeIndex");
		expect(persisted).not.toContain("attemptsUsed");
		expect(persisted).not.toContain("attempts");

		const reopened = await SessionManager.open(sessionFile);
		try {
			expect(reopened.buildSessionContext().configuredModelChains).toEqual({
				default: chain(["anthropic/claude", "openai/gpt"]),
			});
		} finally {
			await reopened.close();
		}
	});

	it("uses the newest configured assignment on a branch", () => {
		const session = SessionManager.inMemory();
		session.appendConfiguredModelChain(chain(["anthropic/claude"]));
		session.appendConfiguredModelChain(chain(["openai/gpt", "google/gemini"], "profile_activation"));

		expect(session.buildSessionContext().configuredModelChains.default).toEqual(
			chain(["openai/gpt", "google/gemini"], "profile_activation"),
		);
	});

	it("restores the prior configured assignment after branching before the newer assignment", () => {
		const session = SessionManager.inMemory();
		const firstAssignmentId = session.appendConfiguredModelChain(chain(["anthropic/claude"]));
		session.appendConfiguredModelChain(chain(["openai/gpt"]));

		session.branch(firstAssignmentId);
		session.appendMessage({ role: "user", content: "retry from this point", timestamp: Date.now() });

		expect(session.buildSessionContext().configuredModelChains.default).toEqual(chain(["anthropic/claude"]));
	});

	it("synthesizes one-entry configured chains when loading legacy single-model sessions", async () => {
		const root = makeTempDir();
		const session = SessionManager.create(root, path.join(root, "sessions"));
		session.appendModelChange("anthropic/claude", "default");
		session.appendModelChange("openai/gpt", "small");
		await session.ensureOnDisk();
		await session.flush();
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		await session.close();

		const reopened = await SessionManager.open(sessionFile);
		try {
			expect(reopened.buildSessionContext().configuredModelChains).toEqual({
				default: {
					role: "default",
					entries: ["anthropic/claude"],
					origin: "legacy_session",
					explicitHead: true,
				},
				small: {
					role: "small",
					entries: ["openai/gpt"],
					origin: "legacy_session",
					explicitHead: true,
				},
			});
		} finally {
			await reopened.close();
		}
	});

	it("synthesizes a legacy chain only for roles without a configured entry", () => {
		const session = SessionManager.inMemory();
		session.appendConfiguredModelChain(chain(["anthropic/claude", "openai/gpt"]));
		session.appendModelChange("anthropic/claude", "default");
		session.appendModelChange("openai/gpt", "small");

		expect(session.buildSessionContext().configuredModelChains).toEqual({
			default: chain(["anthropic/claude", "openai/gpt"]),
			small: {
				role: "small",
				entries: ["openai/gpt"],
				origin: "legacy_session",
				explicitHead: true,
			},
		});
	});

	it("clears a configured chain so legacy model assignments are synthesized again", () => {
		const session = SessionManager.inMemory();
		session.appendModelChange("anthropic/claude", "default");
		session.appendConfiguredModelChain(chain(["openai/gpt", "google/gemini"]));
		session.appendConfiguredModelChain({
			...chain([]),
			origin: "rollback",
			cleared: true,
		});

		expect(session.buildSessionContext().configuredModelChains.default).toEqual({
			role: "default",
			entries: ["anthropic/claude"],
			origin: "legacy_session",
			explicitHead: true,
		});
	});
});
