import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MasterDomainStore } from "../src/master/domain-store";
import { MasterSdk } from "../src/master/sdk";
import type { MasterProvider, ProviderEffectResultInput } from "../src/master/types";
import { TelegramMasterChannelWorker } from "../src/sdk/bus/telegram-master-channel-worker";

const roots: string[] = [];

async function makeStore(configuredProviders: readonly MasterProvider[]): Promise<MasterDomainStore> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-master-chat-"));
	roots.push(root);
	return await MasterDomainStore.create({
		masterName: "alpha",
		masterRootDir: path.join(root, "master"),
		configuredProviders,
		defaultWorkdir: process.cwd(),
	});
}

async function providerIdentity(store: MasterDomainStore, provider: MasterProvider) {
	const workerId = `${provider}-test-worker`;
	const registration = await store.registerProviderWorker({ provider, workerId });
	return { workerId, workerLeaseId: registration.leaseId };
}

async function leaseEffect(store: MasterDomainStore, provider: MasterProvider) {
	return await store.leaseProviderEffect({ provider, ...(await providerIdentity(store, provider)) });
}

async function reconcileEffect(store: MasterDomainStore, input: ProviderEffectResultInput) {
	return await store.reconcileProviderEffect({ ...input, ...(await providerIdentity(store, input.provider)) });
}

async function activate(
	store: MasterDomainStore,
	provider: MasterProvider,
	remoteChannelId = `${provider}-channel`,
): Promise<void> {
	const lease = await leaseEffect(store, provider);
	expect(lease?.kind).toBe("provision_channel");
	if (lease === null || lease.kind !== "provision_channel") throw new Error("missing provisioning lease");
	await reconcileEffect(store, {
		effectId: lease.effectId,
		intentId: lease.intentId,
		leaseId: lease.leaseId,
		provider,
		fence: lease.fence,
		nonce: lease.nonce,
		outcome: {
			effectKind: "provision_channel",
			status: "succeeded",
			remoteEffectId: `${provider}-create`,
			remoteChannelId,
			reconciled: true,
		},
	});
}

function decisionEvent(id: string) {
	return {
		type: "decision_logged" as const,
		payload: {
			decisionId: id,
			trigger: { kind: "daemon_recovery" as const, recoveryId: `recovery-${id}` },
			outcome: "follow_up" as const,
			reason: `decision ${id}`,
			doctrine: { revision: "r1", sha256: "a".repeat(64) },
			memory: { availability: "unavailable" as const, activityIds: [] },
		},
	};
}

afterEach(async () => {
	while (roots.length > 0) await fs.rm(roots.pop()!, { recursive: true, force: true });
});

