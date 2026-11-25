/**
 * Runtime writer inventory of SessionManager's static methods: its factories, open paths and
 * picker helpers (single-owner design §12, before G1). The prototype methods are inventoried in
 * `session-ownership-writer-inventory.test.ts`.
 *
 * Every own property of the SessionManager constructor is classified. Each writer then runs
 * against real transcripts with ownership `observe` and no claim, in each scenario that reaches a
 * different write path. Every transcript it changes must have been reported under that
 * transcript's own session id, and no detector call may go unanswered for want of a bound id
 * (a factory writes before its manager binds). In `off`, with the strict seam on, the same
 * scenarios count and log nothing. Writers a later step covers are listed with that step.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { RecoveryFsRoot } from "@gajae-code/natives";
import { logger } from "@gajae-code/utils";
import { ManagedSessionDescendantStore } from "../../src/session/internal/managed-session-storage";
import { SessionClaimSet } from "../../src/session/internal/session-claim-set";
import type { MemoryGuardSessionManagerCheckpointV1 } from "../../src/session/memory-guard-checkpoint-participant";
import { type SessionDestination, SessionManager, SessionManagerTestHooks } from "../../src/session/session-manager";
import {
	resetSessionOwnershipForTests,
	SessionOwnershipTestHooks,
	sessionOwnershipCounters,
} from "../../src/session/session-ownership";
import { isStagedSessionPath } from "../../src/session/session-staging-paths";
import { FileSessionStorage } from "../../src/session/session-storage";

const supported = process.platform === "linux" || process.platform === "darwin";
const roots: string[] = [];
const managers: SessionManager[] = [];
let detectorLogs: { site: string; sessionId: string }[] = [];
/** Detector calls that had no id to check: silent, so a write behind them goes unreported. */
let unbound: string[] = [];

beforeEach(() => {
	SessionOwnershipTestHooks.mode = "observe";
	detectorLogs = [];
	unbound = [];
	const checkWrite = SessionClaimSet.prototype.checkWrite;
	vi.spyOn(SessionClaimSet.prototype, "checkWrite").mockImplementation(function (
		this: SessionClaimSet,
		site: string,
		sessionId?: string,
	) {
		if ((sessionId ?? this.currentSessionId) === undefined) unbound.push(site);
		return checkWrite.call(this, site, sessionId);
	});
	vi.spyOn(logger, "warn").mockImplementation((message, context) => {
		if (message === "session_write_without_claim") detectorLogs.push(context as never);
	});
});

afterEach(async () => {
	try {
		for (const manager of managers.splice(0)) await manager.close().catch(() => undefined);
		for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
	} finally {
		delete SessionOwnershipTestHooks.mode;
		delete SessionOwnershipTestHooks.strictWriteDetection;
		delete SessionManagerTestHooks.eagerHydrationMaxBytesOverride;
		vi.restoreAllMocks();
		resetSessionOwnershipForTests();
	}
});

type Kind = "managed" | "explicit";

interface Fixture {
	readonly root: string;
	readonly cwd: string;
	readonly agentDir: string;
	readonly kind: Kind;
	/** The destination new sessions of this kind go to. */
	destination(): SessionDestination;
	/** A committed session with a completed turn, so it can be continued. */
	readonly existing: string;
	/** A transcript path in the destination directory that does not exist yet. */
	readonly missing: string;
	/** A committed session whose assistant reply carries stale replay metadata an open sanitizes. */
	readonly stale: string;
	/** A committed session with a compaction, which the bounded fork paths require. */
	readonly compacted: string;
}

function user(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

function assistant(text: string) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	} as never;
}

/** An assistant reply carrying OpenAI Responses replay state that a load sanitizes. */
function staleReply() {
	return {
		...(assistant("answer") as object),
		content: [
			{ type: "thinking", thinking: "reasoning", thinkingSignature: "stale-signature" },
			{ type: "text", text: "answer" },
		],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-fixture",
		providerPayload: { type: "openaiResponsesHistory", items: [] },
	} as never;
}

