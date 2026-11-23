import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { isManagedGcLockRoleName } from "../src/session/internal/managed-session-scope";
import { managedSessionTransactionLockName } from "../src/session/internal/managed-session-transaction";

// GC inventory refuses any lock name it cannot classify and then aborts the whole
// scope, so every lock role has to be registered with it. This pins the contract
// between the transaction lease name and that registry: the name the transaction
// actually produces must be accepted, and unknown names must still be refused.

const digest = (seed: string) => createHash("sha256").update(seed, "utf8").digest("hex");

describe("managed GC lock role names", () => {
	it("accepts the transaction lease name produced for a real session", () => {
		const sessionId = "01a1b5b3-12fe-7136-9c85-ad1b859d6ca8";
		const leaseName = `${managedSessionTransactionLockName(sessionId)}.lock`;
		// Guard the shape assumption the registry relies on, not just the result.
		expect(leaseName.startsWith("session-transaction-v1-")).toBe(true);
		expect(leaseName).toHaveLength("session-transaction-v1-".length + 64 + ".lock".length);
		expect(isManagedGcLockRoleName(leaseName)).toBe(true);
	});

	it("keeps accepting the lock roles that predate the transaction", () => {
		expect(isManagedGcLockRoleName(`${digest("transcript")}.lock`)).toBe(true);
		expect(isManagedGcLockRoleName(`gc-retirement-${digest("scope")}.lock`)).toBe(true);
	});

	it("refuses names it cannot classify", () => {
		for (const name of [
			"session-transaction-v1-nothex.lock",
			`session-transaction-v1-${digest("x")}`,
			`session-transaction-v2-${digest("x")}.lock`,
			`${digest("x")}.lock.tmp`,
			"random.lock",
			"",
		])
			expect(isManagedGcLockRoleName(name)).toBe(false);
	});
});
