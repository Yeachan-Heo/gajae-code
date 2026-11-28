/**
 * Single-owner step 10a: every writer, root interactive session included, writes on the legacy
 * route in every ownership mode, whether or not it holds its session's claim. A writer it cannot
 * see (ownership off, an older binary) is caught by the managed transcript's identity fence: the
 * stopped writer keeps the other's entries.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { FileLockAcquireStatus, probeFileLock } from "@gajae-code/natives";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { ExtensionRunner } from "../../src/extensibility/extensions/runner";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { ManagedSessionDescendantStore } from "../../src/session/internal/managed-session-storage";
import { sessionClaimSetOf } from "../../src/session/internal/session-claim-set";
import { type SessionDestinationInput, SessionManager } from "../../src/session/session-manager";
import { resetSessionOwnershipForTests, SessionOwnershipTestHooks } from "../../src/session/session-ownership";
import type { SessionOwnershipMode } from "../../src/session/session-ownership-mode";
import { createAssistantMessage } from "../helpers/agent-session-setup";

const supported = process.platform === "linux" || process.platform === "darwin";
const roots: string[] = [];
const managers: SessionManager[] = [];
const sessions: AgentSession[] = [];
const stores: AuthStorage[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	try {
		// A session whose writes a peer's append stopped rethrows that refusal when it closes.
		for (const session of sessions.splice(0)) await session.dispose().catch(() => undefined);
		for (const store of stores.splice(0)) store.close();
		for (const manager of managers.splice(0)) await manager.close().catch(() => undefined);
		for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
	} finally {
		delete SessionOwnershipTestHooks.mode;
		delete SessionOwnershipTestHooks.lockBackend;
		resetSessionOwnershipForTests();
	}
});

async function workspace() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-root-legacy-route-")));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	return { root, cwd, managed: SessionManager.managedDestination(cwd, agentDir) };
}

/** A manager whose factory read `mode`, with its background claim settled. */
async function manager(cwd: string, destination: SessionDestinationInput, mode: SessionOwnershipMode) {
	const created = SessionManager.create(cwd, destination, undefined, { surface: "terminal", mode });
	managers.push(created);
	await sessionClaimSetOf(created).settled();
	return created;
}

/** An AgentSession on `sessionManager` whose model answers every turn with "ok". */
async function rootSession(sessionManager: SessionManager, root: string, extensionRunner?: ExtensionRunner) {
	const auth = await AuthStorage.create(path.join(root, `auth-${sessions.length}.db`));
	stores.push(auth);
	auth.setRuntimeApiKey("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Missing bundled model");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const message = { ...createAssistantMessage("ok"), timestamp: Date.now() };
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		}),
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false, "todo.reminders": false }),
		modelRegistry: new ModelRegistry(auth),
		extensionRunner,
	});
	sessions.push(session);
	return session;
}

/** Every claim attempt fails open with `status`, as on a platform without locks or a stalled lock. */
function failOpenLocks(status: FileLockAcquireStatus.Unavailable | FileLockAcquireStatus.TimedOut) {
	SessionOwnershipTestHooks.lockBackend = {
		tryAcquire: () => Promise.resolve({ status, code: status }),
		probe: probeFileLock,
	};
}

/** Every mode, and an enforce claim that failed open: none of them changes the write route. */
const ROUTES = [
	["off", undefined],
	["observe", undefined],
	["enforce", undefined],
	["enforce", FileLockAcquireStatus.Unavailable],
	["enforce", FileLockAcquireStatus.TimedOut],
] as const;

