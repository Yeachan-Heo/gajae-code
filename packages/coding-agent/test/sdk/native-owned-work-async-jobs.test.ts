import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { createEmbeddedAgentSession } from "../../src/sdk/embedding";
import {
	consentEmbeddedDisconnect,
	type NativeEmbeddedOpenResult,
	prepareEmbeddedDisconnect,
	terminateEmbeddedAgentSession,
} from "../../src/sdk/native-embedding";
import { AuthStorage } from "../../src/session/auth-storage";

type Opened = Extract<NativeEmbeddedOpenResult, { kind: "opened" }>;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function disconnect(opened: Opened): Promise<void> {
	if (opened.result.session.sessionManager.getStrictCloseState().kind !== "none_started") return;
	const preparation = await prepareEmbeddedDisconnect(opened.handle, opened.op);
	if (!preparation.inventory) throw new Error("Missing native work inventory");
	const consent = consentEmbeddedDisconnect(opened.handle, preparation, {
		stopAndJoin: true,
		work: {
			inventory: preparation.inventory,
			targets: preparation.inventory.blockers.flatMap(blocker => (blocker.target ? [blocker.target] : [])),
		},
	});
	if (!consent) throw new Error("Missing native termination consent");
	await terminateEmbeddedAgentSession(opened.handle, { op: opened.op, consent });
}

async function fixture(asyncJobs?: "none") {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "gjc-native-async-jobs-")));
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
		// Child runtimes without an inherited manager genuinely have no job observation.
		parentTaskPrefix: "no-async-manager",
		storage: { directory: path.join(root, "sessions") },
		native: { create: true, ownerPolicy: { kind: "exclusive_native" } },
		...(asyncJobs === "none" ? { asyncJobs } : {}),
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
		await disconnect(opened);
		auth.close();
		await fs.rm(root, { recursive: true, force: true });
	});
	return opened;
}

describe("native owned work async job declaration", () => {
	it("retains unavailable job evidence when the host makes no declaration", async () => {
		const opened = await fixture();
		expect(opened.result.jobObservation).toBeUndefined();
		const preparation = await prepareEmbeddedDisconnect(opened.handle, opened.op);
		if (!preparation.inventory) throw new Error("Missing native work inventory");

		expect(preparation.inventory.jobs).toEqual({
			status: "unavailable",
			reason: "job_observation_unavailable",
		});
		expect(preparation.inventory.blockers).toContainEqual({
			kind: "unavailable",
			id: "jobs",
			reason: "job_observation_unavailable",
		});
	});

	it("proves an empty job set and retires when the host supplies no async job manager", async () => {
		const opened = await fixture("none");
		expect(opened.result.jobObservation).toBeUndefined();
		const preparation = await prepareEmbeddedDisconnect(opened.handle, opened.op);
		if (!preparation.inventory) throw new Error("Missing native work inventory");
		const inventory = preparation.inventory;

		expect(inventory.jobs).toEqual({ status: "not_applicable", reason: "no_async_job_manager" });
		expect(inventory.blockers.filter(blocker => blocker.id === "jobs")).toEqual([]);
		const consent = consentEmbeddedDisconnect(opened.handle, preparation, {
			stopAndJoin: true,
			work: {
				inventory,
				targets: inventory.blockers.flatMap(blocker => (blocker.target ? [blocker.target] : [])),
			},
		});
		if (!consent) throw new Error("Missing native termination consent");
		const receipt = await terminateEmbeddedAgentSession(opened.handle, { op: opened.op, consent });
		expect(receipt.receipt.terminalDisposition.kind).toBe("retired");
	});
});
