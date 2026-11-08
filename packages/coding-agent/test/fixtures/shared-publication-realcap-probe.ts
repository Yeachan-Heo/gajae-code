// Opt-in: bun packages/coding-agent/test/fixtures/shared-publication-realcap-probe.ts
// Uses the real 128 MiB cap; eager snapshots can require more than 1 GiB RSS.
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	MANAGED_ARTIFACT_MAX_FILE_BYTES,
	ManagedSessionDescendantStore,
} from "../../src/session/internal/managed-session-storage";
import { getSessionMessageEntryId, SessionManager } from "../../src/session/session-manager";

interface Image {
	size: number;
	digest: string;
}
interface Attempt {
	phase: "positive" | "overflow";
	id: string;
	parentId: string | null;
	bytes: number;
	expectedSize: number;
	expectedDigest: string;
	error?: string;
}

async function image(file: string): Promise<Image> {
	const hash = new Bun.CryptoHasher("sha256");
	let size = 0;
	for await (const chunk of Bun.file(file).stream()) {
		size += chunk.byteLength;
		hash.update(chunk);
	}
	return { size, digest: hash.digest("hex") };
}

function padding(characters: number): { model: string[] } {
	const model: string[] = [];
	while (characters > 0) {
		const length = Math.min(characters, 400_000);
		model.push("x".repeat(length));
		characters -= length;
	}
	return { model };
}

async function committed(manager: SessionManager) {
	const read = await manager.captureCommittedSnapshot();
	assert.equal(read.kind, "snapshot");
	assert.equal(read.snapshot.sessionId, manager.getSessionId());
	return read.snapshot;
}

const started = performance.now();
const cap = MANAGED_ARTIFACT_MAX_FILE_BYTES;
assert.equal(cap, 128 * 1024 * 1024);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-realcap-"));
const managers: SessionManager[] = [];
const attempts: Attempt[] = [];
const closeOutcomes: { kind: string; error?: string }[] = [];
const cleanupErrors: unknown[] = [];
const foreignIds: string[] = [];
let phase: Attempt["phase"] = "positive";
let file: string | undefined;
let baseline: Image | undefined;
let afterRefusal: Image | undefined;
let afterClose: Image | undefined;
let outcome: unknown;
let failure: unknown;
let failed = false;
let replacementCalls = 0;
let controlId: string | undefined;
let attemptedId: string | undefined;
const prototype = ManagedSessionDescendantStore.prototype;
const originalAppend = prototype.appendExpectedIdentitySync;
const originalReplaceExpected = prototype.replaceExpectedIdentitySync;
const originalReplace = prototype.replaceSync;