describe.skipIf(!supported)("the root session write route", () => {
	it("a shared bar latched by an older code path still wins in the funnel", async () => {
		const place = await workspace();
		SessionOwnershipTestHooks.mode = "enforce";
		const sessionManager = await manager(place.cwd, place.managed, "enforce");
		const session = await rootSession(sessionManager, place.root);
		expect(session.usesSharedControlPublication()).toBe(false);
		// A canonical shared append latches the append and rewrite bars for this manager's lifetime.
		const outcome = await sessionManager.appendMessageSharingSession({
			role: "user",
			content: "published shared",
			timestamp: Date.now(),
		});
		expect(outcome.kind).toBe("committed");
		expect(session.usesSharedControlPublication()).toBe(true);
	});

	it("enforce: a session_switch handler that writes during /resume lands on the switched-to session", async () => {
		const place = await workspace();
		SessionOwnershipTestHooks.mode = "enforce";
		// The /resume target: a committed session no one holds.
		const target = await manager(place.cwd, place.managed, "enforce");
		target.appendMessage({ role: "user", content: "target", timestamp: Date.now() });
		await target.ensureOnDisk();
		await target.flush();
		const targetFile = target.getSessionFile()!;
		await target.close();

		const sessionManager = await manager(place.cwd, place.managed, "enforce");
		const seen: boolean[] = [];
		let session: AgentSession | undefined;
		const extensionRunner = {
			hasHandlers: () => false,
			emit: async (event: { type: string }) => {
				if (event.type !== "session_switch" || !session) return;
				await session.appendCustomEntryForSession("switch-hook", { wrote: true });
				seen.push(session.usesSharedControlPublication());
			},
		} as unknown as ExtensionRunner;
		session = await rootSession(sessionManager, place.root, extensionRunner);
		// The picker's own admission of the target, held until its flow settles, as /resume does.
		const admission = await sessionManager.switchTargetAdmission(targetFile);
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice") notices.push(event.message);
		});
		expect(await session.switchSession(targetFile)).toBe(true);
		expect(notices).toEqual([]);
		// The rotation's own claim released the cover when it landed, before the hook wrote.
		expect(admission?.released).toBe(true);
		expect(seen).toEqual([false]);
		admission?.release();
		const [row] = (await sessionManager.listForResumePickerReadOnly()).filter(
			candidate => candidate.path === targetFile,
		);
		await sessionManager.setSessionStarredForPicker(row!, true);
		expect(sessionManager.isSessionStarred()).toBe(true);
		expect(await Bun.file(targetFile).text()).toContain('"customType":"switch-hook"');
	});
});

