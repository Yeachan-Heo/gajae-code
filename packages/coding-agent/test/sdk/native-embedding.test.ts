import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { createEmbeddedAgentSession } from "../../src/sdk/embedding";
import {
	attestEmbeddedLegacyTakeover,
	consentEmbeddedDisconnect,
	prepareEmbeddedDisconnect,
	resolveEmbeddedResumeCheckpoint,
	terminateEmbeddedAgentSession,
} from "../../src/sdk/native-embedding";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../../src/sdk/session";
import { AuthStorage } from "../../src/session/auth-storage";

const roots: string[] = [];
const authStores: AuthStorage[] = [];
afterEach(async () => {
	for (const auth of authStores.splice(0)) auth.close();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture(entries: unknown[]) {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-admission-")));
	roots.push(root);
	const cwd = path.join(root, "project");
	await fs.mkdir(cwd);
	const file = path.join(root, "selected.jsonl");
	await Bun.write(
		file,
		[{ type: "session", version: 5, id: "selected", cwd, timestamp: "2026-01-01T00:00:00.000Z" }, ...entries]
			.map(entry => JSON.stringify(entry))
			.join("\n") + "\n",
	);
	const resolution = resolveEmbeddedResumeCheckpoint(file);
	if (resolution.kind !== "resolved") throw new Error(`Unexpected fixture: ${resolution.reason}`);
	return { root, cwd, file, agentDir: path.join(root, "agent"), resolution };
}
const user = (id: string, parentId: string | null) => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-01-01T00:00:00.000Z",
	message: { role: "user", content: id, timestamp: 1 },
});