async function committed(
	cwd: string,
	destination: Fixture["destination"],
	reply: never,
	compacted = false,
): Promise<string> {
	const manager = SessionManager.create(cwd, destination());
	const first = manager.appendMessage(user("question"));
	manager.appendMessage(reply);
	if (compacted) {
		manager.appendCompaction("summary", undefined, first, 1);
		manager.appendMessage(user("after"));
		manager.appendMessage(assistant("again"));
	}
	await manager.ensureOnDisk();
	await manager.flush();
	const file = manager.getSessionFile()!;
	await manager.close();
	return file;
}

async function fixture(kind: Kind): Promise<Fixture> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-static-inventory-")));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = () =>
		kind === "managed"
			? SessionManager.managedDestination(cwd, agentDir)
			: SessionManager.explicitDestination(path.join(root, "sessions"));
	// The fixture's own writes happen before measuring, in off.
	SessionOwnershipTestHooks.mode = "off";
	const stale = await committed(cwd, destination, staleReply());
	const compacted = await committed(cwd, destination, assistant("answer"), true);
	// Created last, so it is the most recent session.
	const existing = await committed(cwd, destination, assistant("answer"));
	SessionOwnershipTestHooks.mode = "observe";
	return {
		root,
		cwd,
		agentDir,
		kind,
		destination,
		existing,
		stale,
		compacted,
		missing: path.join(path.dirname(existing), "2026-01-01T00-00-00-000Z_missing.jsonl"),
	};
}

async function transcripts(directory: string): Promise<Map<string, string>> {
	const found = new Map<string, string>();
	for (const name of await fs.readdir(directory, { recursive: true }).catch(() => [] as string[])) {
		if (!name.endsWith(".jsonl")) continue;
		found.set(name, await fs.readFile(path.join(directory, name), "utf8"));
	}
	return found;
}

/** Session ids of the transcripts whose bytes differ, from their headers. */
function changedSessions(before: Map<string, string>, after: Map<string, string>): string[] {
	return [...new Set([...before.keys(), ...after.keys()])]
		.filter(name => before.get(name) !== after.get(name))
		.map(name => (JSON.parse((after.get(name) ?? before.get(name)!).split("\n")[0]!) as { id: string }).id);
}

type Run = (f: Fixture) => Promise<unknown>;

/** Keep a returned manager for cleanup, whatever shape the factory returns it in. */
function keep(result: unknown): unknown {
	if (result instanceof SessionManager) managers.push(result);
	else if (result && typeof result === "object" && "manager" in result && result.manager instanceof SessionManager)
		managers.push(result.manager);
	return result;
}

/** Run a static method and report what it wrote and what the detector saw. */
async function attribute(kind: Kind, run: Run) {
	const f = await fixture(kind);
	const before = await transcripts(f.root);
	const detectedBefore = sessionOwnershipCounters().session_write_without_claim;
	detectorLogs = [];
	unbound = [];
	let error: unknown;
	try {
		keep(await run(f));
	} catch (caught) {
		error = caught;
	}
	// Close may pay rewrite debt an open left behind.
	for (const manager of managers.splice(0)) await manager.close().catch(() => undefined);
	const touched = changedSessions(before, await transcripts(f.root));
	const reported = new Set(detectorLogs.map(log => log.sessionId));
	return {
		touched,
		error,
		detected: sessionOwnershipCounters().session_write_without_claim - detectedBefore,
		/** Changed transcripts whose session id the detector never reported. */
		unreported: touched.filter(id => !reported.has(id)),
		unbound: [...unbound],
	};
}

const identity = (file: string) => {
	const capture = SessionManager.captureTranscriptStrict(file);
	if (capture.kind !== "captured") throw new Error(`capture failed: ${capture.reason}`);
	const { identity: captured } = capture.snapshot;
	capture.snapshot.close();
	return captured;
};

/** Take the bounded (session-memory) open and fork paths, which a small transcript otherwise skips. */
async function bounded<T>(run: () => Promise<T>): Promise<T> {
	SessionManagerTestHooks.eagerHydrationMaxBytesOverride = 1;
	try {
		return await run();
	} finally {
		delete SessionManagerTestHooks.eagerHydrationMaxBytesOverride;
	}
}

