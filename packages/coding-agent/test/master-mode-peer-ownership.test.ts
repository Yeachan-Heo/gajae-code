import { describe, expect, it } from "bun:test";
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
import { SpawnAuthorityStore } from "../src/sdk/broker/spawn-authority";
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

function ownership(rows: readonly SdkSearchRowV1[]): Record<string, unknown> {
	return Object.fromEntries(
		rows.map(row => [
			row.id,
			{ ...(row.role ? { role: row.role } : {}), ...(row.spawnedBy ? { spawnedBy: row.spawnedBy } : {}) },
		]),
	);
}

describe("master peer ownership", () => {
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
			const record = async (identity: string, childId: string, ownerSessionId: string, pid: number) => {
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
						closeState: "active",
						createdAt: at,
						updatedAt: at,
					},
				});
				await store.releaseOwner(identity);
			};
			await record("one", "child-one", "master-a", 901);
			await record("agree-1", "child-agree", "master-b", 902);
			await record("agree-2", "child-agree", "master-b", 903);
			await record("split-1", "child-split", "master-a", 904);
			await record("split-2", "child-split", "master-b", 905);

			const expected = new Map([
				["child-one", "master-a"],
				["child-agree", "master-b"],
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