describe("master provider channel authority", () => {
	test("zero, single, and both-provider availability follow at-least-one quorum", async () => {
		const zero = await makeStore([]);
		expect((await zero.readSnapshot()).status).toBe("channel_blocked");
		expect((await zero.readProviderHealth()).operational).toBe(false);

		const telegram = await makeStore(["telegram"]);
		await activate(telegram, "telegram");
		expect(await telegram.readProviderHealth()).toMatchObject({
			configuredProviders: ["telegram"],
			activeProviders: ["telegram"],
			operational: true,
		});

		const both = await makeStore(["telegram", "discord"]);
		await activate(both, "telegram");
		await activate(both, "discord");
		expect((await both.readProviderHealth()).activeProviders).toEqual(["telegram", "discord"]);
	}, 30_000);

	test("commits one ordered row per configured provider and continues through a healthy provider", async () => {
		const store = await makeStore(["telegram", "discord"]);
		await activate(store, "telegram");
		await activate(store, "discord");
		await store.appendEvent(decisionEvent("one"));
		const rows = (await store.readOutbox()).rows;
		expect(rows.map(row => `${row.provider}:${row.effectId}`)).toEqual([
			"telegram:present:telegram:alpha:event:3",
			"discord:present:discord:alpha:event:3",
		]);

		const discordLease = await leaseEffect(store, "discord");
		if (discordLease === null || discordLease.kind !== "present_event")
			throw new Error("missing Discord presentation lease");
		await reconcileEffect(store, {
			effectId: discordLease.effectId,
			intentId: discordLease.intentId,
			leaseId: discordLease.leaseId,
			provider: "discord",
			fence: discordLease.fence,
			nonce: discordLease.nonce,
			outcome: {
				effectKind: "present_event",
				status: "retryable",
				code: "transport_unavailable",
				retryAfterMs: null,
				message: "offline",
			},
		});
		const health = await store.readProviderHealth();
		expect(health.activeProviders).toContain("discord");
		expect(health.degradedProviders).toContain("discord");
		expect(health.operational).toBe(true);
		expect((await store.readChannels()).channels.find(channel => channel.provider === "discord")).toMatchObject({
			state: "active",
			deliveryHealth: "degraded",
		});
	}, 30_000);

	test("replays pending rows in provider event order and advances cursor only after exact reconcile", async () => {
		const store = await makeStore(["telegram"]);
		await activate(store, "telegram");
		await store.appendEvent(decisionEvent("first"));
		await store.appendEvent(decisionEvent("second"));
		const first = await leaseEffect(store, "telegram");
		if (first === null || first.kind !== "present_event") throw new Error("missing first lease");
		const wrongFence: ProviderEffectResultInput = {
			effectId: first.effectId,
			intentId: first.intentId,
			leaseId: first.leaseId,
			provider: "telegram",
			fence: first.fence + 1,
			nonce: first.nonce,
			outcome: {
				effectKind: "present_event",
				status: "succeeded",
				remoteEffectId: "remote",
				remoteMessageId: "message",
				reconciled: true,
			},
		};
		await expect(reconcileEffect(store, wrongFence)).rejects.toThrow(/fence|effect/i);
		await reconcileEffect(store, { ...wrongFence, fence: first.fence });
		expect((await store.readChannels()).receiptCursors.telegram).toBe(2);
		const second = await leaseEffect(store, "telegram");
		if (second === null || second.kind !== "present_event") throw new Error("missing second lease");
		expect(second.eventId).not.toBe(first.eventId);
		await reconcileEffect(store, {
			effectId: second.effectId,
			intentId: second.intentId,
			leaseId: second.leaseId,
			provider: "telegram",
			fence: second.fence,
			nonce: second.nonce,
			outcome: {
				effectKind: "present_event",
				status: "succeeded",
				remoteEffectId: "remote-2",
				remoteMessageId: "message-2",
				reconciled: true,
			},
		});
		expect((await store.readChannels()).receiptCursors.telegram).toBe(second.eventId.includes("event:4") ? 4 : 3);
	}, 30_000);

	test("restart preserves effect identity and duplicate results are idempotent while conflicts fail closed", async () => {
		const store = await makeStore(["telegram"]);
		await activate(store, "telegram");
		await store.appendEvent(decisionEvent("restart"));
		const lease = await leaseEffect(store, "telegram");
		if (lease === null || lease.kind !== "present_event") throw new Error("missing presentation lease");
		const restarted = await MasterDomainStore.open({ masterName: "alpha", masterRootDir: store.masterRootDir });
		const resumed = await leaseEffect(restarted, "telegram");
		expect(resumed).toBeNull();
		const result = {
			effectKind: "present_event" as const,
			status: "succeeded" as const,
			remoteEffectId: "remote",
			remoteMessageId: "message",
			reconciled: true,
		};
		const receipt = await reconcileEffect(restarted, {
			effectId: lease.effectId,
			intentId: lease.intentId,
			leaseId: lease.leaseId,
			provider: "telegram",
			fence: lease.fence,
			nonce: lease.nonce,
			outcome: result,
		});
		expect(receipt.disposition).toBe("recorded");
		expect(
			(
				await reconcileEffect(restarted, {
					effectId: lease.effectId,
					intentId: lease.intentId,
					leaseId: lease.leaseId,
					provider: "telegram",
					fence: lease.fence,
					nonce: lease.nonce,
					outcome: result,
				})
			).disposition,
		).toBe("already_recorded");
		await expect(
			reconcileEffect(restarted, {
				effectId: lease.effectId,
				intentId: lease.intentId,
				leaseId: lease.leaseId,
				provider: "telegram",
				fence: lease.fence,
				nonce: lease.nonce,
				outcome: {
					effectKind: "present_event",
					status: "terminal",
					code: "permission_denied",
					message: "conflict",
				},
			}),
		).rejects.toThrow(/conflict|effect|stale/i);
	}, 30_000);

	test("provider worker registration is leased and store is the only mutation authority", async () => {
		const store = await makeStore(["telegram"]);
		const registration = await store.registerProviderWorker({
			provider: "telegram",
			workerId: "worker-1",
			ttlMs: 1000,
		});
		expect(registration.state).toBe("registered");
		const effect = await store.leaseProviderEffect({
			provider: "telegram",
			workerId: "worker-1",
			workerLeaseId: registration.leaseId,
		});
		expect(effect?.kind).toBe("provision_channel");
		expect((await store.readProviderWorkerLeases()).length).toBe(1);
	}, 30_000);

	test("master SDK routes presentation receipts through the durable outbox owner", async () => {
		const store = await makeStore(["telegram"]);
		await activate(store, "telegram");
		await store.appendEvent(decisionEvent("sdk presentation"));
		const sdk = new MasterSdk({ stores: { alpha: store }, publishDiscovery: false });
		const hello = await sdk.handleClientFrame(
			{
				type: "provider_worker_hello",
				requestId: "hello",
				provider: "telegram",
				workerId: "sdk-worker",
			},
			"master-sdk-local",
		);
		expect(hello).toMatchObject({ type: "ack" });
		const registration = (await store.readProviderWorkerLeases()).find(lease => lease.workerId === "sdk-worker");
		if (registration === undefined) throw new Error("missing SDK worker registration");
		const effect = await store.leaseProviderEffect({
			provider: "telegram",
			workerId: registration.workerId,
			workerLeaseId: registration.leaseId,
		});
		if (effect === null || effect.kind !== "present_event") throw new Error("missing presentation effect");
		const response = await sdk.handleClientFrame(
			{
				type: "provider_effect_result",
				requestId: "result",
				effectId: effect.effectId,
				intentId: effect.intentId,
				leaseId: effect.leaseId,
				fence: effect.fence,
				nonce: effect.nonce,
				effectKind: "present_event",
				outcome: {
					effectKind: "present_event",
					status: "succeeded",
					remoteEffectId: "telegram-effect",
					remoteMessageId: "telegram-message",
					reconciled: true,
				},
			},
			"master-sdk-local",
		);
		expect(response).toMatchObject({
			type: "ack",
			operation: "provider_effect_result",
			result: { effectId: effect.effectId, nextState: "reconciled" },
		});
		expect((await store.readChannels()).receiptCursors.telegram).toBeGreaterThan(0);
	}, 30_000);
});

