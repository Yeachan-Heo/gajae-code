import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	ManagedCommittedMutationError,
	ManagedLockTestHooks,
	ManagedSessionDescendantStore,
} from "../src/session/internal/managed-session-storage";
import { ManagedSessionReleaseError } from "../src/session/internal/managed-session-transaction";
import type { CustomMessage } from "../src/session/messages";
import {
	associateSessionMessageObservationId,
	associateSessionMessageViewportAnchorId,
	getSessionMessageEntryId,
	getSessionMessageObservationId,
	getSessionMessageViewportAnchorId,
	reconcileUncertainAppend,
	SessionManager,
} from "../src/session/session-manager";

const roots: string[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	ManagedLockTestHooks.afterReleaseDurable = undefined;
	for (const manager of managers.splice(0)) await manager.closeStrict().catch(() => undefined);
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });

async function sharedSession() {
	const root = await fs.mkdtemp(path.join(import.meta.dirname, ".tmp-shared-outcome-"));
	roots.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const writer = SessionManager.create(cwd, destination);
	managers.push(writer);
	const anchor = writer.appendMessage(user("anchor"));
	await writer.ensureOnDisk();
	const file = writer.getSessionFile()!;
	const manager = await SessionManager.open(file, destination);
	managers.push(manager);
	return { manager, file, anchor };
}

async function records(file: string) {
	return (await Bun.file(file).text())
		.trim()
		.split("\n")
		.map(line => JSON.parse(line));
}

