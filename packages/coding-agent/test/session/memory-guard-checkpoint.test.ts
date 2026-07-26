import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import type {
	MemoryGuardParticipantDescriptorV1,
	MemoryGuardSessionManagerCheckpointV1,
} from "@gajae-code/coding-agent/session/memory-guard-checkpoint-participant";
import { memoryGuardCanonicalJson } from "@gajae-code/coding-agent/session/memory-guard-checkpoint-participant";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { openRecoveryFsRoot, type RecoveryFsRoot } from "@gajae-code/natives";

const tempRoots: string[] = [];
const authStores: AuthStorage[] = [];

async function makeTempRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-memory-guard-checkpoint-"));
	tempRoots.push(root);
	return root;
}

function participantFromCheckpoint(
	checkpoint: MemoryGuardSessionManagerCheckpointV1,
): MemoryGuardParticipantDescriptorV1 {
	return {
		ordinal: 0,
		checkpoint: checkpoint.blob_authority,
		revisions: checkpoint.revisions,
		session_id: checkpoint.session_id,
		session_name: checkpoint.session_name,
		transcript: checkpoint.transcript,
	};
}

afterEach(async () => {
	for (const store of authStores.splice(0)) store.close();
	for (const root of tempRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("memory guard checkpoint export/restore", () => {
	it("exports the closed checkpoint and restores a staged recovery session", async () => {
		const root = await makeTempRoot();
		const checkpointRoot = path.join(root, "checkpoint-root");
		const restoreRoot = path.join(root, "restore-root");
		const manager = await SessionManager.open(path.join(root, "sessions", "checkpoint.jsonl"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		let authority: RecoveryFsRoot | undefined;
		try {
			manager.appendMessage({ role: "user", content: "hello checkpoint", timestamp: 0 });
			await manager.setSessionName("checkpoint-session", "user");
			await manager.flush();
			const lease = manager.acquireMemoryGuardParticipantIngressLease();
			const checkpoint = await manager.createMemoryGuardCheckpoint({ ingressLease: lease, checkpointRoot });
			lease.release();
			expect(checkpoint).toEqual({
				blob_authority: {
					kind: "checkpoint_blob_tree_v1",
					manifest_relative_path: `participants/${checkpoint.session_id}/blob-manifest.json`,
					manifest_sha256: checkpoint.blob_authority.manifest_sha256,
					root_relative_path: `participants/${checkpoint.session_id}/blobs`,
				},
				revisions: checkpoint.revisions,
				schema_version: 1,
				session_id: checkpoint.session_id,
				session_name: "checkpoint-session",
				transcript: checkpoint.transcript,
			});
			expect(
				await Bun.file(
					path.join(checkpointRoot, `participants/${checkpoint.session_id}/session-manager.json`),
				).text(),
			).toBe(memoryGuardCanonicalJson(checkpoint));
			expect(
				await Bun.file(
					path.join(checkpointRoot, `participants/${checkpoint.session_id}/blob-manifest.json`),
				).text(),
			).toBe('{"entries":[],"schema_version":1}\n');
			if (process.platform !== "linux") return;
			authority = openRecoveryFsRoot(checkpointRoot);
			const restored = await SessionManager.restoreMemoryGuardCheckpoint({
				incidentAuthority: authority,
				participant: participantFromCheckpoint(checkpoint),
				checkpoint,
				destination: restoreRoot,
			});
			expect(restored.kind).toBe("staged");
			if (restored.kind !== "staged") return;
			expect(restored.manager.getSessionId()).toBe(checkpoint.session_id);
			expect(restored.manager.getSessionName()).toBe("checkpoint-session");
			const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
			authStores.push(authStorage);
			authStorage.setRuntimeApiKey("anthropic", "test-key");
			const session = await AgentSession.restoreFromMemoryGuardCheckpoint({
				agent: new Agent({
					initialState: {
						model,
						systemPrompt: ["Test"],
						tools: [],
						messages: restored.manager.buildSessionContext().messages,
					},
				}),
				settings: Settings.isolated({}),
				modelRegistry: new ModelRegistry(authStorage),
				staged: restored,
			});
			expect(session.kind).toBe("staged");
			if (session.kind !== "staged") return;
			expect(session.session.recoveryHydrationContext).toBe(restored.hydrationContext);
			await session.session.promoteRecoveryHydrationAfterOwnershipReadyFence(session.promotionFence);
			expect(session.session.recoveryHydrationContext).toBeUndefined();
			await session.session.dispose();
		} finally {
			authority?.close();
			await manager.close();
		}
	});

	it("fails closed when the retained transcript no longer matches the checkpoint descriptor", async () => {
		const root = await makeTempRoot();
		const checkpointRoot = path.join(root, "checkpoint-root");
		const manager = await SessionManager.open(path.join(root, "sessions", "checkpoint.jsonl"));
		manager.appendMessage({ role: "user", content: "hello checkpoint", timestamp: 0 });
		await manager.flush();
		const lease = manager.acquireMemoryGuardParticipantIngressLease();
		const checkpoint = await manager.createMemoryGuardCheckpoint({ ingressLease: lease, checkpointRoot });
		lease.release();
		await Bun.write(
			path.join(checkpointRoot, checkpoint.transcript.relative_path),
			'{"type":"session","id":"wrong-session","timestamp":"1970-01-01T00:00:00.000Z","cwd":"/tmp"}\n',
		);
		if (process.platform !== "linux") {
			await manager.close();
			return;
		}
		const authority = openRecoveryFsRoot(checkpointRoot);
		try {
			expect(
				await SessionManager.restoreMemoryGuardCheckpoint({
					incidentAuthority: authority,
					participant: participantFromCheckpoint(checkpoint),
					checkpoint,
					destination: path.join(root, "restore-root"),
				}),
			).toEqual({ kind: "blocked", reason: "transcript-mismatch" });
		} finally {
			authority.close();
			await manager.close();
		}
	});
});
