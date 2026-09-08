import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { UsageProvider } from "@gajae-code/ai";
import * as oauth from "@gajae-code/ai/utils/oauth";
import type { OAuthCredentials } from "@gajae-code/ai/utils/oauth/types";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { Snowflake } from "@gajae-code/utils";

const PROVIDER = "openai-codex";
const realDateNow = Date.now;
let releaseUsage: (() => void) | undefined;
/** Longer than the usage-report TTL plus its +25% jitter, so an aged cache entry is always expired. */
const USAGE_CACHE_AGE_MS = 15 * 60_000;

/** Fails fast with a named reason instead of the runner's silent 5 s timeout. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms}ms`)), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function release(): void {
	if (!releaseUsage) throw new Error("no parked usage lookup to release");
	releaseUsage();
}

/**
 * `markUsageLimitReached` blocks the row named by `rowId` even when the
 * session's sticky pointer has already moved elsewhere. The caller reads the
 * row the failed request used and names it, so a resolution that ran in
 * between cannot redirect the mark onto the healthy row it rotated onto.
 */
describe("AuthStorage.markUsageLimitReached with an explicit row id", () => {
	let tempDir: string;
	let authStorage: AuthStorage;

	/** When set, the usage lookup for this account parks until `release()` runs. */
	let deferUsageFor: string | undefined;
	let usageEntered: (() => void) | undefined;

	const usageProvider: UsageProvider = {
		id: PROVIDER,
		async fetchUsage(params) {
			const accountId = params.credential.accountId ?? "unknown";
			if (accountId === deferUsageFor) {
				usageEntered?.();
				await new Promise<void>(resolve => {
					releaseUsage = resolve;
				});
			}
			return {
				provider: PROVIDER,
				fetchedAt: Date.now(),
				limits: [
					{
						id: `requests-${accountId}`,
						label: "Requests",
						scope: { provider: PROVIDER, accountId },
						amount: { unit: "requests", used: 10, limit: 100 },
						status: "ok",
					},
				],
			};
		},
	};

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-auth-mark-row-id-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"), {
			usageProviderResolver: provider => (provider === PROVIDER ? usageProvider : undefined),
		});
		vi.spyOn(oauth, "refreshOAuthToken").mockImplementation(async (_provider, credential) => credential);
		vi.spyOn(oauth, "getOAuthApiKey").mockImplementation(async (_provider, credentials) => {
			const credential = credentials[PROVIDER] as OAuthCredentials | undefined;
			if (!credential) return null;
			return { apiKey: `api-${credential.accountId ?? "unknown"}`, newCredentials: credential };
		});
		const far = Date.now() + 3_600_000;
		await authStorage.set(PROVIDER, [
			{ type: "oauth", access: "a", refresh: "ra", expires: far, accountId: "acct-a", email: "a@x.test" },
			{ type: "oauth", access: "b", refresh: "rb", expires: far, accountId: "acct-b", email: "b@x.test" },
			{ type: "oauth", access: "c", refresh: "rc", expires: far, accountId: "acct-c", email: "c@x.test" },
		]);
		authStorage.setRuntimePreferredCredentialSelector(PROVIDER, { kind: "email", value: "a@x.test" });
	});

	afterEach(() => {
		Date.now = realDateNow;
		deferUsageFor = undefined;
		usageEntered = undefined;
		releaseUsage = undefined;
		authStorage.close();
		fs.rmSync(tempDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	/**
	 * Session lands on A (preferred); a pointer-path mark blocks A and the next
	 * resolution moves the pointer onto one of the two healthy rows. Which one
	 * depends on the session-id hash order, so the drifted key is returned
	 * rather than assumed.
	 */
	async function driftPointer(sessionId: string): Promise<{ rowA: number; driftedKey: string }> {
		expect(await authStorage.getApiKey(PROVIDER, sessionId)).toBe("api-acct-a");
		const rowA = authStorage.getSessionCredentialRowId(PROVIDER, sessionId);
		if (rowA === undefined) throw new Error("session should have a recorded row");
		expect(await authStorage.markUsageLimitReached(PROVIDER, sessionId, { retryAfterMs: 60_000 })).toBe(true);
		const driftedKey = await authStorage.getApiKey(PROVIDER, sessionId);
		if (driftedKey === undefined) throw new Error("expected a resolved key");
		expect(driftedKey).not.toBe("api-acct-a");
		return { rowA, driftedKey };
	}

	test("names the failed row: the pointer's healthy row stays usable", async () => {
		const sessionId = "session-1";
		const { rowA, driftedKey } = await driftPointer(sessionId);
		const unblockBefore = authStorage.getEarliestUnblockAt(PROVIDER) ?? 0;

		expect(await authStorage.markUsageLimitReached(PROVIDER, sessionId, { rowId: rowA, retryAfterMs: 120_000 })).toBe(
			true,
		);

		// The drifted row was never blocked, so the session keeps it; A's block was extended past its earlier 60 s.
		expect(await authStorage.getApiKey(PROVIDER, sessionId)).toBe(driftedKey);
		const unblockAfter = authStorage.getEarliestUnblockAt(PROVIDER) ?? 0;
		expect(unblockAfter).toBeGreaterThan(unblockBefore + 30_000);
	});

	test("without a row id the mark follows the pointer and blocks the healthy row (the behavior the id exists to avoid)", async () => {
		const sessionId = "session-2";
		const { driftedKey } = await driftPointer(sessionId);

		expect(await authStorage.markUsageLimitReached(PROVIDER, sessionId, { retryAfterMs: 120_000 })).toBe(true);

		const afterKey = await authStorage.getApiKey(PROVIDER, sessionId);
		expect(afterKey).not.toBe(driftedKey);
		expect(afterKey).not.toBe("api-acct-a");
	});

	test("re-locates the named row after the usage lookup when a preceding row is removed meanwhile", async () => {
		// Rows are A, B, C. The failed row is C (index 2). While C's usage lookup is
		// pending, A is removed, so C shifts to index 1. A mark that kept the index
		// captured before the await would back off nothing (index 2 is gone) and
		// leave C eligible; the mark must land on C by id.
		authStorage.removeRuntimePreferredCredentialSelector(PROVIDER);
		const targets = authStorage.listCredentialRemovalTargets(PROVIDER);
		expect(targets.length).toBe(3);
		const [targetA, , targetC] = targets;
		if (!targetA || !targetC) throw new Error("expected three removal targets");

		deferUsageFor = "acct-c";
		const entered = new Promise<void>(resolve => {
			usageEntered = resolve;
		});
		const pending = authStorage.markUsageLimitReached(PROVIDER, "session-4", {
			rowId: targetC.id,
			retryAfterMs: 120_000,
		});
		await within(entered, 2_000, "the parked usage lookup");

		const removal = authStorage.removeAuthCredentialsHard(PROVIDER, [targetA]);
		expect(removal.kind).toBe("removed");
		release();

		expect(await pending).toBe(true);
		// C is blocked, so a session that prefers C lands on B; A no longer exists.
		expect(
			await authStorage.getApiKey(PROVIDER, "session-5", {
				preferredCredentialSelector: { kind: "email", value: "c@x.test" },
			}),
		).toBe("api-acct-b");
	});

	test("the pointer path marks nothing when a preceding row is removed during the lookup", async () => {
		// Same window, no row id. The removal drops the provider's session pointers,
		// so the captured index (2, once C) now names D. The mark must not block D.
		await authStorage.set(PROVIDER, [
			{
				type: "oauth",
				access: "a",
				refresh: "ra",
				expires: Date.now() + 3_600_000,
				accountId: "acct-a",
				email: "a@x.test",
			},
			{
				type: "oauth",
				access: "b",
				refresh: "rb",
				expires: Date.now() + 3_600_000,
				accountId: "acct-b",
				email: "b@x.test",
			},
			{
				type: "oauth",
				access: "c",
				refresh: "rc",
				expires: Date.now() + 3_600_000,
				accountId: "acct-c",
				email: "c@x.test",
			},
			{
				type: "oauth",
				access: "d",
				refresh: "rd",
				expires: Date.now() + 3_600_000,
				accountId: "acct-d",
				email: "d@x.test",
			},
		]);
		authStorage.setRuntimePreferredCredentialSelector(PROVIDER, { kind: "email", value: "c@x.test" });
		expect(await authStorage.getApiKey(PROVIDER, "session-6")).toBe("api-acct-c");
		authStorage.removeRuntimePreferredCredentialSelector(PROVIDER);
		const [targetA] = authStorage.listCredentialRemovalTargets(PROVIDER);
		if (!targetA) throw new Error("expected a removal target");
		// The resolution above cached C's usage report; age the cache past its TTL so
		// the mark's lookup reaches the provider and can be parked.
		Date.now = () => realDateNow() + USAGE_CACHE_AGE_MS;

		deferUsageFor = "acct-c";
		const entered = new Promise<void>(resolve => {
			usageEntered = resolve;
		});
		const pending = authStorage.markUsageLimitReached(PROVIDER, "session-6", { retryAfterMs: 120_000 });
		await within(entered, 2_000, "the parked usage lookup");
		expect(authStorage.removeAuthCredentialsHard(PROVIDER, [targetA]).kind).toBe("removed");
		release();

		expect(await pending).toBe(false);
		expect(authStorage.getEarliestUnblockAt(PROVIDER)).toBeUndefined();
		expect(
			await authStorage.getApiKey(PROVIDER, "session-7", {
				preferredCredentialSelector: { kind: "email", value: "d@x.test" },
			}),
		).toBe("api-acct-d");
	});

	test("an unknown row id marks nothing", async () => {
		const sessionId = "session-3";
		expect(await authStorage.getApiKey(PROVIDER, sessionId)).toBe("api-acct-a");
		expect(await authStorage.markUsageLimitReached(PROVIDER, sessionId, { rowId: 999_999 })).toBe(false);
		expect(authStorage.getEarliestUnblockAt(PROVIDER)).toBeUndefined();
		expect(await authStorage.getApiKey(PROVIDER, sessionId)).toBe("api-acct-a");
	});
});