describe("readonly-first native SDK embedding", () => {
	for (const closureAvailable of [true, false])
		it(`uses actual native runtime closure and ${closureAvailable ? "retires only after final proof" : "retains membership when final evidence is unavailable"}`, async () => {
			const f = await fixture([user("a", null)]);
			const expected = { snapshotDigest: f.resolution.checkpoint.snapshotDigest, resolved: f.resolution.checkpoint };
			const auth = await AuthStorage.create(path.join(f.agentDir, "auth.db"));
			authStores.push(auth);
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Missing bundled test model");
			auth.setRuntimeApiKey(model.provider, "test-only-key");
			await Bun.write(
				path.join(f.agentDir, "config.yml"),
				JSON.stringify({
					recipe: { enabled: false },
					compaction: { enabled: false },
					retry: { enabled: false },
					tools: { discoveryMode: "off" },
					modelRoles: { default: `${model.provider}/${model.id}` },
				}),
			);
			const legacyAttestation = await attestEmbeddedLegacyTakeover({
				...f,
				snapshotDigest: expected.snapshotDigest,
				acknowledged: true,
			});
			const opened = await createEmbeddedAgentSession({
				cwd: f.cwd,
				agentDir: f.agentDir,
				authStorage: auth,
				model,
				storage: { directory: f.root, file: f.file },
				native: { expected, ownerPolicy: { kind: "exclusive_native", expected, legacyAttestation } },
				disableExtensionDiscovery: true,
				extensions: [],
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMcpAutoload: false,
				enableLsp: false,
				skipPythonPreflight: true,
				deferOptionalModelRefresh: true,
				deferMemoryBackendStartup: true,
				notificationHostModeSupported: false,
				sdkHostModeSupported: false,
				toolNames: ["read"],
			});
			if (opened.kind !== "opened")
				throw new Error(
					`Expected real native runtime: ${JSON.stringify({ kind: opened.kind, reason: "reason" in opened ? opened.reason : undefined, error: "error" in opened ? opened.error : undefined })}`,
				);
			const manager = opened.result.session.sessionManager;
			expect(() => opened.result.session.dispose({ strictCloseAttempts: 1 })).toThrow(
				"Native disposal requires registry termination authorization",
			);
			expect(manager.getStrictCloseState().kind).toBe("none_started");
			const transport = createMockModel({ handler: { content: ["local native answer"] } });
			opened.result.session.agent.streamFn = transport.stream;
			await opened.result.session.prompt("native local prompt");
			await opened.result.session.waitForIdle();
			await opened.result.session.awaitSessionSettlement();
			expect(transport.calls).toHaveLength(1);
			const preparation = await prepareEmbeddedDisconnect(opened.handle, opened.op);
			if (!preparation.inventory) throw new Error("Expected actual native owned-work inventory");
			expect(preparation.inventory.pendingRequests.status).toBe("available");
			expect(preparation.inventory.blockers).toEqual([]);
			const consent = consentEmbeddedDisconnect(opened.handle, preparation, {
				stopAndJoin: true,
				work: { inventory: preparation.inventory, targets: [] },
			});
			if (!consent) throw new Error("Expected exact registry consent");
			const closure = !closureAvailable
				? spyOn(manager, "getResumeClosureEvidence").mockResolvedValue(undefined)
				: undefined;
			try {
				const final = await terminateEmbeddedAgentSession(opened.handle, { op: opened.op, consent });
				expect(manager.getStrictCloseState().kind).toBe("closed");
				expect(final.receipt.routing.action).toBe("POST_READONLY");
				expect(final.receipt.terminalDisposition.kind).toBe(closureAvailable ? "retired" : "retained_after_close");
				const bytes = await Bun.file(f.file).text();
				const repeated = await terminateEmbeddedAgentSession(opened.handle, { op: opened.op });
				expect(repeated.receipt.routing.action).toBe("POST_READONLY");
				expect(await Bun.file(f.file).text()).toBe(bytes);
			} finally {
				closure?.mockRestore();
			}
		});
	it("requires interpretation of legacy branches without factory, writer, catalog or agentDir effects", async () => {
		const f = await fixture([user("a", null), user("b", null)]);
		const expected = { snapshotDigest: f.resolution.checkpoint.snapshotDigest, resolved: f.resolution.checkpoint };
		const before = await Bun.file(f.file).text();
		let factories = 0;
		const createSession = async (_options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
			factories++;
			throw new Error("Factory must not run");
		};
		const result = await createEmbeddedAgentSession({
			cwd: f.cwd,
			agentDir: f.agentDir,
			storage: { directory: f.root, file: f.file },
			native: { expected, ownerPolicy: { kind: "exclusive_native", expected } },
			createSession,
		});
		expect(result.kind).toBe("selector");
		expect(factories).toBe(0);
		expect(await Bun.file(f.file).text()).toBe(before);
		expect(await fs.readdir(f.root)).toEqual(["project", "selected.jsonl"]);
	});

	it("refuses changed raw bytes against the consented checkpoint before any factory or writer", async () => {
		const f = await fixture([user("a", null)]);
		const expected = { snapshotDigest: f.resolution.checkpoint.snapshotDigest, resolved: f.resolution.checkpoint };
		await Bun.write(f.file, (await Bun.file(f.file).text()) + JSON.stringify(user("b", "a")) + "\n");
		const before = await Bun.file(f.file).text();
		let factories = 0;
		const result = await createEmbeddedAgentSession({
			cwd: f.cwd,
			agentDir: f.agentDir,
			storage: { directory: f.root, file: f.file },
			native: { expected, ownerPolicy: { kind: "exclusive_native", expected } },
			createSession: async () => {
				factories++;
				throw new Error("must not build");
			},
		});
		expect(result).toMatchObject({ kind: "refused", reason: "stale_snapshot" });
		expect(factories).toBe(0);
		expect(await Bun.file(f.file).text()).toBe(before);
		expect(await fs.readdir(f.root)).toEqual(["project", "selected.jsonl"]);
	});

	it("owns an explicit null-root attempt before startup and never replays its IDs after startup failure", async () => {
		const f = await fixture([user("a", null)]);
		const expected = { snapshotDigest: f.resolution.checkpoint.snapshotDigest, resolved: f.resolution.checkpoint };
		const legacyAttestation = await attestEmbeddedLegacyTakeover({
			...f,
			snapshotDigest: expected.snapshotDigest,
			acknowledged: true,
		});
		let factories = 0;
		const result = await createEmbeddedAgentSession({
			cwd: f.cwd,
			agentDir: f.agentDir,
			storage: { directory: f.root, file: f.file },
			native: {
				expected,
				ownerPolicy: { kind: "exclusive_native", expected, legacyAttestation },
				selection: { snapshotDigest: expected.snapshotDigest, targetLeafId: null, op: "explicit-root" },
			},
			createSession: async () => {
				factories++;
				throw new Error("synthetic startup failure");
			},
		});
		if (result.kind !== "startup_failed")
			throw new Error(
				JSON.stringify(
					"selection" in result
						? {
								kind: result.kind,
								outcome: result.selection.outcome.kind,
								refusal: result.selection.refusal,
								durability: result.selection.receipt.durability,
								shape: result.selection.receipt.manifestShape,
								suffix: result.selection.receipt.commitment.suffixState,
								conflicts: result.selection.receipt.remainingConflict,
								routing: result.selection.receipt.routing,
							}
						: result,
				),
			);
		expect(result.kind).toBe("startup_failed");
		expect(factories).toBe(1);
		expect(result.op.plan.target).toBeNull();
		const bytes = await Bun.file(f.file).text();
		const final = await terminateEmbeddedAgentSession(result.handle, { op: result.op });
		expect(final.receipt.routing.action).toBe("POST_READONLY");
		expect(await Bun.file(f.file).text()).toBe(bytes);
		expect(factories).toBe(1);
	});

	it("applies physical header patches through the canonical parser while retaining raw digest binding", async () => {
		const f = await fixture([user("a", null), { type: "header_patch", patch: { title: "renamed" } }]);
		expect(f.resolution.checkpoint).toMatchObject({
			kind: "tail_unambiguous",
			headerId: "selected",
			leafEntryId: "a",
			authority: "none",
		});
		const before = await fs.readdir(f.root);
		expect(resolveEmbeddedResumeCheckpoint(f.file)).toEqual(f.resolution);
		expect(await fs.readdir(f.root)).toEqual(before);
	});
});