describe.skipIf(!supported)("a root session's controls after its first messages", () => {
	async function prompted(mode: SessionOwnershipMode, failOpen?: FileLockAcquireStatus) {
		const place = await workspace();
		SessionOwnershipTestHooks.mode = mode;
		if (failOpen === FileLockAcquireStatus.Unavailable || failOpen === FileLockAcquireStatus.TimedOut)
			failOpenLocks(failOpen);
		const sessionManager = await manager(place.cwd, place.managed, mode);
		const session = await rootSession(sessionManager, place.root);
		expect(session.usesSharedControlPublication()).toBe(false);
		await session.prompt("first prompt");
		await session.prompt("second prompt");
		await sessionManager.flush();
		const users = session.getUserMessagesForBranching();
		expect(users.map(user => user.text)).toEqual(["first prompt", "second prompt"]);
		return { sessionManager, session, users, file: sessionManager.getSessionFile()! };
	}

	it.each(ROUTES)("%s (fail-open: %s): star, rewrite, rewind and /fork all take effect", async (mode, failOpen) => {
		const { sessionManager, session, users, file } = await prompted(mode, failOpen);
		expect(sessionManager.requiresSharedMutationAdmission()).toBe(false);
		const [row] = await sessionManager.listForResumePickerReadOnly();
		await sessionManager.setSessionStarredForPicker(row!, true);
		expect(sessionManager.isSessionStarred()).toBe(true);
		await sessionManager.rewriteEntries();
		expect(await Bun.file(file).text()).toContain('"starred":true');
		// Rewind to before the second prompt (a branch switch in the same file).
		const secondParent = sessionManager.getEntry(users[1]!.entryId)?.parentId;
		const rewound = await session.navigateTree(users[1]!.entryId, { summarize: false });
		expect(rewound.cancelled).toBe(false);
		expect(sessionManager.getLeafId()).toBe(secondParent ?? null);
		// /fork from the first prompt: a new session whose parent is this one.
		const sourceId = sessionManager.getSessionId();
		const sourceFile = sessionManager.getSessionFile()!;
		const forked = await session.branch(users[0]!.entryId);
		expect(forked.cancelled).toBe(false);
		expect(sessionManager.getSessionId()).not.toBe(sourceId);
		// The direct route names the parent by its transcript path, as dev's legacy branch does.
		expect(sessionManager.getHeader()?.parentSession).toBe(sourceFile);
		expect(session.usesSharedControlPublication()).toBe(false);
	});

	/** A writer the holder cannot see (ownership off, an older binary) appends to the transcript. */
	async function peerAppends(file: string, text: string) {
		const peer = await SessionManager.open(file, undefined, undefined, undefined, undefined, "exempt");
		try {
			peer.appendMessage({ role: "user", content: text, timestamp: Date.now() });
			await peer.flush();
		} finally {
			await peer.close();
		}
	}

	it.each(
		ROUTES,
	)("%s (fail-open: %s): a peer's append stops the next turn; the transcript keeps it", async (mode, failOpen) => {
		const { sessionManager, session, file } = await prompted(mode, failOpen);
		await peerAppends(file, "peer entry");
		await session.prompt("holder after peer").catch(() => undefined);
		const mismatch = sessionManager.getAppendIdentityMismatch();
		expect(mismatch?.operatorMessage).toContain("Another process changed this session's transcript");
		const text = await Bun.file(file).text();
		expect(text).toContain("peer entry");
		expect(text).not.toContain("holder after peer");
	});

	it("a peer's append fails the next rewrite closed; the transcript keeps it", async () => {
		const { sessionManager, file } = await prompted("enforce");
		await peerAppends(file, "peer entry");
		const before = await Bun.file(file).text();
		await expect(sessionManager.rewriteEntries()).rejects.toThrow("managed_replace_identity_mismatch");
		// The refusal is latched: a star after it does not adopt the peer's bytes either.
		const [row] = await sessionManager.listForResumePickerReadOnly();
		await expect(sessionManager.setSessionStarredForPicker(row!, true)).rejects.toThrow(/identity_mismatch/);
		await expect(sessionManager.rewriteEntries()).rejects.toThrow(/identity_mismatch/);
		expect(await Bun.file(file).text()).toBe(before);
		expect(before).toContain("peer entry");
	});

	it("a rewrite adopts only its own bytes; an append right after it fails later writes closed", async () => {
		const { sessionManager, file } = await prompted("enforce");
		const foreign = `${JSON.stringify({ type: "custom", id: "foreign1", parentId: null, timestamp: new Date().toISOString(), customType: "foreign" })}\n`;
		const replace = ManagedSessionDescendantStore.prototype.replaceExpectedIdentitySync;
		vi.spyOn(ManagedSessionDescendantStore.prototype, "replaceExpectedIdentitySync").mockImplementationOnce(function (
			this: ManagedSessionDescendantStore,
			...args
		) {
			replace.apply(this, args);
			// Another writer appends between the replace and its read-back.
			fsSync.appendFileSync(file, foreign);
		});
		await expect(sessionManager.rewriteEntries()).rejects.toThrow("managed_append_identity_mismatch");
		await expect(sessionManager.rewriteEntries()).rejects.toThrow(/identity_mismatch/);
		expect(await Bun.file(file).text()).toContain('"customType":"foreign"');
	});

	it("Move Session refuses a transcript a peer appended to; nothing moves", async () => {
		const { sessionManager, file } = await prompted("enforce");
		await peerAppends(file, "peer entry");
		const before = await Bun.file(file).text();
		const target = path.join(path.dirname(sessionManager.getCwd()), "moved");
		await fs.mkdir(target, { recursive: true });
		await expect(sessionManager.moveTo(target)).rejects.toThrow("managed_append_identity_mismatch");
		expect(sessionManager.getCwd()).not.toBe(target);
		expect(await Bun.file(file).text()).toBe(before);
		expect(before).toContain("peer entry");
	});

	it("/drop refuses a transcript a peer appended to, before it switches; /drop works otherwise", async () => {
		const { sessionManager, session, file } = await prompted("enforce");
		await peerAppends(file, "peer entry");
		const sourceId = sessionManager.getSessionId();
		await expect(session.newSession({ drop: true })).rejects.toThrow("managed_append_identity_mismatch");
		expect(sessionManager.getSessionId()).toBe(sourceId);
		expect(await Bun.file(file).text()).toContain("peer entry");

		const other = await prompted("observe");
		await other.session.newSession({ drop: true });
		expect(other.sessionManager.getSessionId()).not.toBe(sourceId);
		expect(await Bun.file(other.file).exists()).toBe(false);
	});
});
