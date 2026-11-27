/**
 * Single-owner step 9 (design §13 M3): a root interactive session whose manager is the only writer
 * of its session, claimed under enforce, writes on the legacy route instead of shared publication.
 * The truth table of `SessionManager.isSoleOwnerRoute()` and the AgentSession funnel it feeds.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { FileLockAcquireStatus, probeFileLock } from "@gajae-code/natives";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { sessionClaimSetOf } from "../../src/session/internal/session-claim-set";
import { type SessionDestinationInput, SessionManager } from "../../src/session/session-manager";
import {
	claimSessionOwner,
	resetSessionOwnershipForTests,
	type SessionOwnerClaim,
	SessionOwnershipTestHooks,
} from "../../src/session/session-ownership";
import type { SessionOwnershipMode } from "../../src/session/session-ownership-mode";
import { createAssistantMessage } from "../helpers/agent-session-setup";

const supported = process.platform === "linux" || process.platform === "darwin";
const roots: string[] = [];
const managers: SessionManager[] = [];
const sessions: AgentSession[] = [];
const stores: AuthStorage[] = [];
const extraClaims: SessionOwnerClaim[] = [];

afterEach(async () => {
	try {
		// A session whose writes a peer's append stopped rethrows that refusal when it closes.
		for (const session of sessions.splice(0)) await session.dispose().catch(() => undefined);
		for (const store of stores.splice(0)) store.close();
		for (const claim of extraClaims.splice(0)) claim.release();
		for (const manager of managers.splice(0)) await manager.close().catch(() => undefined);
		for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
	} finally {
		delete SessionOwnershipTestHooks.mode;
		delete SessionOwnershipTestHooks.lockBackend;
		resetSessionOwnershipForTests();
	}
});

async function workspace() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sole-owner-route-")));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	return {
		root,
		cwd,
		managed: SessionManager.managedDestination(cwd, agentDir),
		explicit: path.join(root, "explicit"),
	};
}

/** A manager whose factory read `mode`, with its background claim settled. */
async function manager(cwd: string, destination: SessionDestinationInput, mode: SessionOwnershipMode) {
	const created = SessionManager.create(cwd, destination, undefined, { surface: "terminal", mode });
	managers.push(created);
	await sessionClaimSetOf(created).settled();
	return created;
}