async function forkCaptured(source: string, f: Fixture, sessionMemoryMode?: "enabled") {
	const capture = SessionManager.captureTranscriptStrict(source);
	if (capture.kind !== "captured") throw new Error(`capture failed: ${capture.reason}`);
	try {
		return await SessionManager.forkFromCaptured(
			capture.snapshot,
			f.cwd,
			f.destination(),
			undefined,
			sessionMemoryMode,
		);
	} finally {
		capture.snapshot.close();
	}
}

/** Each scenario reaches a different write path of a writer. Run unclaimed, each write must be detected. */
const CHECKED_WRITERS: Record<string, Record<string, Run>> = {
	open: {
		existing: f => SessionManager.open(f.existing, f.destination()),
		"existing, stale replay metadata": f => SessionManager.open(f.stale, f.destination()),
		"existing, session memory enabled": f =>
			SessionManager.open(f.existing, f.destination(), undefined, undefined, "enabled"),
		"existing, bounded": f =>
			bounded(() => SessionManager.open(f.stale, f.destination(), undefined, undefined, "enabled")),
		missing: f => SessionManager.open(f.missing, f.destination()),
		"missing, session memory enabled": f =>
			SessionManager.open(f.missing, f.destination(), undefined, undefined, "enabled"),
	},
	openExistingStrict: {
		existing: async f => await SessionManager.openExistingStrict(identity(f.existing), f.destination()),
		"existing, stale replay metadata": async f =>
			SessionManager.openExistingStrict(identity(f.stale), f.destination()),
		"existing, session memory enabled": async f =>
			SessionManager.openExistingStrict(identity(f.existing), f.destination(), undefined, undefined, "enabled"),
		"existing, bounded": f =>
			bounded(() =>
				SessionManager.openExistingStrict(identity(f.stale), f.destination(), undefined, undefined, "enabled"),
			),
	},
	continueRecent: {
		existing: f => SessionManager.continueRecent(f.cwd, f.destination()),
		"existing, session memory enabled": f =>
			SessionManager.continueRecent(f.cwd, f.destination(), undefined, undefined, "enabled"),
		"existing, bounded": f =>
			bounded(() => SessionManager.continueRecent(f.cwd, f.destination(), undefined, undefined, "enabled")),
	},
	forkFrom: {
		existing: f => SessionManager.forkFrom(f.existing, f.cwd, f.destination()),
		"existing, session memory enabled": f =>
			SessionManager.forkFrom(f.existing, f.cwd, f.destination(), undefined, undefined, "enabled"),
		"existing, stale replay metadata": f => SessionManager.forkFrom(f.stale, f.cwd, f.destination()),
		"compacted, session memory enabled": f =>
			SessionManager.forkFrom(f.compacted, f.cwd, f.destination(), undefined, undefined, "enabled"),
	},
	forkFromCaptured: {
		existing: f => forkCaptured(f.existing, f),
		"compacted, session memory enabled": f => forkCaptured(f.compacted, f, "enabled"),
	},
};