try {
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
	const destination = SessionManager.managedDestination(cwd, agentDir);
	const seed = SessionManager.create(cwd, destination);
	managers.push(seed);
	const anchor = seed.appendMessage({ role: "user", content: "realcap-root", timestamp: 1 });
	await seed.ensureOnDisk();
	file = seed.getSessionFile();
	assert.ok(file);
	const first = await SessionManager.open(file, destination);
	managers.push(first);
	const second = await SessionManager.open(file, destination);
	managers.push(second);

	// Small strings under an excluded externalization key retain real JSONL bytes.
	// Each record is also below the bounded reader's 8 MiB line limit.
	const bulk = 16 * 400_000;
	while (cap - (await fs.stat(file)).size > bulk + 32_768) {
		foreignIds.push(first.appendCustomEntry("realcap-padding", padding(bulk)));
		await first.flush();
	}
	const filler = cap - (await fs.stat(file)).size - 16_384 - 1_024;
	assert.ok(filler > 0);
	foreignIds.push(first.appendCustomEntry("realcap-padding", padding(filler)));
	await first.flush();
	const grown = await committed(second);
	assert.ok(cap - grown.size >= 16_384 && cap - grown.size <= 18_432);
	assert.equal(second.getLeafId(), anchor);
	assert.deepEqual(
		second.getEntries().map(entry => entry.id),
		[anchor],
	);
	for (const id of foreignIds) assert.equal(grown.entryIds.filter(value => value === id).length, 1);

	const basename = path.basename(file);
	prototype.appendExpectedIdentitySync = function (
		this: ManagedSessionDescendantStore,
		...args: Parameters<typeof originalAppend>
	) {
		if (args[0] !== basename) return originalAppend.apply(this, args);
		const entry: { id: unknown; parentId: unknown } = JSON.parse(Buffer.from(args[1]).toString("utf8"));
		assert.ok(typeof entry.id === "string");
		assert.ok(entry.parentId === null || typeof entry.parentId === "string");
		const expectedDigest = args[2].sha256;
		assert.ok(typeof expectedDigest === "string");
		const attempt: Attempt = {
			phase,
			id: entry.id,
			parentId: entry.parentId,
			bytes: args[1].byteLength,
			expectedSize: Number(args[2].size),
			expectedDigest,
		};
		attempts.push(attempt);
		try {
			return originalAppend.apply(this, args);
		} catch (error) {
			attempt.error = error instanceof Error ? error.message : String(error);
			throw error;
		}
	};
	prototype.replaceExpectedIdentitySync = function (
		this: ManagedSessionDescendantStore,
		...args: Parameters<typeof originalReplaceExpected>
	) {
		if (phase === "overflow" && args[0] === basename) replacementCalls++;
		return originalReplaceExpected.apply(this, args);
	};
	prototype.replaceSync = function (this: ManagedSessionDescendantStore, ...args: Parameters<typeof originalReplace>) {
		if (phase === "overflow" && args[0] === basename) replacementCalls++;
		return originalReplace.apply(this, args);
	};

	const control = await second.appendMessageSharingSession({
		role: "user",
		content: "realcap-positive-control",
		timestamp: 2,
	});
	assert.equal(control.kind, "committed");
	controlId = control.id;
	assert.equal(attempts.length, 1);
	assert.equal(attempts[0].parentId, anchor);
	assert.equal(attempts[0].expectedSize, grown.size);
	assert.equal(attempts[0].expectedDigest, grown.digest);
	assert.ok(attempts[0].expectedSize + attempts[0].bytes <= cap);
	const before = await committed(second);
	assert.deepEqual(before.entryIds, [...grown.entryIds, control.id]);
	baseline = await image(file);
	assert.equal(baseline.size, before.size);
	assert.equal(baseline.digest, before.digest);

	phase = "overflow";
	const message = { role: "user" as const, content: `realcap-overflow:${"y".repeat(32_768)}`, timestamp: 3 };
	outcome = await second.appendMessageSharingSession(message);
	attemptedId = getSessionMessageEntryId(message);
	const overflow = attempts.filter(attempt => attempt.phase === "overflow");
	assert.equal(overflow.length, 1);
	assert.equal(overflow[0].expectedSize, baseline.size);
	assert.equal(overflow[0].expectedDigest, baseline.digest);
	assert.ok(overflow[0].expectedSize <= cap);
	assert.ok(overflow[0].expectedSize + overflow[0].bytes > cap);
	assert.equal(overflow[0].error, "content_too_large");
	assert.deepEqual(outcome, { kind: "stale", reason: "rewrite_required" });
	assert.equal(replacementCalls, 0);
	assert.equal(attemptedId, overflow[0].id);
	assert.equal(overflow[0].parentId, control.id);
	assert.equal(second.getLeafId(), control.id);
	assert.deepEqual(
		second.getEntries().map(entry => entry.id),
		[anchor, control.id],
	);
	const after = await committed(second);
	assert.deepEqual(after.entryIds, before.entryIds);
	assert.ok(!after.entryIds.includes(overflow[0].id));
	afterRefusal = await image(file);
	assert.deepEqual(afterRefusal, baseline);
} catch (error) {
	failed = true;
	failure = error;
} finally {
	prototype.appendExpectedIdentitySync = originalAppend;
	prototype.replaceExpectedIdentitySync = originalReplaceExpected;
	prototype.replaceSync = originalReplace;
	for (const manager of managers.reverse()) {
		try {
			const closed = await manager.closeStrict();
			closeOutcomes.push({ kind: closed.kind, ...("error" in closed ? { error: String(closed.error) } : {}) });
			assert.equal(closed.kind, "closed");
		} catch (error) {
			cleanupErrors.push(error);
		}
	}
	try {
		if (file && baseline) {
			afterClose = await image(file);
			assert.deepEqual(afterClose, baseline);
		}
	} catch (error) {
		cleanupErrors.push(error);
	}
	try {
		await fs.rm(root, { recursive: true, force: true });
	} catch (error) {
		cleanupErrors.push(error);
	}
}

const describeError = (error: unknown) =>
	error instanceof Error ? { name: error.name, message: error.message } : String(error);
const receipt = {
	status: failed || cleanupErrors.length ? "failed" : "passed",
	capBytes: cap,
	foreignEntries: foreignIds.length,
	controlId,
	attemptedId,
	baseline,
	afterRefusal,
	afterClose,
	attempts,
	replacementCalls,
	outcome,
	closeOutcomes,
	failure: failed ? describeError(failure) : undefined,
	cleanupErrors: cleanupErrors.map(describeError),
	elapsedMs: Math.round(performance.now() - started),
	resourceUsageMaxRSS: process.resourceUsage().maxRSS,
};
const receiptPath = path.resolve(
	import.meta.dirname,
	"../../../../artifacts/shared-publication-realcap-probe",
	`${crypto.randomUUID()}.json`,
);
await Bun.write(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ receiptPath, ...receipt })}\n`);
if (failed || cleanupErrors.length) {
	throw new AggregateError([...(failed ? [failure] : []), ...cleanupErrors], "real-cap probe failed");
}