describe("claim mint idempotency", () => {
	test("replays the original authorization when an identical request retries at a later instant", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-master-claim-"));
		roots.push(root);
		let now = new Date("2026-08-12T00:00:00.000Z");
		const store = await MasterDomainStore.create({
			masterName: "alpha",
			masterRootDir: path.join(root, "master"),
			configuredProviders: ["telegram"],
			defaultWorkdir: process.cwd(),
			now: () => now,
		});
		await activate(store, "telegram");
		const request = {
			workerSessionId: "worker-claim-idem",
			requestedMasterName: "alpha",
			ingress: {
				kind: "provider" as const,
				provider: "telegram" as const,
				channelId: "telegram-channel",
				messageId: "message-1",
				actorId: "actor-1",
			},
			idempotencyKey: "claim-retry-1",
		};
		const first = await store.mintClaimAuthorization(request);

		// A lost acknowledgement makes the provider retry the identical frame later.
		// The server-generated expiry must not make that a conflict.
		now = new Date("2026-08-12T00:00:00.050Z");
		const replay = await store.mintClaimAuthorization(request);

		expect(replay.authorizationId).toBe(first.authorizationId);
		expect(replay.expiresAt).toBe(first.expiresAt);
	}, 30_000);

	test("still rejects a reused idempotency key that carries a different request", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-master-claim-conflict-"));
		roots.push(root);
		const store = await MasterDomainStore.create({
			masterName: "alpha",
			masterRootDir: path.join(root, "master"),
			configuredProviders: ["telegram"],
			defaultWorkdir: process.cwd(),
		});
		await activate(store, "telegram");
		const ingress = {
			kind: "provider" as const,
			provider: "telegram" as const,
			channelId: "telegram-channel",
			messageId: "message-1",
			actorId: "actor-1",
		};
		await store.mintClaimAuthorization({
			workerSessionId: "worker-claim-conflict",
			requestedMasterName: "alpha",
			ingress,
			idempotencyKey: "claim-conflict-1",
		});
		await expect(
			store.mintClaimAuthorization({
				workerSessionId: "worker-claim-conflict",
				requestedMasterName: "alpha",
				ingress: { ...ingress, messageId: "message-2" },
				idempotencyKey: "claim-conflict-1",
			}),
		).rejects.toThrow();
	}, 30_000);
});