describe("shared publication uncertain outcomes", () => {
	it("releases admission when input snapshotting throws before staging", async () => {
		const { manager, file, anchor } = await sharedSession();
		const before = await Bun.file(file).text();
		const failure = new Error("snapshot input failure");
		const message = {
			role: "user" as const,
			content: [
				{
					type: "text" as const,
					get text(): string {
						throw failure;
					},
				},
			],
			timestamp: 2,
		};
		await expect(manager.appendMessageSharingSession(message)).rejects.toThrow(failure);
		expect(getSessionMessageEntryId(message)).toBeUndefined();
		expect(manager.getLeafId()).toBe(anchor);
		expect(await Bun.file(file).text()).toBe(before);
		await expect(manager.withDurableThinkingControl(async () => "admitted")).resolves.toBe("admitted");
	});

	it("owns nested input at invocation while preserving existing message identity", async () => {
		const { manager, file, anchor } = await sharedSession();
		const message = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "invocation-time" }],
			timestamp: 2,
		};
		associateSessionMessageObservationId(message, "existing-observation");
		associateSessionMessageViewportAnchorId(message, "existing-viewport-anchor");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const capture = manager.captureCommittedSnapshot.bind(manager);
		const spy = vi.spyOn(manager, "captureCommittedSnapshot").mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
			return capture();
		});
		const publication = manager.appendMessageSharingSession(message);
		try {
			await Promise.race([
				entered.promise,
				publication.then(() => {
					throw new Error("publication settled before the snapshot barrier");
				}),
			]);
			message.content[0].text = "caller mutation";
			associateSessionMessageObservationId(message, "later-observation");
			associateSessionMessageViewportAnchorId(message, "later-viewport-anchor");
			release.resolve();
			const outcome = await publication;
			if (outcome.kind !== "committed") throw new Error(`unexpected ${outcome.kind}`);
			const disk = (await records(file)).filter(entry => entry.id === outcome.id);
			expect(disk).toHaveLength(1);
			expect(disk[0].parentId).toBe(anchor);
			expect(disk[0].message.content).toEqual([{ type: "text", text: "invocation-time" }]);
			const resident = manager.getEntries().find(entry => entry.id === outcome.id);
			if (resident?.type !== "message" || resident.message.role !== "user")
				throw new Error("missing resident user message");
			expect(resident.message.content).toEqual([{ type: "text", text: "invocation-time" }]);
			expect(getSessionMessageEntryId(message)).toBe(outcome.id);
			// Observation IDs are first-write-wins; viewport anchors remain caller-mutable.
			expect(getSessionMessageObservationId(message)).toBe("existing-observation");
			expect(getSessionMessageViewportAnchorId(message)).toBe("later-viewport-anchor");
			expect(getSessionMessageEntryId(resident.message)).toBe(outcome.id);
			expect(getSessionMessageObservationId(resident.message)).toBe("existing-observation");
			expect(getSessionMessageViewportAnchorId(resident.message)).toBe("existing-viewport-anchor");
		} finally {
			release.resolve();
			await Promise.allSettled([publication]);
			spy.mockRestore();
		}
	});

	it("preserves literal own __proto__ JSON details through shared publication", async () => {
		const { manager, file, anchor } = await sharedSession();
		const detailsJson = '{"__proto__":{"inheritedMarker":"literal-data"},"control":{"value":"ordinary-data"}}';
		const details: Record<string, unknown> = JSON.parse(detailsJson);
		const protoValue = Object.getOwnPropertyDescriptor(details, "__proto__")?.value;
		const controlValue = details.control;
		const message: CustomMessage = {
			role: "custom",
			customType: "json-key-ownership",
			content: "literal JSON keys",
			display: false,
			details,
			timestamp: 2,
		};
		const callerBefore = JSON.stringify(message);
		const assertLiteralDetails = (value: unknown) => {
			if (value === null || typeof value !== "object") throw new Error("missing custom message details");
			expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
			expect("inheritedMarker" in value).toBe(false);
			expect(Object.hasOwn(value, "__proto__")).toBe(true);
			expect(Object.getOwnPropertyDescriptor(value, "__proto__")?.value).toEqual({
				inheritedMarker: "literal-data",
			});
			expect(value).toEqual(JSON.parse(detailsJson));
		};

		const outcome = await manager.appendMessageSharingSession(message);
		if (outcome.kind !== "committed") throw new Error(`unexpected ${outcome.kind}`);
		expect(JSON.stringify(message)).toBe(callerBefore);
		expect(message.details).toBe(details);
		expect(Object.getOwnPropertyDescriptor(details, "__proto__")?.value).toBe(protoValue);
		expect(details.control).toBe(controlValue);
		assertLiteralDetails(details);

		const disk = (await records(file)).filter(entry => entry.id === outcome.id);
		expect(disk).toHaveLength(1);
		expect(disk[0].parentId).toBe(anchor);
		expect(disk[0].message.role).toBe("custom");
		assertLiteralDetails(disk[0].message.details);
		const resident = manager.getEntries().find(entry => entry.id === outcome.id);
		if (resident?.type !== "message" || resident.message.role !== "custom")
			throw new Error("missing resident custom message");
		assertLiteralDetails(resident.message.details);
	});

	it("serializes published calls in invocation order while the first snapshot is held", async () => {
		const { manager, file, anchor } = await sharedSession();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const capture = manager.captureCommittedSnapshot.bind(manager);
		const spy = vi.spyOn(manager, "captureCommittedSnapshot").mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
			return capture();
		});
		const publications = [manager.appendMessageSharingSession(user("one"))];
		try {
			await Promise.race([
				entered.promise,
				publications[0].then(() => {
					throw new Error("publication settled before the snapshot barrier");
				}),
			]);
			publications.push(manager.appendMessageSharingSession(user("two")));
			release.resolve();
			const outcomes = await Promise.all(publications);
			const ids = outcomes.map(outcome => {
				if (outcome.kind !== "committed") throw new Error(`unexpected ${outcome.kind}`);
				return outcome.id;
			});
			const entries = (await records(file)).slice(2);
			expect(entries.map(entry => entry.message.content)).toEqual(["one", "two"]);
			expect(entries.map(entry => entry.id)).toEqual(ids);
			expect(entries.map(entry => entry.parentId)).toEqual([anchor, ids[0]]);
			expect(
				manager
					.getEntries()
					.slice(1)
					.map(entry => entry.id),
			).toEqual(ids);
			expect(manager.getLeafId()).toBe(ids[1]);
		} finally {
			release.resolve();
			await Promise.allSettled(publications);
			spy.mockRestore();
		}
	});

	for (const write of [false, true]) {
		it(`preserves the original ID when a storage append fails ${write ? "after" : "before"} writing`, async () => {
			const { manager, file, anchor } = await sharedSession();
			const before = await Bun.file(file).text();
			const original = ManagedSessionDescendantStore.prototype.appendExpectedIdentitySync;
			const message = user("attempt");
			let callerAttemptedId: string | undefined;
			let attemptedId: string | undefined;
			const spy = vi
				.spyOn(ManagedSessionDescendantStore.prototype, "appendExpectedIdentitySync")
				.mockImplementation(function (this: ManagedSessionDescendantStore, ...args: Parameters<typeof original>) {
					attemptedId = manager.getLeafId()!;
					callerAttemptedId = getSessionMessageEntryId(message);
					if (write) original.apply(this, args);
					throw new ManagedCommittedMutationError("append", new Error("injected uncertainty"));
				});
			const outcome = await manager.appendMessageSharingSession(message);
			spy.mockRestore();
			if (attemptedId === undefined) throw new Error("storage append was not reached");
			expect(callerAttemptedId).toBe(attemptedId);
			expect(getSessionMessageEntryId(message)).toBe(attemptedId);
			expect(outcome).toMatchObject({ kind: "unknown", id: attemptedId });
			if (outcome.kind !== "unknown") throw new Error("expected uncertainty");
			expect(manager.getLeafId()).toBe(attemptedId);
			const matching = (await records(file)).filter(entry => entry.id === attemptedId);
			expect(matching).toHaveLength(write ? 1 : 0);
			if (write) expect(matching[0].parentId).toBe(anchor);
			else expect(await Bun.file(file).text()).toBe(before);
			const read = await manager.captureCommittedSnapshot();
			expect(
				reconcileUncertainAppend({ outcome, read, sessionId: manager.getSessionId(), residentAttempt: "retained" }),
			).toEqual(
				write
					? { kind: "committed", id: attemptedId }
					: { kind: "indeterminate", reason: "resident_attempt_retained" },
			);
		});
	}

	it("does not call a rolled-back resident append rejected when disk already has its ID", async () => {
		const { manager, file, anchor } = await sharedSession();
		const original = ManagedSessionDescendantStore.prototype.appendExpectedIdentitySync;
		let attemptedId: string | undefined;
		vi.spyOn(ManagedSessionDescendantStore.prototype, "appendExpectedIdentitySync").mockImplementation(function (
			this: ManagedSessionDescendantStore,
			...args: Parameters<typeof original>
		) {
			attemptedId = manager.getLeafId()!;
			original.apply(this, args);
			throw new Error("post-write failure");
		});
		const outcome = await manager.appendMessageSharingSession(user("attempt"));
		expect(outcome).toMatchObject({ kind: "unknown", id: attemptedId });
		expect(manager.getLeafId()).toBe(anchor);
		const matching = (await records(file)).filter(entry => entry.id === attemptedId);
		expect(matching).toHaveLength(1);
		expect(matching[0].parentId).toBe(anchor);
	});

	it("does not claim commitment when the post-append snapshot cannot find the transcript", async () => {
		const { manager, file } = await sharedSession();
		const flush = manager.flush.bind(manager);
		let committedId: string | undefined;
		vi.spyOn(manager, "flush").mockImplementationOnce(async () => {
			await flush();
			committedId = manager.getLeafId()!;
			expect((await records(file)).filter(entry => entry.id === committedId)).toHaveLength(1);
			await fs.rm(file);
		});
		const outcome = await manager.appendMessageSharingSession(user("attempt"));
		if (committedId === undefined) throw new Error("flush did not observe a committed entry");
		expect(outcome).toMatchObject({ kind: "unknown", id: committedId });
		expect(manager.getLeafId()).toBe(committedId);
		expect(await Bun.file(file).exists()).toBe(false);
	});

	for (const boundary of ["flush", "snapshot", "release", "flush-and-release"] as const) {
		it(`keeps the committed ID when ${boundary} fails`, async () => {
			const { manager, file, anchor } = await sharedSession();
			const injected = new Error(`injected ${boundary}`);
			if (boundary === "flush" || boundary === "flush-and-release")
				vi.spyOn(manager, "flush").mockRejectedValueOnce(injected);
			if (boundary === "snapshot") {
				const original = manager.captureCommittedSnapshot.bind(manager);
				vi.spyOn(manager, "captureCommittedSnapshot")
					.mockImplementationOnce(original)
					.mockRejectedValueOnce(injected);
			}
			if (boundary === "release" || boundary === "flush-and-release")
				ManagedLockTestHooks.afterReleaseDurable = () => {
					throw injected;
				};
			const outcome = await manager.appendMessageSharingSession(user("attempt"));
			ManagedLockTestHooks.afterReleaseDurable = undefined;
			vi.restoreAllMocks();
			if (outcome.kind !== "unknown") throw new Error(`expected uncertainty, got ${outcome.kind}`);
			expect(outcome.id).toBe(manager.getLeafId()!);
			if (boundary === "release" || boundary === "flush-and-release")
				expect(outcome.error).toBeInstanceOf(ManagedSessionReleaseError);
			else expect(outcome.error).toBe(injected);
			const matching = (await records(file)).filter(entry => entry.id === outcome.id);
			expect(matching).toHaveLength(1);
			expect(matching[0].parentId).toBe(anchor);
			expect(matching[0].message.content).toBe("attempt");
			const read = await manager.captureCommittedSnapshot();
			expect(
				reconcileUncertainAppend({ outcome, read, sessionId: manager.getSessionId(), residentAttempt: "retained" }),
			).toEqual({ kind: "committed", id: outcome.id });
		});
	}
});
