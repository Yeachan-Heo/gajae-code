import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { createEmbeddedAgentSession } from "../src/sdk/embedding";
import {
	consentEmbeddedDisconnect,
	currentEmbeddedResumeOperation,
	type NativeEmbeddedOpenResult,
	prepareEmbeddedDisconnect,
	reconcileEmbeddedResumeCheckpoint,
	terminateEmbeddedAgentSession,
} from "../src/sdk/native-embedding";
import { AuthStorage } from "../src/session/auth-storage";

type Opened = Extract<NativeEmbeddedOpenResult, { kind: "opened" }>;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-model-promotion-")));
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd);
	const auth = await AuthStorage.create(path.join(agentDir, "auth.db"));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Missing bundled fixture model");
	auth.setRuntimeApiKey(model.provider, "test-only-key");
	await Bun.write(
		path.join(agentDir, "config.yml"),
		JSON.stringify({
			recipe: { enabled: false },
			compaction: { enabled: false },
			retry: { enabled: false },
			tools: { discoveryMode: "off" },
			modelRoles: { default: `${model.provider}/${model.id}` },
		}),
	);
	const opened = await createEmbeddedAgentSession({
		cwd,
		agentDir,
		authStorage: auth,
		model,
		storage: { directory: path.join(root, "sessions") },
		native: { create: true, ownerPolicy: { kind: "exclusive_native" } },
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
	if (opened.kind !== "opened") throw new Error(`Expected native open, got ${opened.kind}`);
	cleanups.push(async () => {
		if (opened.result.session.sessionManager.getStrictCloseState().kind === "none_started") {
			const op = currentEmbeddedResumeOperation(opened.handle);
			const preparation = await prepareEmbeddedDisconnect(opened.handle, op);
			if (!preparation.inventory) throw new Error("Missing native work inventory");
			const consent = consentEmbeddedDisconnect(opened.handle, preparation, {
				stopAndJoin: true,
				work: { inventory: preparation.inventory, targets: [] },
			});
			if (!consent) throw new Error("Missing native termination consent");
			await terminateEmbeddedAgentSession(opened.handle, { op, consent });
		}
		auth.close();
		await fs.rm(root, { recursive: true, force: true });
	});
	return { opened, model };
}

describe("native explicit-storage default model promotion", () => {
	it("explains every promoted entry and the resident tip across replaced transcript inodes", async () => {
		const { opened, model } = await fixture();
		const manager = opened.result.session.sessionManager;
		expect(manager.isManagedDestination()).toBe(false);
		const file = manager.getSessionFile();
		if (!file) throw new Error("Missing native transcript");
		const originalIds = new Set(manager.getEntries().map(entry => entry.id));
		const op = currentEmbeddedResumeOperation(opened.handle);
		const baseline = await reconcileEmbeddedResumeCheckpoint(opened.handle, { op, mode: "verify" });
		const initialSuffixIds = baseline.receipt.residentSuffix.map(entry => entry.id);

		for (let selection = 0; selection < 2; selection++) {
			const before = await fs.stat(file, { bigint: true });
			const selected = await opened.runtime.model.setDefaultModelSelection(model, undefined);
			expect(selected.kind).toBe("applied");
			const after = await fs.stat(file, { bigint: true });
			expect(after.ino).not.toBe(before.ino);
			const promotedIds = manager.getEntries().filter(entry => !originalIds.has(entry.id)).map(entry => entry.id);
			expect(promotedIds.length).toBeGreaterThan(0);
			const ownedSuffixIds = [...initialSuffixIds, ...promotedIds];

			const observed = await reconcileEmbeddedResumeCheckpoint(opened.handle, { op, mode: "verify" });
			expect(observed.receipt.outcome).not.toBe("unknown");
			expect(observed.receipt.residentTip).toBe(manager.getLeafId());
			expect(observed.receipt.residentSuffix.map(entry => entry.id)).toEqual(ownedSuffixIds);
			expect(
				observed.receipt.residentSuffix
					.filter(entry => promotedIds.includes(entry.id))
					.every(entry => entry.kind === "retainedLocal"),
			).toBe(true);

			const repaired = await reconcileEmbeddedResumeCheckpoint(opened.handle, { op, mode: "repairDurability" });
			expect(repaired.receipt.outcome).toBe("committed");
			expect(repaired.receipt.commitment.continueEligible).toBe(true);
			expect(repaired.receipt.residentTip).toBe(manager.getLeafId());
			expect(repaired.receipt.finalPublishedTip).toBe(manager.getLeafId());
			expect(repaired.receipt.debt.retainedLocalIds).toEqual([
				...baseline.receipt.debt.retainedLocalIds,
				...promotedIds,
			]);
			expect(repaired.receipt.commitment.dependentsMissing).toEqual([]);
			expect(repaired.receipt.residentSuffix.every(entry => entry.state === "published_with_D")).toBe(true);
		}
	});

	for (const mutation of ["replace_inode", "append_foreign_entry"] as const)
		it(`still refuses external ${mutation} after a proven promotion`, async () => {
			const { opened, model } = await fixture();
			const manager = opened.result.session.sessionManager;
			const file = manager.getSessionFile();
			if (!file) throw new Error("Missing native transcript");
			expect((await opened.runtime.model.setDefaultModelSelection(model, undefined)).kind).toBe("applied");
			const op = currentEmbeddedResumeOperation(opened.handle);
			const proven = await reconcileEmbeddedResumeCheckpoint(opened.handle, { op, mode: "repairDurability" });
			expect(proven.receipt.commitment.continueEligible).toBe(true);
			if (mutation === "replace_inode") {
				const replacement = `${file}.foreign`;
				await Bun.write(replacement, Bun.file(file));
				await fs.rename(replacement, file);
			} else {
				await fs.appendFile(
					file,
					`${JSON.stringify({
						type: "custom",
						id: "foreign-model-selection",
						parentId: manager.getLeafId(),
						timestamp: "0",
						customType: "foreign",
						data: {},
					})}\n`,
				);
			}
			const bytes = await Bun.file(file).text();
			const refused = await reconcileEmbeddedResumeCheckpoint(opened.handle, { op, mode: "repairDurability" });
			expect(refused.receipt.outcome).toBe("unknown");
			expect(refused.receipt.commitment.continueEligible).toBe(false);
			expect(await Bun.file(file).text()).toBe(bytes);
		});
});
