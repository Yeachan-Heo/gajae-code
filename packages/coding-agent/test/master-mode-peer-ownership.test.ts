import { beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { collectMasterPeerSnapshot, renderMasterPeerSnapshot } from "../src/master-mode/snapshot";
import { Broker, type SpawnRegistrationRequest } from "../src/sdk/broker/broker";
import { getBrokerIdentityKey } from "../src/sdk/broker/identity";
import { processIncarnation } from "../src/sdk/broker/process-incarnation";
import {
	resolveSessionLocator,
	type SessionIndexEvent,
	type SessionLocatorV2,
	sessionIndexChecksum,
} from "../src/sdk/broker/session-index";
import { type SdkSearchRowV1, sdkSearchRowV1 } from "../src/sdk/broker/session-scope";
import { SpawnAuthorityStore, type SpawnOwnerRecord } from "../src/sdk/broker/spawn-authority";
import { SESSION_INDEX_EVENT_VERSION } from "../src/sdk/broker/state-version";
import { runSdkSpawn } from "../src/sdk/cli/master-cli";
import { toSessionRowV1 } from "../src/sdk/cli/rows";
import { renderSdkSearchTable, runSdkSearch } from "../src/sdk/cli/session-cli";
import { type SessionLifecycleClient, SessionLifecycleService } from "../src/sdk/lifecycle/service";

const incarnation = processIncarnation(process.pid) ?? "missing-incarnation";
const masters = [
	{ id: "master-a", grant: "grant-a", epoch: "epoch-a" },
	{ id: "master-b", grant: "grant-b", epoch: "epoch-b" },
] as const;

let indexSeq = 0;
function indexEvent(input: Omit<SessionIndexEvent, "version" | "indexSeq" | "checksum" | "ts">): SessionIndexEvent {
	const unsigned: Omit<SessionIndexEvent, "checksum"> = {
		...input,
		version: SESSION_INDEX_EVENT_VERSION,
		indexSeq: ++indexSeq,
		ts: Date.now(),
	};
	return { ...unsigned, checksum: sessionIndexChecksum(unsigned) };
}

async function appendIndex(agentDir: string, events: readonly SessionIndexEvent[]): Promise<void> {
	const directory = path.join(agentDir, "sdk", "sessions");
	await fs.mkdir(directory, { recursive: true });
	await fs.appendFile(path.join(directory, "index.jsonl"), `${events.map(row => JSON.stringify(row)).join("\n")}\n`);
}

function masterRegistration(master: (typeof masters)[number], locator: SessionLocatorV2): SessionIndexEvent[] {
	const masterRole = {
		version: 2 as const,
		ownerSessionId: master.id,
		launchPid: process.pid,
		launchProcessIncarnation: incarnation,
		role: "master" as const,
		attestationEpoch: master.epoch,
	};
	return [0, 1].map(endpointGeneration =>
		indexEvent({
			type: "host_registered",
			sessionId: master.id,
			locator,
			endpointGeneration,
			pid: process.pid,
			hostIncarnation: incarnation,
			masterRole,
		}),
	);
}

/** Headless substrate fake: every launch gets its own pid so children never share a substrate identity. */
function substrateFake() {
	let nextPid = 5000;
	const closed = new Set<number>();
	return {
		launch: async () => {
			const pid = nextPid++;
			return {
				ok: true as const,
				proof: {
					substrateKind: "headless" as const,
					providerIdentity: "ownership-provider",
					pid,
					processIncarnation: `inc-${pid}`,
				},
			};
		},
		verify: async (proof: { pid?: number }) =>
			proof.pid !== undefined && closed.has(proof.pid) ? ("gone" as const) : ("verified" as const),
		resolveLifecycleOwner: async () => ({ ok: true as const, owner: { pid: 4999, incarnation: "inc-4999" } }),
		close: async (proof: { pid?: number }) => {
			if (proof.pid !== undefined) closed.add(proof.pid);
			return { ok: true };
		},
	};
}

function promptLayerFake(registeredPids: Map<string, number>) {
	return {
		awaitRegistration: async (input: SpawnRegistrationRequest) => {
			const marker = (await Bun.file(
				path.join(input.stateRoot, "sdk", `${input.childId}.lifecycle.json`),
			).json()) as {
				pid: number;
				incarnation: string;
			};
			registeredPids.set(input.childId, marker.pid);
			return {
				ok: true as const,
				registration: {
					sessionId: input.childId,
					lifecycleRequestId: input.effectMarker,
					endpointGeneration: 1,
					pid: marker.pid,
					processIncarnation: marker.incarnation,
					cwd: input.cwd,
					stateRoot: input.stateRoot,
				},
			};
		},
		dispatch: async () => ({ kind: "accepted" as const, commandId: "cmd", turnId: "turn", acceptedAt: 1 }),
		reconcile: async () => ({ status: "terminal_ok" as const, commandId: "cmd", turnId: "turn" }),
	};
}

/** Lifecycle client that answers through the real Broker request handler. */
class BrokerClient implements SessionLifecycleClient {
	constructor(readonly broker: Broker) {}
	async global(operation: string, input: Record<string, unknown>): Promise<unknown> {
		return await this.broker.handleRequest(operation, input, undefined);
	}
}

/** Records one durable spawn authority through the real store transitions. */
async function recordSpawnAuthority(
	store: SpawnAuthorityStore,
	input: {
		identity: string;
		childId: string;
		ownerSessionId: string;
		pid: number;
		endpointStateRoot?: string;
		endpointStateRootIdentity?: string;
	},
): Promise<void> {
	const { identity, childId, ownerSessionId, pid } = input;
	const owner = await store.claimOrJoin(identity, `${"c".repeat(63)}${pid % 10}`);
	if (owner.kind !== "owner") throw new Error("expected owner");
	await store.persistTransition(identity, {
		claimId: owner.claim.claimId,
		from: "prepared",
		to: "substrate_starting",
		childId,
	});
	const at = Date.now();
	await store.persistTransition(identity, {
		claimId: owner.claim.claimId,
		from: "substrate_starting",
		to: "authority_active",
		childId,
		authority: {
			version: 1,
			authorityId: `authority-${identity}`,
			claimId: owner.claim.claimId,
			childId,
			ownerSessionId,
			lifecycleIdentity: identity,
			substrateKind: "headless",
			providerIdentity: "p",
			pid,
			processIncarnation: `inc-${pid}`,
			...(input.endpointStateRoot === undefined ? {} : { endpointStateRoot: input.endpointStateRoot }),
			...(input.endpointStateRootIdentity === undefined
				? {}
				: { endpointStateRootIdentity: input.endpointStateRootIdentity }),
			closeState: "active",
			createdAt: at,
			updatedAt: at,
		},
	});
	await store.releaseOwner(identity);
}

function ownership(rows: readonly SdkSearchRowV1[]): Record<string, unknown> {
	return Object.fromEntries(
		rows.map(row => [
			row.id,
			{ ...(row.role ? { role: row.role } : {}), ...(row.spawnedBy ? { spawnedBy: row.spawnedBy } : {}) },
		]),
	);
}

describe("master peer ownership", () => {
	// Each test writes a fresh agent-dir index, whose sequence must start at 1.
	beforeEach(() => {
		indexSeq = 0;
	});

	it("shows each of two masters in one scope only its own children as self", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-peer-owner-"));
		const agentDir = path.join(root, "agent");
		const repo = path.join(root, "repo");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(repo, { recursive: true });
		const git = Bun.spawn(["git", "init", "-q", repo]);
		if ((await git.exited) !== 0) throw new Error("git init failed");
		const stateRoot = path.join(repo, ".gjc", "state");
		const locator = await resolveSessionLocator(repo, stateRoot);
		if (locator.worktreeRoot === null) throw new Error("test Git worktree was not resolved");

		const registeredPids = new Map<string, number>();
		const broker = new Broker({
			agentDir,
			spawnSubstrateProvider: substrateFake(),
			spawnPromptLayer: promptLayerFake(registeredPids),
			masterCapabilityVerifier: {
				verifyMasterCapability: async (owner, supplied, suppliedEpoch) => ({
					allowed: masters.some(m => m.id === owner && m.grant === supplied && m.epoch === suppliedEpoch),
				}),
			},
		});
		await broker.start();
		try {
			await appendIndex(agentDir, [
				...masterRegistration(masters[0], locator),
				...masterRegistration(masters[1], locator),
			]);

			// Each master spawns its children through the real CLI and Broker spawn path,
			// which records the owning master in durable spawn authority.
			const childrenOf: Record<string, string[]> = { "master-a": [], "master-b": [] };
			const plan = [masters[0], masters[1], masters[0]];
			for (const [index, master] of plan.entries()) {
				const spawned = await runSdkSpawn(
					{ cwd: repo, prompt: `task ${index}`, agentDir, idempotencyKey: `ownership-${index}` },
					{
						env: { GJC_MASTER_CAPABILITY: master.grant, GJC_MASTER_OWNER_SESSION_ID: master.id },
						dispatch: async (_dir: string, payload: Record<string, unknown>, key: string) =>
							await broker.handleRequest("session.spawn", payload, key),
					},
				);
				expect(spawned.rendered.code).toBe("spawn_accepted");
				const childId = spawned.rendered.sessionId;
				if (!childId) throw new Error("spawn returned no child id");
				childrenOf[master.id]!.push(childId);
			}

			// The children's hosts register in the same worktree, alongside one peer
			// that no master spawned.
			const children = [...childrenOf["master-a"]!, ...childrenOf["master-b"]!];
			await appendIndex(
				agentDir,
				[...children, "unowned-peer"].map(sessionId => {
					const pid = registeredPids.get(sessionId) ?? 6000;
					return indexEvent({
						type: "host_registered",
						sessionId,
						locator,
						endpointGeneration: 1,
						pid,
						processIncarnation: `inc-${pid}`,
						hostIncarnation: `inc-${pid}`,
					});
				}),
			);

			const service = new SessionLifecycleService(new BrokerClient(broker));
			const snapshotFor = async (masterId: string) =>
				await collectMasterPeerSnapshot({
					lifecycle: service,
					actor: { id: masterId, namespace: "sdk:master-snapshot" },
					ownerSessionId: masterId,
					scope: "repo",
					requestAnchor: { cwd: locator.cwd, worktreeRoot: locator.worktreeRoot },
				});
			const [aSnapshot, bSnapshot] = [await snapshotFor("master-a"), await snapshotFor("master-b")];
			const [a1, a2] = childrenOf["master-a"]!;
			const [b1] = childrenOf["master-b"]!;

			expect(aSnapshot.status).toBe("populated");
			expect(ownership(aSnapshot.rows)).toEqual({
				"master-b": { role: "master" },
				[a1!]: { spawnedBy: { masterSessionId: "master-a", self: true } },
				[a2!]: { spawnedBy: { masterSessionId: "master-a", self: true } },
				[b1!]: { spawnedBy: { masterSessionId: "master-b", self: false } },
				"unowned-peer": {},
			});
			expect(ownership(bSnapshot.rows)).toEqual({
				"master-a": { role: "master" },
				[a1!]: { spawnedBy: { masterSessionId: "master-a", self: false } },
				[a2!]: { spawnedBy: { masterSessionId: "master-a", self: false } },
				[b1!]: { spawnedBy: { masterSessionId: "master-b", self: true } },
				"unowned-peer": {},
			});

			// The rendered block the model reads carries the same facts.
			const rendered = renderMasterPeerSnapshot(aSnapshot);
			expect(rendered).toContain(`"id":"${b1}"`);
			expect(rendered).toContain('"spawnedBy":{"masterSessionId":"master-b","self":false}');
			expect(rendered).toContain('"role":"master"');

			// `gjc sdk search` uses the same Broker rows; the viewer comes from the
			// master owner env its Bash tool exports. Without a viewer, `self` is absent.
			const search = async (viewer: string | undefined) => {
				const prior = process.env.GJC_MASTER_OWNER_SESSION_ID;
				if (viewer === undefined) delete process.env.GJC_MASTER_OWNER_SESSION_ID;
				else process.env.GJC_MASTER_OWNER_SESSION_ID = viewer;
				try {
					return await runSdkSearch(
						{ agentDir, repo },
						() => service,
						async (_agentDir, value) => value,
					);
				} finally {
					if (prior === undefined) delete process.env.GJC_MASTER_OWNER_SESSION_ID;
					else process.env.GJC_MASTER_OWNER_SESSION_ID = prior;
				}
			};
			const asB = await search("master-b");
			expect(ownership(asB.result.rows)[b1!]).toEqual({ spawnedBy: { masterSessionId: "master-b", self: true } });
			expect(ownership(asB.result.rows)[a1!]).toEqual({ spawnedBy: { masterSessionId: "master-a", self: false } });
			const table = renderSdkSearchTable(asB.result);
			expect(table).toContain("OWNER");
			expect(table).toMatch(new RegExp(`${b1}\\s+-\\s+(?:true|false)\\s+self\\b`));
			expect(table).toMatch(/master-a\s+-\s+true\s+master\b/);
			const anonymous = await search(undefined);
			expect(ownership(anonymous.result.rows)[a1!]).toEqual({ spawnedBy: { masterSessionId: "master-a" } });
			expect(renderSdkSearchTable(anonymous.result)).toMatch(
				new RegExp(`${a1}\\s+-\\s+(?:true|false)\\s+spawned\\b`),
			);

			// Continuation pages carry ownership too: walk the scope two rows at a time.
			const request = {
				version: 1 as const,
				requested: "repo" as const,
				requestAnchor: { cwd: locator.cwd, worktreeRoot: locator.worktreeRoot },
			};
			const paged: SdkSearchRowV1[] = [];
			let cursor: string | undefined;
			let pages = 0;
			do {
				const page = await service.scopedList(request, 2, cursor);
				if (!page.ok || !("rows" in page.result)) throw new Error("scoped page failed");
				paged.push(...page.result.rows);
				cursor = page.result.cursor;
				pages++;
			} while (cursor !== undefined && pages < 10);
			expect(pages).toBeGreaterThan(1);
			expect(ownership(paged)).toEqual({
				"master-a": { role: "master" },
				"master-b": { role: "master" },
				[a1!]: { spawnedBy: { masterSessionId: "master-a" } },
				[a2!]: { spawnedBy: { masterSessionId: "master-a" } },
				[b1!]: { spawnedBy: { masterSessionId: "master-b" } },
				"unowned-peer": {},
			});

			// Closing a child keeps its recorded owner: the stopped row stays attributed.
			const closed = await broker.handleRequest("session.close", { sessionId: b1 }, undefined);
			expect(closed).toMatchObject({ ok: true, result: { code: "spawn_child_closed" } });
			const afterClose = await snapshotFor("master-b");
			expect(ownership(afterClose.rows)[b1!]).toEqual({ spawnedBy: { masterSessionId: "master-b", self: true } });
		} finally {
			await broker.stop();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("omits the spawning master on ambiguous rows and on rows from another state root", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-peer-owner-ambiguous-"));
		const agentDir = path.join(root, "agent");
		const repo = path.join(root, "repo");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(repo, { recursive: true });
		const git = Bun.spawn(["git", "init", "-q", repo]);
		if ((await git.exited) !== 0) throw new Error("git init failed");
		const locator = await resolveSessionLocator(repo, path.join(repo, ".gjc", "state"));
		const otherLocator = await resolveSessionLocator(repo, path.join(repo, ".gjc", "other-state"));
		if (locator.worktreeRoot === null) throw new Error("test Git worktree was not resolved");

		const registeredPids = new Map<string, number>();
		const broker = new Broker({
			agentDir,
			spawnSubstrateProvider: substrateFake(),
			spawnPromptLayer: promptLayerFake(registeredPids),
			masterCapabilityVerifier: {
				verifyMasterCapability: async (owner, supplied, suppliedEpoch) => ({
					allowed: masters.some(m => m.id === owner && m.grant === supplied && m.epoch === suppliedEpoch),
				}),
			},
		});
		await broker.start();
		try {
			await appendIndex(agentDir, [
				...masterRegistration(masters[0], locator),
				...masterRegistration(masters[1], locator),
			]);
			const children: string[] = [];
			for (const index of [0, 1, 2, 3]) {
				const spawned = await runSdkSpawn(
					{ cwd: repo, prompt: `task ${index}`, agentDir, idempotencyKey: `ambiguous-${index}` },
					{
						env: { GJC_MASTER_CAPABILITY: masters[0].grant, GJC_MASTER_OWNER_SESSION_ID: masters[0].id },
						dispatch: async (_dir: string, payload: Record<string, unknown>, key: string) =>
							await broker.handleRequest("session.spawn", payload, key),
					},
				);
				expect(spawned.rendered.code).toBe("spawn_accepted");
				if (!spawned.rendered.sessionId) throw new Error("spawn returned no child id");
				children.push(spawned.rendered.sessionId);
			}
			const [unique, duplicated, reused, fenced] = children as [string, string, string, string];
			const registration = (sessionId: string, at: SessionLocatorV2, pid: number) =>
				indexEvent({
					type: "host_registered",
					sessionId,
					locator: at,
					endpointGeneration: 1,
					pid,
					processIncarnation: `inc-${pid}`,
					hostIncarnation: `inc-${pid}`,
				});
			// Every spawned child registers in its own state root. An unrelated host
			// in a second state root then claims one live child's session id
			// (ambiguous), and another reuses the id of a child that already stopped
			// (a sole live root, so not ambiguous, but not the spawned host either).
			const reusedPid = registeredPids.get(reused)!;
			await appendIndex(agentDir, [
				registration(unique, locator, registeredPids.get(unique)!),
				registration(duplicated, locator, registeredPids.get(duplicated)!),
				registration(duplicated, otherLocator, 7000),
				registration(reused, locator, reusedPid),
				indexEvent({
					type: "host_unregistered",
					sessionId: reused,
					locator,
					endpointGeneration: 1,
					pid: reusedPid,
					processIncarnation: `inc-${reusedPid}`,
					hostIncarnation: `inc-${reusedPid}`,
				}),
				registration(reused, otherLocator, process.pid),
				// The foreign claim lands first, so the public row of this ambiguous id
				// is the child's own registration: only the ambiguity gate hides it.
				registration(fenced, otherLocator, 7001),
				registration(fenced, locator, registeredPids.get(fenced)!),
			]);

			// The raw Broker page marks only the duplicated id ambiguous and omits its owner.
			const listed = (await broker.handleRequest("session.list", {}, undefined)) as {
				ok: true;
				result: { sessions: Array<Record<string, unknown>> };
			};
			const byId = new Map(listed.result.sessions.map(session => [session.sessionId, session]));
			expect(byId.get(duplicated)).toMatchObject({ ambiguous: true });
			expect(byId.get(duplicated)).not.toHaveProperty("spawnedBy");
			expect(byId.get(unique)).toMatchObject({ ambiguous: false, spawnedBy: { masterSessionId: "master-a" } });
			expect(byId.get(reused)).toMatchObject({ ambiguous: false, locator: { stateRoot: otherLocator.stateRoot } });
			expect(byId.get(reused)).not.toHaveProperty("spawnedBy");
			expect(byId.get(fenced)).toMatchObject({ ambiguous: true, locator: { stateRoot: locator.stateRoot } });
			expect(byId.get(fenced)).not.toHaveProperty("spawnedBy");
			const listRow = toSessionRowV1(byId.get(duplicated)!);
			expect(listRow.ambiguous).toBe(true);
			expect(listRow).not.toHaveProperty("spawnedBy");

			// The spawning master's snapshot never claims the ambiguous row as its own.
			const service = new SessionLifecycleService(new BrokerClient(broker));
			const snapshot = await collectMasterPeerSnapshot({
				lifecycle: service,
				actor: { id: "master-a", namespace: "sdk:master-snapshot" },
				ownerSessionId: "master-a",
				scope: "repo",
				requestAnchor: { cwd: locator.cwd, worktreeRoot: locator.worktreeRoot },
			});
			expect(snapshot.status).toBe("populated");
			expect(ownership(snapshot.rows)).toEqual({
				"master-b": { role: "master" },
				[unique]: { spawnedBy: { masterSessionId: "master-a", self: true } },
				[duplicated]: {},
				[reused]: {},
				[fenced]: {},
			});

			// `gjc sdk search` as the spawning master shows the same suppression.
			const prior = process.env.GJC_MASTER_OWNER_SESSION_ID;
			process.env.GJC_MASTER_OWNER_SESSION_ID = "master-a";
			try {
				const searched = await runSdkSearch(
					{ agentDir, repo },
					() => service,
					async (_agentDir, value) => value,
				);
				const rows = ownership(searched.result.rows);
				expect(rows[duplicated]).toEqual({});
				expect(rows[reused]).toEqual({});
				expect(rows[fenced]).toEqual({});
				expect(rows[unique]).toEqual({ spawnedBy: { masterSessionId: "master-a", self: true } });
			} finally {
				if (prior === undefined) delete process.env.GJC_MASTER_OWNER_SESSION_ID;
				else process.env.GJC_MASTER_OWNER_SESSION_ID = prior;
			}
		} finally {
			await broker.stop();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("binds the spawn owner to the state root's canonical identity at registration", async () => {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-peer-owner-symlink-")));
		const agentDir = path.join(root, "agent");
		const targetA = path.join(root, "targets", "a");
		const targetB = path.join(root, "targets", "b");
		const targetC = path.join(root, "targets", "c");
		for (const dir of [agentDir, targetA, targetB, targetC]) await fs.mkdir(dir, { recursive: true });
		// Three workspaces: one whose state root is a symlink that is later
		// retargeted, one whose symlinked state root never changes, and one whose
		// state root is a plain directory.
		const repos = {
			retarget: path.join(root, "repo-retarget"),
			stable: path.join(root, "repo-stable"),
			plain: path.join(root, "repo-plain"),
		};
		for (const repo of Object.values(repos)) {
			await fs.mkdir(path.join(repo, ".gjc"), { recursive: true });
			const git = Bun.spawn(["git", "init", "-q", repo]);
			if ((await git.exited) !== 0) throw new Error("git init failed");
		}
		const retargetLink = path.join(repos.retarget, ".gjc", "state");
		await fs.symlink(targetA, retargetLink);
		await fs.symlink(targetC, path.join(repos.stable, ".gjc", "state"));
		await fs.mkdir(path.join(repos.plain, ".gjc", "state"));
		const locators = {
			retarget: await resolveSessionLocator(repos.retarget, retargetLink),
			stable: await resolveSessionLocator(repos.stable, path.join(repos.stable, ".gjc", "state")),
			plain: await resolveSessionLocator(repos.plain, path.join(repos.plain, ".gjc", "state")),
		};

		const registeredPids = new Map<string, number>();
		const broker = new Broker({
			agentDir,
			spawnSubstrateProvider: substrateFake(),
			spawnPromptLayer: promptLayerFake(registeredPids),
			masterCapabilityVerifier: {
				verifyMasterCapability: async (owner, supplied, suppliedEpoch) => ({
					allowed: masters.some(m => m.id === owner && m.grant === supplied && m.epoch === suppliedEpoch),
				}),
			},
		});
		await broker.start();
		try {
			await appendIndex(agentDir, masterRegistration(masters[0], locators.plain));
			const spawn = async (repo: string, key: string): Promise<string> => {
				const spawned = await runSdkSpawn(
					{ cwd: repo, prompt: `task ${key}`, agentDir, idempotencyKey: `symlink-${key}` },
					{
						env: { GJC_MASTER_CAPABILITY: masters[0].grant, GJC_MASTER_OWNER_SESSION_ID: masters[0].id },
						dispatch: async (_dir: string, payload: Record<string, unknown>, idempotencyKey: string) =>
							await broker.handleRequest("session.spawn", payload, idempotencyKey),
					},
				);
				expect(spawned.rendered.code).toBe("spawn_accepted");
				if (!spawned.rendered.sessionId) throw new Error("spawn returned no child id");
				return spawned.rendered.sessionId;
			};
			const retargeted = await spawn(repos.retarget, "retarget");
			const stable = await spawn(repos.stable, "stable");
			const plain = await spawn(repos.plain, "plain");
			const registration = (sessionId: string, at: SessionLocatorV2, pid: number) =>
				indexEvent({
					type: "host_registered",
					sessionId,
					locator: at,
					endpointGeneration: 1,
					pid,
					processIncarnation: `inc-${pid}`,
					hostIncarnation: `inc-${pid}`,
				});
			// The retargeted child registered through the symlink spelling, then stopped.
			const retargetedPid = registeredPids.get(retargeted)!;
			await appendIndex(agentDir, [
				registration(retargeted, locators.retarget, retargetedPid),
				indexEvent({
					type: "host_unregistered",
					sessionId: retargeted,
					locator: locators.retarget,
					endpointGeneration: 1,
					pid: retargetedPid,
					processIncarnation: `inc-${retargetedPid}`,
					hostIncarnation: `inc-${retargetedPid}`,
				}),
				registration(stable, locators.stable, registeredPids.get(stable)!),
				registration(plain, locators.plain, registeredPids.get(plain)!),
			]);
			// The symlink now names another directory, where an unrelated host reuses
			// the stopped child's session id.
			await fs.rm(retargetLink);
			await fs.symlink(targetB, retargetLink);
			const foreignLocator = await resolveSessionLocator(repos.retarget, targetB);
			await appendIndex(agentDir, [registration(retargeted, foreignLocator, process.pid)]);

			const listed = (await broker.handleRequest("session.list", {}, undefined)) as {
				ok: true;
				result: { sessions: Array<Record<string, unknown>> };
			};
			const byId = new Map(listed.result.sessions.map(session => [session.sessionId, session]));
			expect(byId.get(retargeted)).toMatchObject({ ambiguous: false, locator: { stateRoot: targetB } });
			expect(byId.get(retargeted)).not.toHaveProperty("spawnedBy");
			expect(toSessionRowV1(byId.get(retargeted)!)).not.toHaveProperty("spawnedBy");
			// Negative controls: an unchanged symlink and a plain directory keep their owner.
			expect(byId.get(stable)).toMatchObject({ ambiguous: false, spawnedBy: { masterSessionId: "master-a" } });
			expect(byId.get(plain)).toMatchObject({ ambiguous: false, spawnedBy: { masterSessionId: "master-a" } });
		} finally {
			await broker.stop();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("attributes no listed row to an authority without a registration-time canonical root", async () => {
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-peer-owner-legacy-")));
		const agentDir = path.join(root, "agent");
		const repo = path.join(root, "repo");
		const stateRoot = path.join(repo, ".gjc", "state");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(stateRoot, { recursive: true });
		const git = Bun.spawn(["git", "init", "-q", repo]);
		if ((await git.exited) !== 0) throw new Error("git init failed");
		const locator = await resolveSessionLocator(repo, stateRoot);

		// Durable authority written before this Broker starts: a legacy row that
		// carries only the state-root spelling, a pre-pin row with no root at all,
		// and a current row with the canonical identity as the control.
		const store = new SpawnAuthorityStore(agentDir, await getBrokerIdentityKey(agentDir));
		await store.open();
		const base = { ownerSessionId: "master-a" };
		await recordSpawnAuthority(store, {
			...base,
			identity: "legacy",
			childId: "legacy-child",
			pid: 911,
			endpointStateRoot: stateRoot,
		});
		await recordSpawnAuthority(store, { ...base, identity: "rootless", childId: "rootless-child", pid: 912 });
		await recordSpawnAuthority(store, {
			...base,
			identity: "current",
			childId: "current-child",
			pid: 913,
			endpointStateRoot: stateRoot,
			endpointStateRootIdentity: stateRoot,
		});

		const broker = new Broker({ agentDir, spawnSubstrateProvider: substrateFake() });
		await broker.start();
		try {
			await appendIndex(
				agentDir,
				["legacy-child", "rootless-child", "current-child"].map((sessionId, index) =>
					indexEvent({
						type: "host_registered",
						sessionId,
						locator,
						endpointGeneration: 1,
						pid: 6100 + index,
						processIncarnation: `inc-${6100 + index}`,
						hostIncarnation: `inc-${6100 + index}`,
					}),
				),
			);
			const listed = (await broker.handleRequest("session.list", {}, undefined)) as {
				ok: true;
				result: { sessions: Array<Record<string, unknown>> };
			};
			const byId = new Map(listed.result.sessions.map(session => [session.sessionId, session]));
			for (const sessionId of ["legacy-child", "rootless-child"]) {
				expect(byId.get(sessionId)).toMatchObject({ ambiguous: false, locator: { stateRoot } });
				expect(byId.get(sessionId)).not.toHaveProperty("spawnedBy");
				expect(toSessionRowV1(byId.get(sessionId)!)).not.toHaveProperty("spawnedBy");
			}
			expect(byId.get("current-child")).toMatchObject({
				ambiguous: false,
				spawnedBy: { masterSessionId: "master-a" },
			});
		} finally {
			await broker.stop();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("validates ownership fields on search rows strictly", () => {
		const base = { id: "s", locator: { cwd: "/r", worktreeRoot: "/r", stateRoot: "/st" }, live: true };
		expect(sdkSearchRowV1({ ...base, role: "master", spawnedBy: { masterSessionId: "m", self: false } })).toEqual({
			...base,
			role: "master",
			spawnedBy: { masterSessionId: "m", self: false },
		});
		expect(sdkSearchRowV1({ ...base, spawnedBy: { masterSessionId: "m" } })).toEqual({
			...base,
			spawnedBy: { masterSessionId: "m" },
		});
		expect(sdkSearchRowV1({ ...base, role: "worker" })).toBeUndefined();
		expect(sdkSearchRowV1({ ...base, spawnedBy: { masterSessionId: "" } })).toBeUndefined();
		expect(sdkSearchRowV1({ ...base, spawnedBy: { masterSessionId: "m", self: "yes" } })).toBeUndefined();
		expect(sdkSearchRowV1({ ...base, spawnedBy: { masterSessionId: "m", owner: "x" } })).toBeUndefined();
		expect(sdkSearchRowV1({ ...base, spawnedBy: null })).toBeUndefined();
	});

	it("projects ownership onto session list and inspect rows, omitting malformed values", () => {
		const base = { sessionId: "s", locator: { cwd: "/r", worktreeRoot: "/r", stateRoot: "/st" }, live: true };
		const owned = toSessionRowV1({
			...base,
			masterRole: { version: 2, ownerSessionId: "s", role: "master" },
			spawnedBy: { masterSessionId: "m" },
		});
		expect(owned.role).toBe("master");
		expect(owned.spawnedBy).toEqual({ masterSessionId: "m" });
		const legacy = toSessionRowV1(base);
		expect(legacy).not.toHaveProperty("role");
		expect(legacy).not.toHaveProperty("spawnedBy");
		const malformed = toSessionRowV1({ ...base, masterRole: { role: "worker" }, spawnedBy: { masterSessionId: 7 } });
		expect(malformed).not.toHaveProperty("role");
		expect(malformed).not.toHaveProperty("spawnedBy");
	});

	it("attributes a child only when its recorded authorities agree on one owner", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-spawn-owners-"));
		try {
			const store = new SpawnAuthorityStore(agentDir, await getBrokerIdentityKey(agentDir));
			await store.open();
			const current = { endpointStateRoot: "/state-a", endpointStateRootIdentity: "/state-a" };
			const record = (
				identity: string,
				childId: string,
				ownerSessionId: string,
				pid: number,
				roots: { endpointStateRoot?: string; endpointStateRootIdentity?: string } = current,
			) => recordSpawnAuthority(store, { identity, childId, ownerSessionId, pid, ...roots });
			await record("one", "child-one", "master-a", 901);
			await record("agree-1", "child-agree", "master-b", 902);
			await record("agree-2", "child-agree", "master-b", 903);
			await record("split-1", "child-split", "master-a", 904);
			await record("split-2", "child-split", "master-b", 905);
			// A pre-pin authority names the owner but records no state root.
			await record("pre-pin", "child-pre-pin", "master-a", 906, {});
			// A legacy authority records the state-root spelling but no canonical identity.
			await record("legacy", "child-legacy", "master-a", 907, { endpointStateRoot: "/state-a" });
			// Roots are collected from the canonical identity, never from the spelling.
			await record("spelled", "child-spelled", "master-b", 908, {
				endpointStateRoot: "/link/state",
				endpointStateRootIdentity: "/real/state",
			});

			const expected = new Map<string, SpawnOwnerRecord>([
				["child-one", { ownerSessionId: "master-a", stateRoots: new Set(["/state-a"]) }],
				["child-agree", { ownerSessionId: "master-b", stateRoots: new Set(["/state-a"]) }],
				["child-pre-pin", { ownerSessionId: "master-a", stateRoots: new Set() }],
				["child-legacy", { ownerSessionId: "master-a", stateRoots: new Set() }],
				["child-spelled", { ownerSessionId: "master-b", stateRoots: new Set(["/real/state"]) }],
			]);
			expect(new Map(store.spawnOwnersByChild())).toEqual(expected);
			// Ownership is durable: a reopened store derives the same attribution.
			const reopened = new SpawnAuthorityStore(agentDir, await getBrokerIdentityKey(agentDir));
			await reopened.open();
			expect(new Map(reopened.spawnOwnersByChild())).toEqual(expected);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});
});