describe("provider worker registration lifecycle", () => {
	test("a reconnecting provider daemon replaces its stale registration instead of queueing behind it", async () => {
		const store = await makeStore(["telegram"]);
		await activate(store, "telegram");
		const sdk = new MasterSdk({ stores: { alpha: store }, publishDiscovery: false });
		const hello = async (workerId: string) =>
			await sdk.handleClientFrame(
				{ type: "provider_worker_hello", requestId: `hello-${workerId}`, provider: "telegram", workerId },
				"master-sdk-local",
			);

		expect(await hello("worker-old")).toMatchObject({ type: "ack" });
		expect(sdk.providerWorkerKeysForTest()).toEqual(["telegram:worker-old"]);

		// A restarted daemon reconnects under a fresh random worker id. The dead
		// registration must not remain eligible for the durable effect lease.
		expect(await hello("worker-new")).toMatchObject({ type: "ack" });
		expect(sdk.providerWorkerKeysForTest()).toEqual(["telegram:worker-new"]);
	}, 30_000);

	test("closing a provider socket retires exactly that connection's registrations", async () => {
		const store = await makeStore(["telegram", "discord"]);
		await activate(store, "telegram");
		await activate(store, "discord");
		const sdk = new MasterSdk({ stores: { alpha: store }, publishDiscovery: false });
		await sdk.handleClientFrame(
			{ type: "provider_worker_hello", requestId: "h1", provider: "telegram", workerId: "tg-worker" },
			"conn-telegram",
		);
		await sdk.handleClientFrame(
			{ type: "provider_worker_hello", requestId: "h2", provider: "discord", workerId: "dc-worker" },
			"conn-discord",
		);
		expect(sdk.providerWorkerKeysForTest()).toEqual(["discord:dc-worker", "telegram:tg-worker"]);

		sdk.retireProviderConnectionForTest("conn-telegram");

		expect(sdk.providerWorkerKeysForTest()).toEqual(["discord:dc-worker"]);
	}, 30_000);
});

describe("Telegram leased provider effects", () => {
	function presentEffect(overrides: Record<string, unknown> = {}) {
		return {
			kind: "present_event" as const,
			effectId: "present:telegram:event-1",
			intentId: "intent-1",
			leaseId: "lease-1",
			masterName: "alpha",
			provider: "telegram" as const,
			fence: 1,
			nonce: "nonce-1",
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
			eventId: "event-1",
			bindingId: "binding-1",
			content: {
				text: "master update",
				workerSessionId: null,
				taskId: null,
				decisionId: null,
				memoryActivityId: null,
			},
			...overrides,
		};
	}

	test("fails closed instead of duplicating an unverifiable Telegram post", async () => {
		const calls: Array<{ method: string; opts?: { noRetry?: boolean } }> = [];
		const worker = new TelegramMasterChannelWorker({
			client: { onEffect: () => () => {}, submitEffectResult: async () => undefined } as never,
			chatId: "42",
			resolveRemoteChannelId: () => "900",
			// No findMessageByNonce: Telegram cannot correlate a post it may have accepted.
			provider: {
				chatId: "42",
				call: async (method: string, _body: unknown, opts?: { noRetry?: boolean }) => {
					calls.push({ method, opts });
					// Accepted, but with no usable message identifier.
					return { ok: true, result: {} };
				},
			} as never,
		});

		const frame = await worker.handleEffect(presentEffect() as never);

		expect(calls).toHaveLength(1);
		expect(frame.outcome).toMatchObject({ status: "terminal", code: "post_unverifiable" });
	}, 30_000);

	test("reports recoverable uncertainty when a nonce lookup can prove the post", async () => {
		const worker = new TelegramMasterChannelWorker({
			client: { onEffect: () => () => {}, submitEffectResult: async () => undefined } as never,
			chatId: "42",
			resolveRemoteChannelId: () => "900",
			provider: {
				chatId: "42",
				findMessageByNonce: async () => null,
				call: async () => ({ ok: true, result: {} }),
			} as never,
		});

		const frame = await worker.handleEffect(presentEffect() as never);

		expect(frame.outcome).toMatchObject({ status: "unknown", code: "post_uncertain" });
	}, 30_000);
});