/** Methods that write no transcript bytes. Each runs, and must leave every transcript unchanged. */
const NOT_TRANSCRIPT_WRITERS: Record<string, Run> = {
	nestedManagedDestination: async f => {
		const parent = SessionManager.managedDestination(f.cwd, f.agentDir);
		if (parent.kind !== "managed") throw new Error("expected a managed destination");
		const child = path.join(parent.directory, "child");
		await fs.mkdir(child, { mode: 0o700 });
		return SessionManager.nestedManagedDestination(parent.securityContext.rootAuthority, child);
	},
	openNoFollowDirectory: async f => (await SessionManager.openNoFollowDirectory(f.cwd)).close(),
	claimProcessCwdOwnership: async f => {
		const manager = keep(SessionManager.create(f.cwd, f.destination())) as SessionManager;
		SessionManager.claimProcessCwdOwnership(manager);
		SessionManager.releaseProcessCwdOwnership(manager);
	},
	isProcessCwdOwner: async f => SessionManager.isProcessCwdOwner(keep(SessionManager.create(f.cwd)) as SessionManager),
	releaseProcessCwdOwnership: async f =>
		SessionManager.releaseProcessCwdOwnership(keep(SessionManager.create(f.cwd)) as SessionManager),
	assertProcessCwdIdentity: async f => {
		const { dev, ino } = await fs.stat(f.cwd, { bigint: true });
		await SessionManager.assertProcessCwdIdentity({ dev, ino }).catch(() => undefined);
	},
	getDefaultSessionDir: async f => SessionManager.getDefaultSessionDir(f.cwd, f.agentDir),
	getDefaultSessionDirReadOnly: async f => SessionManager.getDefaultSessionDirReadOnly(f.cwd, f.agentDir),
	managedDestination: async f => SessionManager.managedDestination(f.cwd, f.agentDir),
	explicitDestination: async f => SessionManager.explicitDestination(path.join(f.root, "elsewhere")),
	create: async f => SessionManager.create(f.cwd, f.destination()),
	// Persists nothing, not even the sanitize of stale replay metadata: the promotion that follows
	// writes, and is checked (the prototype inventory's recovery promotion cases).
	openExistingForRecoveryHydrationStrict: f =>
		SessionManager.openExistingForRecoveryHydrationStrict(identity(f.stale), f.destination()),
	inMemory: async f => SessionManager.inMemory(f.cwd),
	captureTranscriptStrict: async f => identity(f.existing),
	inspectSessionTailReadOnly: f => SessionManager.inspectSessionTailReadOnly(f.existing),
	openReadOnlySnapshot: f => SessionManager.openReadOnlySnapshot(f.existing),
	readSessionRecapReadOnly: async f => {
		const stat = await fs.stat(f.existing, { bigint: true });
		const { dev, ino, nlink, mtimeNs, ctimeNs } = stat;
		return SessionManager.readSessionRecapReadOnly(f.existing, {
			dev,
			ino,
			nlink,
			size: Number(stat.size),
			mtimeNs,
			ctimeNs,
		} as never);
	},
	listManagedForResumePickerReadOnly: f => SessionManager.listManagedForResumePickerReadOnly(f.cwd, f.agentDir),
	listForResumePickerReadOnly: f => SessionManager.listForResumePickerReadOnly(f.cwd, path.dirname(f.existing)),
	list: f => SessionManager.list(f.cwd, path.dirname(f.existing)),
	listAll: f => SessionManager.listAll(undefined, f.agentDir),
	inventorySessionsStrict: async f =>
		SessionManager.inventorySessionsStrict(f.cwd, { sessionDir: path.dirname(f.existing) }),
};

/** Writers this step does not cover; the step named in each reason does. Not run here. */
const DEFERRED_WRITERS: Record<string, string> = {
	setSessionStarredForPicker: "picker write of any session; scoped claims cover picker writes (4d)",
	deleteManagedCandidate: "deletes a session; delete ownership is the scoped-claim step (4d)",
	prepareManagedCandidateForWrite:
		"open-time migration of a candidate from a legacy directory, before any manager exists. Open and continueRecent claim the candidate first (4b); forkFrom's migration of its source is pending a design decision (a scoped claim of the source when free, reading it in place when held)",
	openNestedManaged: "a child session under its parent's store; children claim their own ids (4b class rules)",
	stagedNestedManaged: "a staged child; staged sessions claim at commit (4b)",
	openStagedNestedManaged: "a staged child; staged sessions claim at commit (4b)",
};

