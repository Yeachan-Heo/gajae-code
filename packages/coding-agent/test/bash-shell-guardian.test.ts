import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import type { Process as NativeProcess } from "@gajae-code/natives";
import {
	authenticateOwnershipRecord,
	createDarwinAncestryTracker,
	extendOwnedDarwinAncestry,
	parseOwnershipRecord,
	retainOwnedProcess,
} from "../src/exec/bash-shell-guardian";

type ProcessDouble = { pid: number; incarnation: string; children: () => NativeProcess[] };

/** Typed double for the members of the native Process contract the guardian reads. */
function processDouble(pid: number, incarnation: string, children: () => NativeProcess[] = () => []): NativeProcess {
	const double: ProcessDouble = { pid, incarnation, children };
	return double as unknown as NativeProcess;
}

/** Process lookup over a fixed set of live doubles, standing in for the native table. */
function lookupOf(...live: NativeProcess[]): (pid: number) => NativeProcess | undefined {
	return pid => live.find(processRef => processRef.pid === pid);
}

type Observation = { status: "present" | "absent" | "unknown"; incarnation?: string };

/** Native observation over the same doubles: present with its incarnation, else absent. */
function observeOf(...live: NativeProcess[]): (pid: number) => Observation {
	return pid => {
		const found = live.find(processRef => processRef.pid === pid);
		return found ? { status: "present", incarnation: found.incarnation } : { status: "absent" };
	};
}

/**
 * Tests for bash-shell-guardian ownership tracking and Darwin ancestry tracking.
 */