/** A root (or plain) AgentSession on `sessionManager` whose model answers every turn with "ok". */
async function rootSession(sessionManager: SessionManager, root: string, rootInteractiveSharedAppend = true) {
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
		rootInteractiveSharedAppend,
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

describe.skipIf(!supported)("isSoleOwnerRoute", () => {
	it.each([
		"off",
		"observe",
	] as const)("%s: never the sole-owner route; a root session publishes shared", async mode => {
		const place = await workspace();
		SessionOwnershipTestHooks.mode = mode;
		const sessionManager = await manager(place.cwd, place.managed, mode);
		expect(sessionManager.isSoleOwnerRoute()).toBe(false);
		expect((await rootSession(sessionManager, place.root)).usesSharedControlPublication()).toBe(true);
	});

	it("enforce, claimed, sole holder: the sole-owner route; a root session takes the legacy route", async () => {
		const place = await workspace();
		SessionOwnershipTestHooks.mode = "enforce";
		const sessionManager = await manager(place.cwd, place.managed, "enforce");
		expect(sessionClaimSetOf(sessionManager).has(sessionManager.getSessionId())).toBe(true);
		expect(sessionManager.isSoleOwnerRoute()).toBe(true);
		expect((await rootSession(sessionManager, place.root)).usesSharedControlPublication()).toBe(false);
	});

	it("enforce, claim in flight: shared without deciding, then the sole-owner route once it lands", async () => {
		const place = await workspace();
		SessionOwnershipTestHooks.mode = "enforce";
		const created = SessionManager.create(place.cwd, place.managed, undefined, {
			surface: "terminal",
			mode: "enforce",
		});
		managers.push(created);
		expect(created.isSoleOwnerRoute()).toBe(false);
		await sessionClaimSetOf(created).settled();
		expect(created.isSoleOwnerRoute()).toBe(true);
	});

	it.each([
		FileLockAcquireStatus.Unavailable,
		FileLockAcquireStatus.TimedOut,
	] as const)("enforce, claim failed open (%s): shared", async status => {
		const place = await workspace();
		SessionOwnershipTestHooks.mode = "enforce";
		failOpenLocks(status);
		const sessionManager = await manager(place.cwd, place.managed, "enforce");
		expect(await sessionClaimSetOf(sessionManager).settled()).toBe("none");
		expect(sessionManager.isSoleOwnerRoute()).toBe(false);
		expect((await rootSession(sessionManager, place.root)).usesSharedControlPublication()).toBe(true);
	});

	it("enforce, a second holder in this process: shared until it releases, then sticky", async () => {
		const place = await workspace();
		SessionOwnershipTestHooks.mode = "enforce";
		const sessionManager = await manager(place.cwd, place.managed, "enforce");
		const second = await claimSessionOwner(sessionManager.getSessionId(), { surface: "sdk-host" });
		if (second.status !== "claimed") throw new Error(`expected a shared claim, got ${second.status}`);
		expect(second.claim.shared).toBe(true);
		expect(second.claim.holders).toBe(2);
		expect(sessionManager.isSoleOwnerRoute()).toBe(false);
		second.claim.release();
		expect(sessionManager.isSoleOwnerRoute()).toBe(true);
		// Once decided, a later second holder does not switch the running session's write path.
		const later = await claimSessionOwner(sessionManager.getSessionId(), { surface: "sdk-host" });
		if (later.status !== "claimed") throw new Error(`expected a shared claim, got ${later.status}`);
		extraClaims.push(later.claim);
		expect(sessionManager.isSoleOwnerRoute()).toBe(true);
	});

	it("enforce, the live mode lowered before the first decision: shared", async () => {
		const place = await workspace();
		SessionOwnershipTestHooks.mode = "enforce";
		const sessionManager = await manager(place.cwd, place.managed, "enforce");
		SessionOwnershipTestHooks.mode = "observe";
		expect(sessionManager.isSoleOwnerRoute()).toBe(false);
		SessionOwnershipTestHooks.mode = "enforce";
		expect(sessionManager.isSoleOwnerRoute()).toBe(true);
		SessionOwnershipTestHooks.mode = "observe";
		expect(sessionManager.isSoleOwnerRoute()).toBe(true);
	});

	it("enforce, a shared bar latched before the first decision: shared, and the bar wins in the funnel", async () => {
		const place = await workspace();
		SessionOwnershipTestHooks.mode = "enforce";
		const sessionManager = await manager(place.cwd, place.managed, "enforce");
		// A canonical shared append latches the append and rewrite bars for this manager's lifetime.
		const outcome = await sessionManager.appendMessageSharingSession({
			role: "user",
			content: "published shared",
			timestamp: Date.now(),
		});
		expect(outcome.kind).toBe("committed");
		expect(sessionManager.requiresSharedMutationAdmission()).toBe(true);
		expect(sessionManager.isSoleOwnerRoute()).toBe(false);
		expect((await rootSession(sessionManager, place.root)).usesSharedControlPublication()).toBe(true);
	});

	it("enforce, an explicit destination: never the sole-owner route; the funnel stays legacy", async () => {
		const place = await workspace();
		SessionOwnershipTestHooks.mode = "enforce";
		await fs.mkdir(place.explicit, { recursive: true, mode: 0o700 });
		const sessionManager = await manager(place.cwd, SessionManager.explicitDestination(place.explicit), "enforce");
		expect(sessionManager.isSoleOwnerRoute()).toBe(false);
		expect((await rootSession(sessionManager, place.root)).usesSharedControlPublication()).toBe(false);
	});

	it("enforce, a non-root session: legacy route either way", async () => {
		const place = await workspace();
		SessionOwnershipTestHooks.mode = "observe";
		const observed = await manager(place.cwd, place.managed, "observe");
		expect((await rootSession(observed, place.root, false)).usesSharedControlPublication()).toBe(false);
		SessionOwnershipTestHooks.mode = "enforce";
		const enforced = await manager(place.cwd, place.managed, "enforce");
		expect((await rootSession(enforced, place.root, false)).usesSharedControlPublication()).toBe(false);
	});

	it("enforce: a new id is decided again; a rotation keeps the sole-owner route for the successor", async () => {
		const place = await workspace();
		SessionOwnershipTestHooks.mode = "enforce";
		const sessionManager = await manager(place.cwd, place.managed, "enforce");
		sessionManager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
		await sessionManager.ensureOnDisk();
		expect(sessionManager.isSoleOwnerRoute()).toBe(true);
		const previous = sessionManager.getSessionId();
		await sessionManager.newSession();
		expect(sessionManager.getSessionId()).not.toBe(previous);
		await sessionClaimSetOf(sessionManager).settled();
		expect(sessionManager.isSoleOwnerRoute()).toBe(true);
	});
});

describe.skipIf(!supported)("a root session's controls after its first messages", () => {
	async function prompted(mode: SessionOwnershipMode, failOpen?: FileLockAcquireStatus.Unavailable) {
		const place = await workspace();
		SessionOwnershipTestHooks.mode = mode;
		if (failOpen) failOpenLocks(failOpen);
		const sessionManager = await manager(place.cwd, place.managed, mode);
		const session = await rootSession(sessionManager, place.root);
		await session.prompt("first prompt");
		await session.prompt("second prompt");
		await sessionManager.flush();
		const users = session.getUserMessagesForBranching();
		expect(users.map(user => user.text)).toEqual(["first prompt", "second prompt"]);
		return { sessionManager, session, users, file: sessionManager.getSessionFile()! };
	}

	it("enforce, sole owner: star, rewrite, rewind and /fork all take effect", async () => {
		const { sessionManager, session, users, file } = await prompted("enforce");
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
		const forked = await session.branch(users[0]!.entryId);
		expect(forked.cancelled).toBe(false);
		expect(sessionManager.getSessionId()).not.toBe(sourceId);
		expect(sessionManager.getHeader()?.parentSession).toBe(sourceId);
		await sessionClaimSetOf(sessionManager).settled();
		expect(sessionManager.isSoleOwnerRoute()).toBe(true);
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

	it("enforce, sole owner: a peer's append stops the holder's next turn; the transcript keeps it", async () => {
		const { sessionManager, session, file } = await prompted("enforce");
		await peerAppends(file, "peer entry");
		await session.prompt("holder after peer").catch(() => undefined);
		const mismatch = sessionManager.getAppendIdentityMismatch();
		expect(mismatch?.operatorMessage).toContain("Another process changed this session's transcript");
		const text = await Bun.file(file).text();
		expect(text).toContain("peer entry");
		expect(text).not.toContain("holder after peer");
	});

	it("enforce, sole owner: a peer's append fails the holder's next rewrite closed; the transcript keeps it", async () => {
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

	it("enforce, sole owner: /drop refuses a transcript a peer appended to, before it switches; /drop works otherwise", async () => {
		const { sessionManager, session, file } = await prompted("enforce");
		await peerAppends(file, "peer entry");
		const sourceId = sessionManager.getSessionId();
		await expect(session.newSession({ drop: true })).rejects.toThrow("managed_append_identity_mismatch");
		expect(sessionManager.getSessionId()).toBe(sourceId);
		expect(await Bun.file(file).text()).toContain("peer entry");

		const other = await prompted("enforce");
		await other.session.newSession({ drop: true });
		expect(other.sessionManager.getSessionId()).not.toBe(sourceId);
		expect(await Bun.file(other.file).exists()).toBe(false);
	});

	it.each([
		["observe", undefined],
		["enforce", FileLockAcquireStatus.Unavailable],
	] as const)("%s (fail-open: %s): the shared bars refuse star and rewrite before any effect", async (mode, failOpen) => {
		const { sessionManager, file } = await prompted(mode, failOpen);
		expect(sessionManager.requiresSharedMutationAdmission()).toBe(true);
		const before = await Bun.file(file).text();
		const [row] = await sessionManager.listForResumePickerReadOnly();
		await expect(sessionManager.setSessionStarredForPicker(row!, true)).rejects.toThrow(
			"requires transaction admission",
		);
		await expect(sessionManager.rewriteEntries()).rejects.toThrow("requires transaction admission");
		expect(sessionManager.isSessionStarred()).toBe(false);
		expect(await Bun.file(file).text()).toBe(before);
	});
});
