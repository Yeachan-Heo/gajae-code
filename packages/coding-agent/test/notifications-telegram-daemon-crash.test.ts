/**
 * Telegram topic-deletion crash-durability matrix (PR #2173 replacement proof).
 *
 * These tests prove, on the PRODUCTION daemon path and against a hard SIGKILL,
 * the persistence ordering of the per-session Telegram forum-topic deletion:
 *
 *   (1) durable deletion-journal claim  ──▶  provider `deleteForumTopic`
 *   (2) provider terminal receipt       ──▶  topic-registry cleanup
 *   (3) topic-registry cleanup          ──▶  roots compaction
 *   (4) roots compaction                ──▶  reconciled journal receipt
 *   (5) endpoint publication identity (canonicalRoot + leaseId) durability
 *
 * Each test spawns the SAME test file as an isolated child (`bun <this-file>
 * --child <phase> <agentDir> <baseNow>`), drives the production daemon to the
 * named cut point, writes a barrier file, and blocks. The parent observes the
 * barrier via bounded polling, delivers SIGKILL, confirms the child exited, and
 * asserts the exact durable state left on disk (proving the ordering at that
 * cut survives a hard crash). It then restarts a fresh daemon in-process over
 * the same temp agent dir and asserts the crash-replay contract:
 *   - no duplicate provider delete after a terminal receipt (cuts 2/3/4);
 *   - safe replay exactly once when the claim is nonterminal (cut 1);
 *   - endpoint-carried identity drives admission on restart (cut 5).
 *
 * Only a fake Telegram provider is used — there are no production
 * Telegram/network calls. Durable files come from `daemonPaths`,
 * `registerNotificationRoot`, and the `TelegramNotificationDaemon`.
 *
 * Child invocation is a plain `bun <file> --child …` SCRIPT run (never the
 * `bun test` runner), so the `describe`/`test` registrations below are guarded
 * out of child mode and the child fixture blocks on a keepalive until SIGKILL.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Settings } from "../src/config/settings";
import { type ChatEffect, ChatEffectJournal, type ChatEffectReceipt } from "../src/sdk/bus/chat-effect-journal";
import {
	daemonPaths,
	registerNotificationRoot,
	stampEndpointPublicationIdentity,
	type TelegramDaemonFs,
	TelegramNotificationDaemon,
} from "../src/sdk/bus/telegram-daemon";

// --------------------------------------------------------------------------- //
// Shared constants                                                            //
// --------------------------------------------------------------------------- //

const CHAT_ID = "42";
const SESSION_ID = "S";
const LEASE_ID = "lease-1";
/** Deterministic forum-topic id returned by the fake provider's createForumTopic. */
const TOPIC_ID = "777";
const CHILD_PID = 4242;
const CHILD_FLAG = "--child";
const CHILD_MODE = process.argv.includes(CHILD_FLAG);
const HERE = fileURLToPath(import.meta.url);
const BUN = process.execPath;
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

type CrashPhase =
	| "claim-before-provider"
	| "provider-terminal-before-topic-registry"
	| "topic-registry-before-roots-compaction"
	| "roots-before-reconciled"
	| "endpoint-publication-identity";

const barrierPath = (agentDir: string, phase: CrashPhase): string => path.join(agentDir, `barrier-${phase}.json`);
const CHILD_ERROR_FILE = "child-error.json";

// --------------------------------------------------------------------------- //
// Shared fakes + helpers (mirrors of notifications-telegram-daemon.test.ts)   //
// --------------------------------------------------------------------------- //

function tempAgentDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "gjc-telegram-crash-"));
}