/** A memory-guard checkpoint of `source`, taken outside the measured tree. */
async function checkpointOf(source: string) {
	const checkpointRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-static-checkpoint-")));
	roots.push(checkpointRoot);
	const manager = await SessionManager.open(source);
	const ingressLease = manager.acquireMemoryGuardParticipantIngressLease();
	let checkpoint: MemoryGuardSessionManagerCheckpointV1;
	try {
		checkpoint = await manager.createMemoryGuardCheckpoint({ ingressLease, checkpointRoot });
	} finally {
		ingressLease.release();
		await manager.close();
	}
	const { blob_authority, revisions, session_id, session_name, transcript } = checkpoint;
	const incidentAuthority = {
		readManaged(relativePath: string) {
			try {
				return { ok: true, data: new Uint8Array(fsSync.readFileSync(path.join(checkpointRoot, relativePath))) };
			} catch {
				return { ok: false };
			}
		},
	} as RecoveryFsRoot;
	const participant = { ordinal: 0, checkpoint: blob_authority, revisions, session_id, session_name, transcript };
	return { incidentAuthority, participant, checkpoint };
}

/**
 * Writers that write only a staged transcript at a name no resume or listing picks up; the step
 * that publishes it is checked or deferred as named. Each runs, and every transcript it changes
 * (measured before close, which may discard it) must be such a staged one.
 */
const STAGED_WRITERS: Record<string, { readonly reason: string; readonly run: Run }> = {
	openStaged: {
		reason: "an unpublished staged child below .staging; staged sessions claim at commit (4b)",
		run: f => SessionManager.openStaged(f.missing),
	},
	restoreMemoryGuardCheckpoint: {
		reason:
			"a hidden recovery transcript, written before any manager exists; the promotion that publishes it is checked (recovery promotion)",
		run: async f =>
			SessionManager.restoreMemoryGuardCheckpoint({
				...(await checkpointOf(f.existing)),
				destination: f.destination(),
			}),
	},
};

const CLASSIFICATIONS: readonly object[] = [CHECKED_WRITERS, NOT_TRANSCRIPT_WRITERS, DEFERRED_WRITERS, STAGED_WRITERS];

function staticMethods(): string[] {
	return Object.getOwnPropertyNames(SessionManager).filter(
		name => typeof (SessionManager as unknown as Record<string, unknown>)[name] === "function",
	);
}

