import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigRootDir, setAgentDir } from "@gajae-code/utils";
import { ManagedSessionDescendantStore } from "../../src/session/internal/managed-session-storage";
import {
	CURRENT_SESSION_VERSION,
	parseSessionEntries,
	type SessionInfo,
	SessionManager,
	SessionManagerTestHooks,
} from "../../src/session/session-manager";
import { makeAssistantMessage } from "./helpers";

let root: string;
let cwd: string;
let directory: string;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-picker-star-"));
	cwd = path.join(root, "workspace");
	directory = path.join(root, "explicit");
	await fs.mkdir(cwd);
	await fs.mkdir(directory);
	setAgentDir(root);
});

afterEach(async () => {
	vi.restoreAllMocks();
	setAgentDir(originalAgentDir ?? path.join(getConfigRootDir(), "agent"));
	if (!originalAgentDir) delete process.env.PI_CODING_AGENT_DIR;
	await fs.rm(root, { recursive: true, force: true });
});

async function fixture(options: { capable?: boolean; newline?: boolean; version?: number; dir?: string } = {}) {
	const file = path.join(options.dir ?? directory, "candidate.jsonl");
	const header = {
		type: "session",
		version: options.version ?? CURRENT_SESSION_VERSION,
		...(options.capable === false ? {} : { starredPatchVersion: 1 }),
		id: "candidate",
		cwd,
		timestamp: "2026-09-13T00:00:00.000Z",
		title: "Keep me",
	};
	const message = {
		type: "message",
		id: "user",
		parentId: null,
		timestamp: header.timestamp,
		message: { role: "user", content: "important work", timestamp: 1 },
	};
	const content = `${JSON.stringify(header)}\n${JSON.stringify(message)}${options.newline === false ? "" : "\n"}`;
	await Bun.write(file, content);
	await fs.chmod(file, 0o600);
	const candidate: SessionInfo = {
		path: file,
		id: header.id,
		cwd,
		title: header.title,
		starred: false,
		created: new Date(),
		modified: new Date(),
		messageCount: 1,
		size: content.length,
		firstMessage: "important work",
		allMessagesText: "important work",
	};
	return { candidate, content, file };
}

async function starred(file: string): Promise<boolean> {
	const header = parseSessionEntries(await Bun.file(file).text())[0];
	return header?.type === "session" && header.starredPatchVersion === 1 && header.starred === true;
}