function setPrivateAgentDir(s: Settings, agentDir: string): Settings {
	return new Proxy(s, {
		get(target, prop) {
			if (prop === "getAgentDir") return () => agentDir;
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Settings;
}

function settings(agentDir: string): Settings {
	// Isolate getAgentDir() to the temp dir so daemon persistence never touches
	// the real global ~/.gjc/agent.
	return setPrivateAgentDir(
		Settings.isolated({
			"notifications.enabled": true,
			"notifications.telegram.botToken": "123456:secret-token",
			"notifications.telegram.chatId": CHAT_ID,
			"notifications.daemon.idleTimeoutMs": 20,
		}) as Settings,
		agentDir,
	);
}

/** Minimal WebSocket stand-in; scanRoots connects live endpoints through it. */
class FakeWs extends EventTarget {
	static OPEN = 1;
	readyState = 1;
	sent: string[] = [];
	static instances: FakeWs[] = [];
	constructor(public url = "") {
		super();
		FakeWs.instances.push(this);
	}
	send(data: string): void {
		this.sent.push(data);
	}
	close(): void {
		this.readyState = 3;
		this.dispatchEvent(new Event("close"));
	}
}

/** Fake Telegram provider: deterministic topic id; deleteForumTopic returns OK. */
class FakeBotApi {
	calls: Array<{ method: string; body: unknown }> = [];
	async call(method: string, body: unknown): Promise<unknown> {
		this.calls.push({ method, body });
		if (method === "getUpdates") return { ok: true, result: [] };
		if (method === "getMe") return { ok: true, result: { id: 1 } };
		if (method === "getChat")
			return { ok: true, result: { id: (body as { chat_id?: unknown }).chat_id, type: "private" } };
		if (method === "createForumTopic") return { ok: true, result: { message_thread_id: Number(TOPIC_ID) } };
		if (method === "sendMessage") return { ok: true, result: { message_id: 1 } };
		// deleteForumTopic: the only positive signal is an explicit OK.
		return { ok: true, result: true };
	}
}

function rootsRegistrySnapshot(agentDir: string): {
	roots: string[];
	sessions: Record<string, string>;
	sessionLeases: Record<string, { leaseId: string; refreshedAt: number }>;
	orphanCandidates: Record<string, unknown>;
} {
	const file = daemonPaths(agentDir).roots;
	if (!fs.existsSync(file)) return { roots: [], sessions: {}, sessionLeases: {}, orphanCandidates: {} };
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

function topicRegistrySnapshot(agentDir: string): {
	topics: Record<string, { topicId: string; createdAt: number; [key: string]: unknown }>;
} {
	const file = path.join(daemonPaths(agentDir).dir, "telegram-topics.json");
	if (!fs.existsSync(file)) return { topics: {} };
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function telegramDeletionEffects(agentDir: string): Promise<ChatEffect[]> {
	return new ChatEffectJournal({ agentDir, transport: "telegram" }).list();
}

function topicIdOf(effect: ChatEffect): string | undefined {
	return (effect.payload as { topicId?: string } | undefined)?.topicId;
}

/**
 * Register a notification root and publish a live identity-bearing endpoint file
 * (canonicalRoot + leaseId stamped from the registration) via the production
 * publication path.
 */
async function publishIdentityEndpoint(
	s: Settings,
	cwd: string,
	sessionId: string,
	url: string,
	token: string,
	opts?: { now?: () => number; randomId?: () => string; pid?: number },
): Promise<{ canonicalRoot: string; leaseId: string }> {
	const reg = await registerNotificationRoot({ settings: s, cwd, sessionId, ...(opts ?? {}) });
	const dir = path.join(reg.root, "sdk");
	fs.mkdirSync(dir, { recursive: true });
	const endpointPath = path.join(dir, `${sessionId}.json`);
	fs.writeFileSync(
		endpointPath,
		JSON.stringify({ url, token, ...(opts?.pid === undefined ? {} : { pid: opts.pid }) }),
	);
	await stampEndpointPublicationIdentity(endpointPath, {
		canonicalRoot: reg.root,
		leaseId: reg.leaseId,
	});
	return { canonicalRoot: reg.root, leaseId: reg.leaseId };
}

// --------------------------------------------------------------------------- //
// Crash-cut gates                                                             //
// --------------------------------------------------------------------------- //

/**
 * Write the cut-point barrier and block forever. The keepalive `setInterval`
 * guarantees the child stays alive until the parent delivers SIGKILL — a bare
 * pending promise alone does not keep the event loop from draining.
 */
function hitBarrier(agentDir: string, phase: CrashPhase): Promise<never> {
	fs.writeFileSync(barrierPath(agentDir, phase), JSON.stringify({ phase, at: Date.now() }));
	setInterval(() => undefined, 60_000);
	return new Promise<never>(() => undefined);
}

/**
 * `TelegramDaemonFs` that delegates every operation to the real fs but, once
 * `gate.armed` is raised, blocks the durable write that follows the named cut
 * point. Used for cuts (2) and (3); all other writes (including setup) pass
 * through so the durable claim/registry state is exercised truthfully.
 */
function makeGatedFs(phase: CrashPhase, gate: { armed: boolean }, agentDir: string): TelegramDaemonFs {
	return {
		mkdir: (file, opts) => fs.promises.mkdir(file, opts).then(() => undefined),
		readFile: (file, encoding) => fs.promises.readFile(file, encoding),
		writeFile: async (file, data, opts) => {
			const target = String(file);
			if (
				gate.armed &&
				phase === "provider-terminal-before-topic-registry" &&
				target.includes("telegram-topics.json")
			) {
				// Cut (2): provider terminal receipt is already durable; block the
				// topic-registry cleanup before it reaches disk.
				await hitBarrier(agentDir, phase);
			}
			if (
				gate.armed &&
				phase === "topic-registry-before-roots-compaction" &&
				target.includes("telegram-daemon.roots.json")
			) {
				// Cut (3): topic-registry cleanup is already durable; block the roots
				// compaction write before it reaches disk.
				await hitBarrier(agentDir, phase);
			}
			await fs.promises.writeFile(file, data, opts);
		},
		rename: (oldPath, newPath) => fs.promises.rename(oldPath, newPath).then(() => undefined),
		unlink: file => fs.promises.unlink(file),
		open: async (file, flags, mode) => fs.promises.open(file, flags, mode),
		readdir: file => fs.promises.readdir(file),
		chmod: (file, mode) => fs.promises.chmod(file, mode),
	};
}

/** FakeBotApi that blocks `deleteForumTopic` forever, gating cut (1). */
class GatedBotApi extends FakeBotApi {
	constructor(private readonly crashAgentDir: string) {
		super();
	}
	override async call(method: string, body: unknown): Promise<unknown> {
		if (method === "deleteForumTopic") {
			// Cut (1): the durable claim is already recorded; block before the
			// provider resolves (terminal receipt must never reach disk here).
			await hitBarrier(this.crashAgentDir, "claim-before-provider");
		}
		return super.call(method, body);
	}
}

/**
 * ChatEffectJournal whose `updateTerminalReceipt` (the reconciled-receipt write)
 * blocks forever, gating cut (4). Every other operation (enqueue/claim/record)
 * delegates to the real durable journal.
 */
class GatedChatEffectJournal extends ChatEffectJournal {
	constructor(private readonly crashAgentDir: string) {
		super({ agentDir: crashAgentDir, transport: "telegram" });
	}
	override async updateTerminalReceipt<TPayload = unknown>(
		_id: string,
		_receipt: ChatEffectReceipt,
	): Promise<ChatEffect<TPayload> | undefined> {
		// Cut (4): roots compaction is already durable; block the reconciled
		// journal receipt before it reaches disk.
		return hitBarrier(this.crashAgentDir, "roots-before-reconciled");
	}
}

// --------------------------------------------------------------------------- //
// Child fixture                                                               //
// --------------------------------------------------------------------------- //

async function runChildFixture(phase: CrashPhase, agentDir: string, baseNow: number): Promise<void> {
	// Keep the child alive from the very first tick so setup never lets the
	// process exit before the barrier is reached.
	const keepalive = setInterval(() => undefined, 60_000);
	try {
		const s = settings(agentDir);
		const cwd = path.join(agentDir, "repo");
		fs.mkdirSync(cwd, { recursive: true });

		// Production publication path: durable roots registry + stamped endpoint.
		await publishIdentityEndpoint(s, cwd, SESSION_ID, "ws://child", "ttok", {
			randomId: () => LEASE_ID,
			now: () => 1000,
			pid: CHILD_PID,
		});

		// Cut (5) crashes immediately after the identity is durably published,
		// before any daemon work.
		if (phase === "endpoint-publication-identity") {
			await hitBarrier(agentDir, phase);
		}

		// Build the phase-gated production seams.
		const gate = { armed: false };
		const botApi = phase === "claim-before-provider" ? new GatedBotApi(agentDir) : new FakeBotApi();
		const gatedFs =
			phase === "provider-terminal-before-topic-registry" || phase === "topic-registry-before-roots-compaction"
				? makeGatedFs(phase, gate, agentDir)
				: undefined;
		const deletionJournal = phase === "roots-before-reconciled" ? new GatedChatEffectJournal(agentDir) : undefined;

		const daemonOptions: ConstructorParameters<typeof TelegramNotificationDaemon>[0] = {
			settings: s,
			ownerId: "owner-crash",
			botToken: "ttok",
			chatId: CHAT_ID,
			botApi: botApi,
			WebSocketImpl: FakeWs as never,
			pidAlive: () => true,
			topicDeleteTimeoutMs: 60_000,
			now: () => baseNow,
		};
		if (gatedFs) daemonOptions.fs = gatedFs;
		if (deletionJournal) daemonOptions.deletionJournal = deletionJournal;

		const daemon = new TelegramNotificationDaemon(daemonOptions);
		await daemon.loadTopics();
		await daemon.scanRoots();
		const session = daemon.sessions.get(SESSION_ID);
		if (!session) throw new Error("child: session S was not admitted by scanRoots");

		// Create the topic on the production path (persisted during setup).
		await daemon.handleSessionMessage(session, {
			type: "identity_header",
			sessionId: SESSION_ID,
			repo: "r",
			branch: "b",
		});

		// Arm the durable-write gate only now, so setup writes are never blocked.
		gate.armed = true;

		// Drive the full destructive close path; the phase gate blocks at the cut.
		await daemon.handleSessionMessage(session, { type: "session_closed", sessionId: SESSION_ID });
		// Unreachable: the gate blocks forever and the parent delivers SIGKILL.
		throw new Error(`child: phase ${phase} did not block at its cut point`);
	} catch (err) {
		clearInterval(keepalive);
		fs.writeFileSync(
			path.join(agentDir, CHILD_ERROR_FILE),
			JSON.stringify({ error: String((err as Error)?.stack ?? err) }),
		);
		process.exit(1);
	}
}

if (CHILD_MODE) {
	const idx = process.argv.indexOf(CHILD_FLAG);
	const phase = process.argv[idx + 1] as CrashPhase;
	const agentDir = process.argv[idx + 2];
	const baseNowRaw = Number(process.argv[idx + 3]);
	const baseNow = Number.isFinite(baseNowRaw) ? baseNowRaw : Date.now();
	await runChildFixture(phase, agentDir, baseNow);
}

// --------------------------------------------------------------------------- //
// Parent orchestration                                                        //
// --------------------------------------------------------------------------- //

async function confirmExit(proc: ReturnType<typeof Bun.spawn>, timeoutMs = 5_000): Promise<void> {
	const exited = await Promise.race([
		proc.exited.then(
			() => true,
			() => true,
		),
		sleep(timeoutMs).then(() => false),
	]);
	if (!exited) throw new Error(`crash child ${proc.pid} did not exit within ${timeoutMs}ms`);
}

/**
 * Spawn the child for `phase`, bounded-poll for its barrier, then SIGKILL it and
 * confirm the exit. Throws with the child's recorded error if setup failed.
 */
async function waitForBarrierAndKill(agentDir: string, phase: CrashPhase, baseNow: number): Promise<void> {
	const barrier = barrierPath(agentDir, phase);
	const errFile = path.join(agentDir, CHILD_ERROR_FILE);
	const proc = Bun.spawn([BUN, HERE, CHILD_FLAG, phase, agentDir, String(baseNow)], {
		cwd: path.dirname(HERE),
		stdout: "ignore",
		stderr: "pipe",
		env: { ...process.env },
	});
	const deadline = Date.now() + 20_000;
	try {
		while (Date.now() < deadline) {
			if (fs.existsSync(barrier)) {
				proc.kill("SIGKILL");
				await confirmExit(proc);
				return;
			}
			if (fs.existsSync(errFile)) {
				throw new Error(`child setup failed: ${fs.readFileSync(errFile, "utf8")}`);
			}
			if (proc.exitCode !== null) {
				const stderrText = await new Response(proc.stderr).text().catch(() => "");
				throw new Error(`child exited early code=${proc.exitCode} stderr=${stderrText.slice(0, 800)}`);
			}
			await sleep(25);
		}
		throw new Error(`child never reached barrier for phase ${phase}`);
	} finally {
		try {
			proc.kill("SIGKILL");
		} catch {
			// Already dead.
		}
		await confirmExit(proc);
	}
}

/** Restart a fresh daemon over the crash survivor and run startup reconciliation. */
async function reconcileAfterCrash(agentDir: string, baseNow: number): Promise<FakeBotApi> {
	FakeWs.instances = [];
	const bot = new FakeBotApi();
	const daemon = new TelegramNotificationDaemon({
		settings: settings(agentDir),
		ownerId: "owner-restart",
		botToken: "ttok",
		chatId: CHAT_ID,
		botApi: bot,
		WebSocketImpl: FakeWs as never,
		pidAlive: () => true,
		// Advance the clock past the child's 60s deletion lease so a nonterminal
		// (leased) claim is reclaimable by the restart owner for safe replay.
		now: () => baseNow + 120_000,
	});
	await daemon.loadTopics();
	await daemon.scanRoots();
	return bot;
}

const deleteForumTopicCount = (bot: FakeBotApi): number =>
	bot.calls.filter(c => c.method === "deleteForumTopic").length;

// --------------------------------------------------------------------------- //
// Tests (parent / test-runner mode only)                                      //
// --------------------------------------------------------------------------- //

if (!CHILD_MODE) {
	describe("telegram daemon crash durability (subprocess SIGKILL/barrier)", () => {
		test("cut 1: durable deletion-journal claim is recorded before provider resolution; restart replays the nonterminal claim exactly once", async () => {
			const agentDir = tempAgentDir();
			const baseNow = Date.now();
			await waitForBarrierAndKill(agentDir, "claim-before-provider", baseNow);

			// After SIGKILL: the claim is durable and leased (nonterminal), no
			// terminal receipt reached disk, and no destructive mutation (topic
			// removal / roots compaction) happened.
			const claim = (await telegramDeletionEffects(agentDir)).find(e => topicIdOf(e) === TOPIC_ID);
			expect(claim, "durable claim must exist after the crash").toBeDefined();
			expect(claim!.state).toBe("leased");
			expect(claim!.receipt?.status).toBeUndefined();
			expect(topicRegistrySnapshot(agentDir).topics[SESSION_ID]).toBeDefined();
			const roots = rootsRegistrySnapshot(agentDir);
			expect(roots.sessionLeases[SESSION_ID]?.leaseId).toBe(LEASE_ID);
			expect(roots.sessions[SESSION_ID]).toBeDefined();

			// Restart: safe replay of the nonterminal claim — exactly one provider
			// delete, then local cleanup and a reconciled receipt.
			const restartBot = await reconcileAfterCrash(agentDir, baseNow);
			expect(deleteForumTopicCount(restartBot)).toBe(1);
			expect(topicRegistrySnapshot(agentDir).topics[SESSION_ID]).toBeUndefined();
			const rootsAfter = rootsRegistrySnapshot(agentDir);
			expect(rootsAfter.sessionLeases[SESSION_ID]).toBeUndefined();
			expect(rootsAfter.sessions[SESSION_ID]).toBeUndefined();
			const claimAfter = (await telegramDeletionEffects(agentDir)).find(e => topicIdOf(e) === TOPIC_ID);
			expect(claimAfter!.state).toBe("terminal");
			expect(claimAfter!.receipt?.status).toBe("reconciled");
		});

		test("cut 2: provider terminal receipt is durable before topic-registry cleanup; restart finishes cleanup without a duplicate provider delete", async () => {
			const agentDir = tempAgentDir();
			const baseNow = Date.now();
			await waitForBarrierAndKill(agentDir, "provider-terminal-before-topic-registry", baseNow);

			// After SIGKILL: terminal "deleted" receipt is durable; the topic
			// registry still holds the topic (persistTopics had not reached disk);
			// roots are intact.
			const claim = (await telegramDeletionEffects(agentDir)).find(e => topicIdOf(e) === TOPIC_ID)!;
			expect(claim.state).toBe("terminal");
			expect(claim.receipt?.status).toBe("deleted");
			expect(topicRegistrySnapshot(agentDir).topics[SESSION_ID]).toBeDefined();
			const roots = rootsRegistrySnapshot(agentDir);
			expect(roots.sessionLeases[SESSION_ID]?.leaseId).toBe(LEASE_ID);
			expect(roots.sessions[SESSION_ID]).toBeDefined();

			// Restart: exact-current terminal claim finishes local cleanup WITHOUT
			// another provider call, then compacts and reconciles.
			const restartBot = await reconcileAfterCrash(agentDir, baseNow);
			expect(deleteForumTopicCount(restartBot)).toBe(0);
			expect(topicRegistrySnapshot(agentDir).topics[SESSION_ID]).toBeUndefined();
			const rootsAfter = rootsRegistrySnapshot(agentDir);
			expect(rootsAfter.sessionLeases[SESSION_ID]).toBeUndefined();
			expect(rootsAfter.sessions[SESSION_ID]).toBeUndefined();
			const claimAfter = (await telegramDeletionEffects(agentDir)).find(e => topicIdOf(e) === TOPIC_ID)!;
			expect(claimAfter.receipt?.status).toBe("reconciled");
		});

		test("cut 3: topic-registry cleanup is durable before roots compaction; restart compacts without a duplicate provider delete", async () => {
			const agentDir = tempAgentDir();
			const baseNow = Date.now();
			await waitForBarrierAndKill(agentDir, "topic-registry-before-roots-compaction", baseNow);

			// After SIGKILL: the topic is removed from the registry (persistTopics
			// reached disk), but roots were NOT compacted (the compaction write was
			// the blocked cut); the claim is terminal "deleted".
			expect(topicRegistrySnapshot(agentDir).topics[SESSION_ID]).toBeUndefined();
			const roots = rootsRegistrySnapshot(agentDir);
			expect(roots.sessionLeases[SESSION_ID]?.leaseId).toBe(LEASE_ID);
			expect(roots.sessions[SESSION_ID]).toBeDefined();
			const claim = (await telegramDeletionEffects(agentDir)).find(e => topicIdOf(e) === TOPIC_ID)!;
			expect(claim.state).toBe("terminal");
			expect(claim.receipt?.status).toBe("deleted");

			// Restart: the exact-current terminal claim compacts roots (reclaiming
			// the stale lock the SIGKILLed child left) and reconciles without a
			// provider call.
			const restartBot = await reconcileAfterCrash(agentDir, baseNow);
			expect(deleteForumTopicCount(restartBot)).toBe(0);
			expect(topicRegistrySnapshot(agentDir).topics[SESSION_ID]).toBeUndefined();
			const rootsAfter = rootsRegistrySnapshot(agentDir);
			expect(rootsAfter.sessionLeases[SESSION_ID]).toBeUndefined();
			expect(rootsAfter.sessions[SESSION_ID]).toBeUndefined();
			const claimAfter = (await telegramDeletionEffects(agentDir)).find(e => topicIdOf(e) === TOPIC_ID)!;
			expect(claimAfter.receipt?.status).toBe("reconciled");
		});

		test("cut 4: roots compaction is durable before the reconciled journal receipt; restart never re-deletes", async () => {
			const agentDir = tempAgentDir();
			const baseNow = Date.now();
			await waitForBarrierAndKill(agentDir, "roots-before-reconciled", baseNow);

			// After SIGKILL: roots are compacted (session/lease/root removed) and
			// the topic registry is cleaned — both reached disk — but the journal
			// receipt is still terminal "deleted" (the reconciled write was the cut).
			expect(topicRegistrySnapshot(agentDir).topics[SESSION_ID]).toBeUndefined();
			const roots = rootsRegistrySnapshot(agentDir);
			expect(roots.sessionLeases[SESSION_ID]).toBeUndefined();
			expect(roots.sessions[SESSION_ID]).toBeUndefined();
			const claim = (await telegramDeletionEffects(agentDir)).find(e => topicIdOf(e) === TOPIC_ID)!;
			expect(claim.state).toBe("terminal");
			expect(claim.receipt?.status).toBe("deleted");

			// Restart: the terminal claim is never re-deleted (no duplicate provider
			// call). Compaction already removed the session's durable authority, so
			// tri-state evidence is UNKNOWN and reconciliation leaves the terminal
			// claim untouched rather than risk an action — it never calls Telegram.
			const restartBot = await reconcileAfterCrash(agentDir, baseNow);
			expect(deleteForumTopicCount(restartBot)).toBe(0);
			expect(topicRegistrySnapshot(agentDir).topics[SESSION_ID]).toBeUndefined();
			const rootsAfter = rootsRegistrySnapshot(agentDir);
			expect(rootsAfter.sessionLeases[SESSION_ID]).toBeUndefined();
			expect(rootsAfter.sessions[SESSION_ID]).toBeUndefined();
			const claimAfter = (await telegramDeletionEffects(agentDir)).find(e => topicIdOf(e) === TOPIC_ID)!;
			expect(claimAfter.state).toBe("terminal");
			expect(claimAfter.receipt?.status).toBe("deleted");
		});

		test("cut 5: endpoint publication identity (canonicalRoot + leaseId) is durable across a hard crash and drives admission on restart", async () => {
			const agentDir = tempAgentDir();
			const baseNow = Date.now();
			await waitForBarrierAndKill(agentDir, "endpoint-publication-identity", baseNow);

			// After SIGKILL: the production stamper durably wrote BOTH the roots
			// registry (session→canonicalRoot mapping + lease) AND the endpoint
			// file's immutable canonicalRoot+leaseId identity.
			const roots = rootsRegistrySnapshot(agentDir);
			expect(roots.sessionLeases[SESSION_ID]?.leaseId).toBe(LEASE_ID);
			const canonicalRoot = roots.sessions[SESSION_ID];
			expect(canonicalRoot, "registered canonical root must be durable").toBeDefined();
			const endpoint = JSON.parse(
				fs.readFileSync(path.join(canonicalRoot!, "sdk", `${SESSION_ID}.json`), "utf8"),
			) as Record<string, unknown>;
			expect(endpoint).toMatchObject({
				url: "ws://child",
				token: "ttok",
				pid: CHILD_PID,
				canonicalRoot: canonicalRoot,
				leaseId: LEASE_ID,
			});

			// Restart: a fresh daemon re-reads the stamped endpoint and admits the
			// session under the exact endpoint-carried identity.
			FakeWs.instances = [];
			const daemon = new TelegramNotificationDaemon({
				settings: settings(agentDir),
				ownerId: "owner-restart",
				botToken: "ttok",
				chatId: CHAT_ID,
				botApi: new FakeBotApi(),
				WebSocketImpl: FakeWs as never,
				pidAlive: () => true,
				now: () => baseNow + 120_000,
			});
			await daemon.loadTopics();
			await daemon.scanRoots();
			const session = daemon.sessions.get(SESSION_ID);
			expect(session, "session must be admitted from the durable stamped endpoint").toBeDefined();
			expect(session!.leaseId).toBe(LEASE_ID);
		});
	});
}