describe.if(supported)("session ownership static writer inventory", () => {
	it("classifies every static SessionManager method", () => {
		const methods = staticMethods();
		expect(methods.filter(name => !CLASSIFICATIONS.some(list => name in list))).toEqual([]);
		const listed = CLASSIFICATIONS.flatMap(list => Object.keys(list));
		expect(listed.filter(name => !methods.includes(name))).toEqual([]);
		expect(listed.length).toBe(new Set(listed).size);
	});

	const wrote = new Set<string>();
	for (const [name, scenarios] of Object.entries(CHECKED_WRITERS)) {
		for (const [scenario, run] of Object.entries(scenarios)) {
			for (const kind of ["managed", "explicit"] as const) {
				it(`${name} (${scenario}, ${kind}): every transcript write without a claim is detected`, async () => {
					const result = await attribute(kind, run);
					expect(result.error).toBeUndefined();
					expect(result.unreported).toEqual([]);
					expect(result.unbound).toEqual([]);
					if (result.touched.length > 0) {
						wrote.add(name);
						expect(result.detected).toBeGreaterThan(0);
					}
				});

				it(`${name} (${scenario}, ${kind}): in off, nothing is counted or logged, even under the strict seam`, async () => {
					const result = await attribute(kind, async f => {
						SessionOwnershipTestHooks.mode = "off";
						SessionOwnershipTestHooks.strictWriteDetection = true;
						return run(f);
					});
					expect(result.error).toBeUndefined();
					expect([result.detected, detectorLogs]).toEqual([0, []]);
				});
			}
		}
	}

	for (const [name, run] of Object.entries(NOT_TRANSCRIPT_WRITERS)) {
		it(`${name}: writes no transcript bytes`, async () => {
			for (const kind of ["managed", "explicit"] as const) {
				const result = await attribute(kind, run);
				expect([kind, result.touched, result.error]).toEqual([kind, [], undefined]);
			}
		});
	}

	for (const [name, { run }] of Object.entries(STAGED_WRITERS)) {
		it(`${name}: writes only a staged transcript`, async () => {
			for (const kind of ["managed", "explicit"] as const) {
				const f = await fixture(kind);
				const before = await transcripts(f.root);
				keep(await run(f));
				const after = await transcripts(f.root);
				const changed = [...after.keys()].filter(name => before.get(name) !== after.get(name));
				// Something was written, nothing that existed changed, and only at a staged name.
				expect([
					kind,
					changed.length > 0,
					[...before.keys()].every(name => after.get(name) === before.get(name)),
				]).toEqual([kind, true, true]);
				const staged = (name: string) =>
					isStagedSessionPath(path.join(f.root, name)) || path.basename(name).startsWith(".");
				expect([kind, changed.filter(name => !staged(name))]).toEqual([kind, []]);
			}
		});
	}

	describe("under the strict seam, each factory publish is refused before it writes", () => {
		/**
		 * Record every publish of a transcript, as it happens: the end state alone cannot tell a
		 * refusal before the publish from a publish its failure cleanup later deleted.
		 */
		function spyOnPublishes(): string[] {
			const published: string[] = [];
			const record = (primitive: string, target: unknown) => {
				if (typeof target === "string" && target.endsWith(".jsonl"))
					published.push(`${primitive} ${path.basename(target)}`);
			};
			const storage = FileSessionStorage.prototype;
			const openStagedWriter = storage.openStagedWriter;
			vi.spyOn(storage, "openStagedWriter").mockImplementation(function (this: FileSessionStorage, ...args) {
				const writer = openStagedWriter.apply(this, args);
				const publish = writer.publishNoReplace.bind(writer);
				writer.publishNoReplace = () => {
					record("stagedPublish", args[0]);
					publish();
				};
				return writer;
			});
			for (const name of ["renameSync", "rename", "writeTextSync", "writeText"] as const) {
				const original = storage[name] as (...args: never[]) => unknown;
				const at = name.startsWith("rename") ? 1 : 0;
				vi.spyOn(storage, name).mockImplementation(function (this: FileSessionStorage, ...args: never[]) {
					record(name, args[at]);
					return original.apply(this, args);
				} as never);
			}
			const store = ManagedSessionDescendantStore.prototype;
			for (const name of [
				"publishNoReplace",
				"publishNoReplaceSync",
				"replaceSync",
				"replaceExpectedIdentitySync",
			] as const) {
				const original = store[name] as (...args: never[]) => unknown;
				vi.spyOn(store, name).mockImplementation(function (this: ManagedSessionDescendantStore, ...args: never[]) {
					record(`store.${name}`, args[0]);
					return original.apply(this, args);
				} as never);
			}
			return published;
		}

		const publishes: Record<string, { readonly run: Run; readonly site: Record<Kind, string> }> = {
			"open of a missing transcript": {
				run: f => SessionManager.open(f.missing, f.destination()),
				// An explicit missing open writes its header through the rewrite funnel.
				site: { managed: "open create", explicit: "rewrite" },
			},
			"bounded forkFrom": {
				run: f => SessionManager.forkFrom(f.compacted, f.cwd, f.destination(), undefined, undefined, "enabled"),
				site: { managed: "fork successor", explicit: "fork successor" },
			},
			"bounded forkFromCaptured": {
				run: f => forkCaptured(f.compacted, f, "enabled"),
				site: { managed: "fork successor", explicit: "fork successor" },
			},
		};
		for (const [name, { run, site }] of Object.entries(publishes)) {
			for (const kind of ["managed", "explicit"] as const) {
				it(`${name} (${kind})`, async () => {
					const f = await fixture(kind);
					const before = await transcripts(f.root);
					const published = spyOnPublishes();
					SessionOwnershipTestHooks.strictWriteDetection = true;
					await expect(run(f).then(keep)).rejects.toMatchObject({
						name: "SessionWriteWithoutClaimError",
						site: site[kind],
					});
					expect(published).toEqual([]);
					expect(await transcripts(f.root)).toEqual(before);
				});
			}
		}
	});

	it("each checked writer wrote in at least one scenario", () => {
		expect(Object.keys(CHECKED_WRITERS).filter(name => !wrote.has(name))).toEqual([]);
	});
});