describe("picker star persistence", () => {
	it.each([
		true,
		false,
	])("appends star and unstar, preserves transcript bytes, and relists (newline=%s)", async newline => {
		const { candidate, content, file } = await fixture({ newline });
		await SessionManager.setSessionStarredForPicker(candidate, true, directory);
		const saved = await Bun.file(file).text();
		expect(saved).toBe(`${content}${newline ? "" : "\n"}{"type":"header_patch","patch":{"starred":true}}\n`);
		expect(await starred(file)).toBe(true);
		expect((await SessionManager.listForResumePickerReadOnly(cwd, directory))[0]?.starred).toBe(true);
		await SessionManager.setSessionStarredForPicker(candidate, true, directory);
		expect(await Bun.file(file).text()).toBe(saved);
		await SessionManager.setSessionStarredForPicker(candidate, false, directory);
		expect(await starred(file)).toBe(false);
		expect((await SessionManager.listForResumePickerReadOnly(cwd, directory))[0]?.starred).toBe(false);
	});

	it("upgrades star capability without rewriting message payloads or consuming artifacts", async () => {
		const { candidate, content, file } = await fixture({ capable: false });
		const draft = path.join(directory, "candidate", "draft.txt");
		const breadcrumb = path.join(root, "terminal-sessions", "unrelated");
		await Bun.write(draft, "unsent draft");
		await Bun.write(breadcrumb, "another session");
		const pathsBefore = (await fs.readdir(root)).sort();
		await SessionManager.setSessionStarredForPicker(candidate, true, directory);
		const saved = await Bun.file(file).text();
		expect(saved.slice(saved.indexOf("\n") + 1)).toBe(
			`${content.slice(content.indexOf("\n") + 1)}{"type":"header_patch","patch":{"starred":true}}\n`,
		);
		expect(JSON.parse(saved.split("\n")[0]!)).toMatchObject({
			version: CURRENT_SESSION_VERSION,
			id: "candidate",
			starredPatchVersion: 1,
		});
		expect(await Bun.file(draft).text()).toBe("unsent draft");
		expect(await Bun.file(breadcrumb).text()).toBe("another session");
		expect((await fs.readdir(root)).sort()).toEqual(pathsBefore);
		expect(await fs.readdir(path.dirname(draft))).toEqual(["draft.txt"]);
		expect(await fs.readdir(path.dirname(breadcrumb))).toEqual(["unrelated"]);
	});

	it("stars a managed candidate in place without opening a session", async () => {
		const manager = SessionManager.create(cwd);
		manager.appendMessage({ role: "user", content: "managed work", timestamp: 1 });
		manager.appendMessage(makeAssistantMessage());
		await manager.flush();
		await manager.close();
		const [candidate] = await SessionManager.listManagedForResumePickerReadOnly(cwd);
		expect(candidate).toBeDefined();
		await SessionManager.setSessionStarredForPicker(candidate!, true);
		expect(await starred(candidate!.path)).toBe(true);
		await SessionManager.setSessionStarredForPicker(candidate!, false);
		expect(await starred(candidate!.path)).toBe(false);
	});

	it("reuses the live manager so later writes retain the star", async () => {
		const manager = SessionManager.create(cwd);
		try {
			manager.appendMessage({ role: "user", content: "active work", timestamp: 1 });
			manager.appendMessage(makeAssistantMessage());
			await manager.flush();
			const [candidate] = await manager.listForResumePickerReadOnly();
			await manager.setSessionStarredForPicker(candidate!, true);
			expect(manager.isSessionStarred()).toBe(true);
			candidate!.starred = true;
			await manager.setSessionStarredForPicker(candidate!, false);
			expect(manager.isSessionStarred()).toBe(false);
			candidate!.starred = false;
			await manager.setSessionStarredForPicker(candidate!, true);
			expect(manager.isSessionStarred()).toBe(true);
			await manager.setSessionName("renamed", "user");
			manager.appendMessage({ role: "user", content: "still active", timestamp: 2 });
			await manager.flush();
			expect(await starred(manager.getSessionFile()!)).toBe(true);
		} finally {
			await manager.close();
		}
	});

	it("keeps an explicit live writer coherent across repeated same-row toggles", async () => {
		const { file } = await fixture();
		const manager = SessionManager.create(cwd, SessionManager.explicitDestination(directory));
		try {
			await manager.setSessionFile(file);
			const [candidate] = await manager.listForResumePickerReadOnly();
			await manager.setSessionStarredForPicker(candidate!, true);
			candidate!.starred = true;
			await manager.setSessionStarredForPicker(candidate!, false);

			expect(manager.isSessionStarred()).toBe(false);
			expect(await starred(file)).toBe(false);
			manager.appendMessage({ role: "user", content: "after picker toggle", timestamp: 2 });
			await manager.flush();
			expect(await starred(file)).toBe(false);
		} finally {
			await manager.close();
		}
	});

	it("upgrades star capability through the fenced live explicit-writer path", async () => {
		const { content, file } = await fixture({ capable: false });
		const manager = SessionManager.create(cwd, SessionManager.explicitDestination(directory));
		try {
			await manager.setSessionFile(file);
			const [candidate] = await manager.listForResumePickerReadOnly();
			await manager.setSessionStarredForPicker(candidate!, true);

			expect(manager.isSessionStarred()).toBe(true);
			const saved = await Bun.file(file).text();
			expect(saved.slice(saved.indexOf("\n") + 1)).toBe(
				`${content.slice(content.indexOf("\n") + 1)}{"type":"header_patch","patch":{"starred":true}}\n`,
			);
			expect(JSON.parse(saved.split("\n")[0]!)).toMatchObject({
				id: "candidate",
				starredPatchVersion: 1,
			});
		} finally {
			await manager.close();
		}
	});

	it.each([
		true,
		false,
	])("rejects a final expected-identity race without mutating explicit live state (capable=%s)", async capable => {
		const { file } = await fixture({ capable });
		const manager = SessionManager.create(cwd, SessionManager.explicitDestination(directory));
		try {
			await manager.setSessionFile(file);
			const [candidate] = await manager.listForResumePickerReadOnly();
			const original = ManagedSessionDescendantStore.prototype.readExpected;
			const competingPatch = '{"type":"header_patch","patch":{"title":"concurrent writer"}}\n';
			let competingContent = "";
			let injected = false;
			vi.spyOn(ManagedSessionDescendantStore.prototype, "readExpected").mockImplementation(function (
				this: ManagedSessionDescendantStore,
				relativePath,
			) {
				const snapshot = original.call(this, relativePath);
				if (snapshot && !injected) {
					injected = true;
					competingContent = `${snapshot.bytes.toString("utf8")}${competingPatch}`;
					if (capable)
						this.appendExpectedIdentitySync(relativePath, Buffer.from(competingPatch), snapshot.identity);
					else this.replaceExpectedIdentitySync(relativePath, Buffer.from(competingContent), snapshot.identity);
				}
				return snapshot;
			});

			await expect(manager.setSessionStarredForPicker(candidate!, true)).rejects.toThrow("identity_mismatch");

			expect(injected).toBe(true);
			expect(manager.isSessionStarred()).toBe(false);
			expect(await Bun.file(file).text()).toBe(competingContent);
		} finally {
			await manager.close();
		}
	});

	it("rejects stale live rows without changing the active session", async () => {
		const manager = SessionManager.create(cwd);
		try {
			manager.appendMessage({ role: "user", content: "active work", timestamp: 1 });
			manager.appendMessage(makeAssistantMessage());
			await manager.flush();
			const [candidate] = await manager.listForResumePickerReadOnly();
			const before = await Bun.file(candidate!.path).text();

			await expect(manager.setSessionStarredForPicker({ ...candidate!, id: "stale" }, true)).rejects.toThrow(
				"identity changed",
			);
			await expect(manager.setSessionStarredForPicker({ ...candidate!, cwd: root }, true)).rejects.toThrow(
				"workspace changed",
			);

			expect(manager.isSessionStarred()).toBe(false);
			expect(await Bun.file(candidate!.path).text()).toBe(before);
		} finally {
			await manager.close();
		}
	});

	it("rejects a replacement at the active path even when its header identity matches", async () => {
		const manager = SessionManager.create(cwd);
		try {
			manager.appendMessage({ role: "user", content: "active work", timestamp: 1 });
			manager.appendMessage(makeAssistantMessage());
			await manager.flush();
			const [candidate] = await manager.listForResumePickerReadOnly();
			const replacement = (await Bun.file(candidate!.path).text()).replace("active work", "other work ");
			const replacementPath = path.join(path.dirname(candidate!.path), "replacement.jsonl");
			await Bun.write(replacementPath, replacement);
			await fs.chmod(replacementPath, 0o600);
			await fs.rename(replacementPath, candidate!.path);

			await expect(manager.setSessionStarredForPicker(candidate!, true)).rejects.toThrow("identity changed");

			expect(manager.isSessionStarred()).toBe(false);
			expect(await Bun.file(candidate!.path).text()).toBe(replacement);
			expect(await starred(candidate!.path)).toBe(false);
		} finally {
			await manager.close();
		}
	});

	it("does not recreate a deleted live candidate", async () => {
		const manager = SessionManager.create(cwd);
		try {
			manager.appendMessage({ role: "user", content: "active work", timestamp: 1 });
			manager.appendMessage(makeAssistantMessage());
			await manager.flush();
			const [candidate] = await manager.listForResumePickerReadOnly();
			await fs.unlink(candidate!.path);

			await expect(manager.setSessionStarredForPicker(candidate!, true)).rejects.toThrow("identity changed");

			expect(manager.isSessionStarred()).toBe(false);
			expect(await Bun.file(candidate!.path).exists()).toBe(false);
		} finally {
			await manager.close();
		}
	});

	it("fences a live picker toggle against a session lifecycle transition", async () => {
		const manager = SessionManager.create(cwd);
		try {
			manager.appendMessage({ role: "user", content: "active work", timestamp: 1 });
			manager.appendMessage(makeAssistantMessage());
			await manager.flush();
			const [candidate] = await manager.listForResumePickerReadOnly();
			const before = await Bun.file(candidate!.path).text();
			const prepared = await manager.prepareNewSession();
			SessionManagerTestHooks.beforeLivePickerStarFence = () => {
				SessionManagerTestHooks.beforeLivePickerStarFence = undefined;
				manager.commitPreparedNewSession(prepared);
			};

			await expect(manager.setSessionStarredForPicker(candidate!, true)).rejects.toThrow("identity changed");

			expect(manager.isSessionStarred()).toBe(false);
			expect(await Bun.file(candidate!.path).text()).toBe(before);
			expect(manager.getSessionId()).not.toBe(candidate!.id);
			expect(await Bun.file(manager.getSessionFile()!).exists()).toBe(false);
		} finally {
			SessionManagerTestHooks.beforeLivePickerStarFence = undefined;
			await manager.close();
		}
	});

	it("rejects changed session identity, workspace, and an explicit directory escape", async () => {
		const { candidate, content, file } = await fixture();
		await expect(
			SessionManager.setSessionStarredForPicker({ ...candidate, id: "other" }, true, directory),
		).rejects.toThrow("identity changed");
		await expect(
			SessionManager.setSessionStarredForPicker({ ...candidate, cwd: root }, true, directory),
		).rejects.toThrow("workspace changed");
		await expect(SessionManager.setSessionStarredForPicker(candidate, true, cwd)).rejects.toThrow("outside");
		expect(await Bun.file(file).text()).toBe(content);
	});

	it("rejects missing files and symlink targets instead of creating or following them", async () => {
		const { candidate, content, file } = await fixture();
		await fs.unlink(file);
		await expect(SessionManager.setSessionStarredForPicker(candidate, true, directory)).rejects.toThrow();
		expect(await Bun.file(file).exists()).toBe(false);
		const target = path.join(cwd, "target.jsonl");
		await Bun.write(target, content);
		await fs.symlink(target, file);
		await expect(SessionManager.setSessionStarredForPicker(candidate, true, directory)).rejects.toThrow();
		expect(await Bun.file(target).text()).toBe(content);
	});

	it.each([
		true,
		false,
	])("preserves a concurrent winner instead of appending or replacing stale bytes (capable=%s)", async capable => {
		const { candidate, file } = await fixture({ capable });
		const original = ManagedSessionDescendantStore.prototype.readExpected;
		const competingPatch = '{"type":"header_patch","patch":{"title":"concurrent writer"}}\n';
		let injected = false;
		vi.spyOn(ManagedSessionDescendantStore.prototype, "readExpected").mockImplementation(function (
			this: ManagedSessionDescendantStore,
			relativePath,
		) {
			const snapshot = original.call(this, relativePath);
			if (snapshot && !injected) {
				injected = true;
				this.appendExpectedIdentitySync(relativePath, Buffer.from(competingPatch), snapshot.identity);
			}
			return snapshot;
		});
		const before = await Bun.file(file).text();
		await expect(SessionManager.setSessionStarredForPicker(candidate, true, directory)).rejects.toThrow(
			"identity_mismatch",
		);
		expect(injected).toBe(true);
		expect(await Bun.file(file).text()).toBe(before + competingPatch);
	});

	it("supports project-local candidates without managed-directory migration", async () => {
		const projectDir = path.join(cwd, ".gjc", "sessions");
		await fs.mkdir(projectDir, { recursive: true });
		const { candidate, file } = await fixture({ dir: projectDir, capable: false });
		await SessionManager.setSessionStarredForPicker(candidate, true);
		expect(await starred(file)).toBe(true);
		expect(await Bun.file(path.join(root, "sessions")).exists()).toBe(false);
	});

	it("rejects foreign default-scope candidates and old formats without migration", async () => {
		const { candidate, content, file } = await fixture({ version: 3, capable: false });
		await expect(SessionManager.setSessionStarredForPicker(candidate, true)).rejects.toThrow(
			"authorized managed candidate",
		);
		await expect(SessionManager.setSessionStarredForPicker(candidate, true, directory)).rejects.toThrow(
			"requires an upgrade",
		);
		expect(await Bun.file(file).text()).toBe(content);
	});

	it("does not recreate a candidate deleted between inspection and mutation", async () => {
		const { candidate, file } = await fixture();
		const original = ManagedSessionDescendantStore.prototype.readExpected;
		vi.spyOn(ManagedSessionDescendantStore.prototype, "readExpected").mockImplementation(function (
			this: ManagedSessionDescendantStore,
			relativePath,
		) {
			const snapshot = original.call(this, relativePath);
			if (snapshot) this.removeExpected(relativePath, snapshot);
			return snapshot;
		});
		await expect(SessionManager.setSessionStarredForPicker(candidate, true, directory)).rejects.toThrow();
		expect(await Bun.file(file).exists()).toBe(false);
	});

	it("stars a pre-capability legacy-directory row without moving it to v2", async () => {
		const legacyName = `--${path
			.resolve(cwd)
			.replace(/^[/\\]/, "")
			.replace(/[/\\:]/g, "-")}--`;
		const sessionsRoot = path.join(root, "sessions");
		const legacyDir = path.join(sessionsRoot, legacyName);
		await fs.mkdir(legacyDir, { recursive: true });
		const { candidate, file } = await fixture({ dir: legacyDir, capable: false });
		const listed = await SessionManager.listManagedForResumePickerReadOnly(cwd);
		expect(listed.some(row => row.id === candidate.id)).toBe(true);
		await SessionManager.setSessionStarredForPicker(candidate, true);
		expect(await starred(file)).toBe(true);
		expect(await fs.readdir(sessionsRoot)).toEqual([legacyName]);
	});
});