describe("bash-shell-guardian", () => {
	describe("parseOwnershipRecord", () => {
		it("parses valid ownership records", () => {
			const record = parseOwnershipRecord(
				JSON.stringify({
					pid: 1234,
					incarnation: "uuid-abc",
					darwinUniqueId: "9876543210",
					signature: "abcd1234",
				}),
			);
			expect(record).toEqual({
				pid: 1234,
				incarnation: "uuid-abc",
				darwinUniqueId: "9876543210",
				signature: "abcd1234",
			});
		});

		it("parses records without darwinUniqueId (incarnation-only)", () => {
			const record = parseOwnershipRecord(
				JSON.stringify({
					pid: 1234,
					incarnation: "uuid-abc",
					signature: "abcd1234",
				}),
			);
			expect(record).toEqual({
				pid: 1234,
				incarnation: "uuid-abc",
				signature: "abcd1234",
			});
		});

		it("rejects invalid JSON", () => {
			expect(parseOwnershipRecord("not json")).toBeUndefined();
		});

		it("rejects records with missing required fields", () => {
			expect(
				parseOwnershipRecord(
					JSON.stringify({
						pid: 1234,
						// missing incarnation
						signature: "abcd1234",
					}),
				),
			).toBeUndefined();
		});

		it("rejects records with invalid darwinUniqueId (non-numeric)", () => {
			expect(
				parseOwnershipRecord(
					JSON.stringify({
						pid: 1234,
						incarnation: "uuid-abc",
						darwinUniqueId: "not-a-number",
						signature: "abcd1234",
					}),
				),
			).toBeUndefined();
		});
	});

	describe("authenticateOwnershipRecord", () => {
		const token = "ledger-token";
		const sign = (pid: number, incarnation: string, uniqueId: string) =>
			createHmac("sha256", token).update(`${pid}:${incarnation}:${uniqueId}`).digest("hex");

		it("authenticates an incarnation-only record on every platform", () => {
			const line = JSON.stringify({ pid: 1234, incarnation: "uuid-abc", signature: sign(1234, "uuid-abc", "") });
			const authenticated = authenticateOwnershipRecord(line, token);
			expect(authenticated).toBeDefined();
			expect(authenticated?.darwinUniqueId).toBeUndefined();
		});

		it("settles a record whose process is confirmed gone instead of keeping it pending", () => {
			// Spawn and reap a real child so its pid is confirmed absent, not unknown.
			const child = Bun.spawnSync(["true"]);
			const pid = child.pid;
			const line = JSON.stringify({ pid, incarnation: "gone", signature: sign(pid, "gone", "") });
			const authenticated = authenticateOwnershipRecord(line, token);
			expect(authenticated).toBeDefined();
			expect(authenticated?.pending).toBeUndefined();
			expect(authenticated?.processRef).toBeUndefined();
		});

		it("binds the Darwin unique id into the signature", () => {
			const signature = sign(1234, "uuid-abc", "");
			const forged = JSON.stringify({ pid: 1234, incarnation: "uuid-abc", darwinUniqueId: "42", signature });
			expect(authenticateOwnershipRecord(forged, token)).toBeUndefined();

			const line = JSON.stringify({
				pid: 1234,
				incarnation: "uuid-abc",
				darwinUniqueId: "42",
				signature: sign(1234, "uuid-abc", "42"),
			});
			expect(authenticateOwnershipRecord(line, token)?.darwinUniqueId).toBe(42n);
		});
	});

	describe("retainOwnedProcess", () => {
		it("retains a process by pid:incarnation key", () => {
			const owned = new Map<string, NativeProcess>();
			const processRef = processDouble(1234, "uuid-abc");
			const result = retainOwnedProcess(owned, processRef);
			expect(result).toBe(true);
			expect(owned.get("1234:uuid-abc")).toBe(processRef);
		});

		it("returns false if process pid matches guardian pid", () => {
			const owned = new Map<string, NativeProcess>();
			const processRef = processDouble(process.pid, "uuid-abc");
			const result = retainOwnedProcess(owned, processRef);
			expect(result).toBe(false);
			expect(owned.size).toBe(0);
		});

		it("allows overwriting process with same key", () => {
			const owned = new Map<string, NativeProcess>();
			const processRef1 = processDouble(1234, "uuid-abc");
			const processRef2 = processDouble(1234, "uuid-abc");
			retainOwnedProcess(owned, processRef1);
			retainOwnedProcess(owned, processRef2);
			expect(owned.size).toBe(1);
			expect(owned.get("1234:uuid-abc")).toBe(processRef2);
		});
	});

	describe("extendOwnedDarwinAncestry", () => {
		it("extends ancestry chain using parent-child relationships", () => {
			const knownUniqueIds = new Set<bigint>([BigInt(100)]);
			const candidates = new Map<number, { uniqueId: bigint; parentUniqueId: bigint }>([
				[1001, { uniqueId: BigInt(101), parentUniqueId: BigInt(100) }],
				[1002, { uniqueId: BigInt(102), parentUniqueId: BigInt(101) }],
				[1003, { uniqueId: BigInt(103), parentUniqueId: BigInt(200) }], // unrelated
			]);
			const added = extendOwnedDarwinAncestry(knownUniqueIds, candidates);
			expect(added).toEqual([1001, 1002]);
			expect(knownUniqueIds).toEqual(new Set([BigInt(100), BigInt(101), BigInt(102)]));
		});

		it("handles empty candidates", () => {
			const knownUniqueIds = new Set<bigint>([BigInt(100)]);
			const candidates = new Map<number, { uniqueId: bigint; parentUniqueId: bigint }>();
			const added = extendOwnedDarwinAncestry(knownUniqueIds, candidates);
			expect(added).toEqual([]);
		});

		it("returns empty array if no candidates match known IDs", () => {
			const knownUniqueIds = new Set<bigint>([BigInt(100)]);
			const candidates = new Map<number, { uniqueId: bigint; parentUniqueId: bigint }>([
				[1001, { uniqueId: BigInt(200), parentUniqueId: BigInt(201) }],
			]);
			const added = extendOwnedDarwinAncestry(knownUniqueIds, candidates);
			expect(added).toEqual([]);
		});
	});

	describe("Darwin ancestry tracker (injected identity and process lookup)", () => {
		const noUniqueIdentity = (): undefined => undefined;

		it("retains incarnation-only records when the unique-id query is denied", () => {
			const processRef = processDouble(12345, "test-incarnation");
			const owned = new Map<string, NativeProcess>();
			const tracker = createDarwinAncestryTracker(owned, {
				uniqueIdentity: noUniqueIdentity,
				fromPid: lookupOf(processRef),
				observe: observeOf(processRef),
			});
			if (!tracker) return; // Darwin-only tracker.
			expect(tracker.track(processRef)).toBe(true);
			expect(owned.get("12345:test-incarnation")).toBe(processRef);
			tracker.close();
		});

		it("does not retain a record whose pid was reused after authentication", () => {
			const recorded = processDouble(12345, "recorded");
			const owned = new Map<string, NativeProcess>();
			const tracker = createDarwinAncestryTracker(owned, {
				uniqueIdentity: noUniqueIdentity,
				fromPid: lookupOf(processDouble(12345, "replacement")),
				observe: observeOf(processDouble(12345, "replacement")),
			});
			if (!tracker) return;
			expect(tracker.track(recorded)).toBe(true);
			expect(owned.size).toBe(0);
			tracker.close();
		});

		it("keeps a record as an anchor when the post-query lookup is inconclusive", () => {
			const processRef = processDouble(12345, "recorded");
			const owned = new Map<string, NativeProcess>();
			const tracker = createDarwinAncestryTracker(owned, {
				// A unique id is returned but cannot be vouched for without a conclusive
				// incarnation check, so it must not be seeded.
				uniqueIdentity: () => ({ uniqueId: 77n, parentUniqueId: 0n }),
				fromPid: () => null,
				observe: () => ({ status: "unknown" }),
			});
			if (!tracker) return;
			expect(tracker.track(processRef)).toBe(true);
			expect(owned.get("12345:recorded")).toBe(processRef);
			tracker.close();
		});

		it("ignores an anchor's child snapshot once the anchor pid was reused", () => {
			const stranger = processDouble(200, "stranger");
			let reused = false;
			// The anchor is live and valid when tracked; its pid is reused while
			// children() takes the snapshot, which therefore lists a stranger's child.
			const anchor = processDouble(100, "anchor", () => {
				reused = true;
				return [stranger];
			});
			const current = (pid: number): NativeProcess =>
				pid === 100 ? (reused ? processDouble(100, "replacement") : anchor) : stranger;
			const owned = new Map<string, NativeProcess>();
			const tracker = createDarwinAncestryTracker(owned, {
				uniqueIdentity: () => undefined,
				fromPid: current,
				observe: pid => ({ status: "present", incarnation: current(pid).incarnation }),
			});
			if (!tracker) return;
			expect(tracker.track(anchor)).toBe(true);
			expect(owned.get("100:anchor")).toBe(anchor);
			expect(owned.has("200:stranger")).toBe(false);
			tracker.close();
		});

		it("anchors descendants of an incarnation-only record by their unique ids (#6086)", () => {
			const ids = new Map<number, { uniqueId: bigint; parentUniqueId: bigint }>([
				[101, { uniqueId: 9001n, parentUniqueId: 0n }],
			]);
			const grandchild = processDouble(101, "g");
			let spawned = false;
			const child = processDouble(100, "c", () => (spawned ? [grandchild] : []));
			const owned = new Map<string, NativeProcess>();
			const tracker = createDarwinAncestryTracker(owned, {
				uniqueIdentity: pid => ids.get(pid),
				fromPid: lookupOf(child, grandchild),
				observe: observeOf(child, grandchild),
			});
			if (!tracker) return;
			expect(tracker.track(child)).toBe(true);
			expect(owned.has("101:g")).toBe(false);
			// A descendant forked after the ledger record was read is picked up by the
			// next poll, which re-walks the incarnation-only anchor.
			spawned = true;
			tracker.poll();
			expect(owned.get("101:g")).toBe(grandchild);
			tracker.close();
		});

		it("trackGuardian() requires a unique id", () => {
			const processRef = processDouble(12345, "test-incarnation");
			const owned = new Map<string, NativeProcess>();
			const tracker = createDarwinAncestryTracker(owned, {
				uniqueIdentity: noUniqueIdentity,
				fromPid: lookupOf(processRef),
			});
			if (!tracker) return;
			expect(tracker.trackGuardian(processRef)).toBe(false);
			expect(owned.size).toBe(0);
			expect(tracker.trackGuardian(processRef, 999n)).toBe(true);
			expect(owned.get("12345:test-incarnation")).toBe(processRef);
			tracker.close();
		});
	});
});
