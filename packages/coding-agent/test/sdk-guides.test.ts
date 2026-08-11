import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileLockTestHooks } from "../src/config/file-lock";
import { installGuideCache, readGuideCache } from "../src/sdk/guides/cache";
import {
	BUNDLED_GUIDE_MANIFESTS,
	GuideCatalog,
	guideFetchPolicy,
	isGuideFetchUrlAllowed,
} from "../src/sdk/guides/catalog";
import { runSdkGuidesCli } from "../src/sdk/guides/cli";
import {
	canonicalGuideManifestBytes,
	GUIDE_MANIFEST_MAX_BYTES,
	type GuideEntryV1,
	type GuideManifestV1,
	parseGuideManifest,
} from "../src/sdk/guides/manifest";
import {
	addTestGuidePinnedKey,
	removeTestGuidePinnedKey,
	verifyGuideAdvisoryText,
	verifyGuideManifest,
} from "../src/sdk/guides/verify";

const TEST_PRIVATE_DER_HEX =
	"302e020100300506032b6570042204204306f7f7259c18c9dc325fd3e8eb915e3bb81f9b1425e97aa0d62dc1e4a73cb1";
const TEST_PUBLIC_DER_HEX = "302a300506032b65700321009a14ad0e0da71700de44d79b73c7ea0ae6ea57893d2c3529a0674886d37c4d36";
const TEST_KEY_ID = createHash("sha256").update(Buffer.from(TEST_PUBLIC_DER_HEX, "hex")).digest("hex");

function signCanonical(manifest: GuideManifestV1, privateDerHex: string): Buffer {
	return sign(null, canonicalGuideManifestBytes(manifest), {
		key: Buffer.from(privateDerHex, "hex"),
		format: "der",
		type: "pkcs8",
	});
}

function entry(id: string, title: string, text: string): GuideEntryV1 {
	return { id, title, sha256: createHash("sha256").update(text).digest("hex") };
}

function makeManifest(overrides: Partial<GuideManifestV1> & { guides: GuideEntryV1[] }): GuideManifestV1 {
	const base = {
		version: 1 as const,
		manifestId: "test-channel",
		keyId: TEST_KEY_ID,
		sequence: 1,
		issuedAt: Date.UTC(2026, 0, 1),
		expiresAt: Date.UTC(2036, 0, 1),
		minimumSdkVersion: 1,
		guides: overrides.guides,
	};
	return { ...base, ...overrides };
}

async function tempAgentDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-sdk-guides-"));
	return dir;
}

async function installFixture(
	agentDir: string,
	manifest: GuideManifestV1,
	privateDerHex: string,
	texts: Record<string, string>,
) {
	const signatureBytes = signCanonical(manifest, privateDerHex);
	const advisories = manifest.guides.map(g => ({ entry: g, text: new TextEncoder().encode(texts[g.id] ?? "") }));
	return installGuideCache({ agentDir, manifest, signatureBytes, advisories, now: Date.UTC(2026, 3, 1) });
}

function fakeFetch(
	records: Map<string, { body: Uint8Array; status?: number }>,
	opts?: { error?: unknown },
): typeof fetch {
	return (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (opts?.error !== undefined) throw opts.error;
		const record = records.get(url);
		if (!record) return new Response("not found", { status: 404 });
		if (record.status !== undefined) return new Response(record.body, { status: record.status });
		return new Response(record.body, { status: 200, headers: { "content-length": String(record.body.byteLength) } });
	}) as unknown as typeof fetch;
}

async function runGuidesCli(
	args: Parameters<typeof runSdkGuidesCli>[0],
): Promise<{ output: unknown[]; exitCode: number | undefined }> {
	const output: unknown[] = [];
	let exitCode: number | undefined;
	await runSdkGuidesCli(
		args,
		value => output.push(value),
		code => {
			exitCode = code;
		},
	);
	return { output, exitCode };
}

const NOW = Date.UTC(2026, 3, 1);

beforeEach(() => {
	process.env.GJC_TEST_GUIDE_KEYS = "1";
	addTestGuidePinnedKey({ keyId: TEST_KEY_ID, spkiDerHex: TEST_PUBLIC_DER_HEX, source: "bundled" });
});

afterEach(() => {
	FileLockTestHooks.afterParentMkdir = undefined;
	removeTestGuidePinnedKey(TEST_KEY_ID);
	delete process.env.GJC_TEST_GUIDE_KEYS;
});

describe("guide manifest verification", () => {
	it("accepts a valid detached signature over the canonical manifest bytes", () => {
		const manifest = makeManifest({
			guides: [entry("troubleshooting/socket", "Socket troubleshooting", "Advisory body one.")],
		});
		const result = verifyGuideManifest({
			manifest,
			signatureBytes: signCanonical(manifest, TEST_PRIVATE_DER_HEX),
			now: NOW,
		});
		expect(result.ok).toBe(true);
	});

	it("rejects a detached signature that is not 64 bytes (corrupt_signature)", () => {
		const manifest = makeManifest({ guides: [entry("a", "A", "text")] });
		const result = verifyGuideManifest({ manifest, signatureBytes: new Uint8Array(63), now: NOW });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("corrupt_signature");
	});

	it("rejects a signature made by an unknown (unpinned) key", () => {
		const { privateKey, publicKey } = generateKeyPairSync("ed25519");
		const pubDer = publicKey.export({ type: "spki", format: "der" });
		const unknownKeyId = createHash("sha256").update(pubDer).digest("hex");
		const manifest = makeManifest({
			keyId: unknownKeyId,
			guides: [entry("a", "A", "text")],
		});
		const signatureBytes = sign(null, canonicalGuideManifestBytes(manifest), privateKey);
		const result = verifyGuideManifest({ manifest, signatureBytes, now: NOW });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("unknown_key");
	});

	it("rejects a signature over different bytes (invalid_signature)", () => {
		const manifestA = makeManifest({ guides: [entry("a", "A", "text A")] });
		const manifestB = makeManifest({ guides: [entry("a", "A", "text B")] });
		const sigForA = signCanonical(manifestA, TEST_PRIVATE_DER_HEX);
		const result = verifyGuideManifest({ manifest: manifestB, signatureBytes: sigForA, now: NOW });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("invalid_signature");
	});

	it("rejects a not-yet-issued manifest (not_yet_valid)", () => {
		const manifest = makeManifest({ guides: [entry("a", "A", "text")] });
		const result = verifyGuideManifest({
			manifest,
			signatureBytes: signCanonical(manifest, TEST_PRIVATE_DER_HEX),
			now: Date.UTC(2025, 6, 1),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("not_yet_valid");
	});

	it("rejects an expired manifest (expired)", () => {
		const manifest = makeManifest({ expiresAt: Date.UTC(2026, 1, 1), guides: [entry("a", "A", "text")] });
		const result = verifyGuideManifest({
			manifest,
			signatureBytes: signCanonical(manifest, TEST_PRIVATE_DER_HEX),
			now: NOW,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("expired");
	});

	it("rejects a manifest that requires a newer client (incompatible)", () => {
		const manifest = makeManifest({ minimumSdkVersion: 2, guides: [entry("a", "A", "text")] });
		const result = verifyGuideManifest({
			manifest,
			signatureBytes: signCanonical(manifest, TEST_PRIVATE_DER_HEX),
			now: NOW,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("incompatible");
	});

	it("rejects a rollback that does not advance the channel floor", () => {
		const manifest = makeManifest({ sequence: 3, guides: [entry("a", "A", "text")] });
		const result = verifyGuideManifest({
			manifest,
			signatureBytes: signCanonical(manifest, TEST_PRIVATE_DER_HEX),
			now: NOW,
		});
		expect(result.ok).toBe(true);
	});

	it("rejects an advisory whose bytes do not match the manifest sha256 binding (hash_mismatch)", () => {
		const manifest = makeManifest({ guides: [entry("a", "A", "expected text")] });
		const result = verifyGuideAdvisoryText(manifest.guides[0]!, new TextEncoder().encode("different text"));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("hash_mismatch");
	});
});

describe("guide cache", () => {
	it("installs and re-reads a verified cache round-trip", async () => {
		const agentDir = await tempAgentDir();
		const text = "Cache advisory text.";
		const manifest = makeManifest({ guides: [entry("cache/roundtrip", "Round trip", text)] });
		const installed = await installFixture(agentDir, manifest, TEST_PRIVATE_DER_HEX, { "cache/roundtrip": text });
		expect(installed.ok).toBe(true);
		const read = await readGuideCache({ agentDir, now: NOW });
		expect(read.ok).toBe(true);
		if (read.ok) {
			expect(read.value.manifest.manifestId).toBe("test-channel");
			expect(read.value.guides).toHaveLength(1);
			expect(read.value.guides[0]!.text).toBe(text);
		}
	});

	it("refuses to install a tampered advisory before any write (verify-before-rename)", async () => {
		const agentDir = await tempAgentDir();
		const text = "Trusted text.";
		const manifest = makeManifest({ guides: [entry("tamper/guide", "Tamper", text)] });
		const signatureBytes = signCanonical(manifest, TEST_PRIVATE_DER_HEX);
		const tampered = new TextEncoder().encode("Tampered bytes.");
		const result = await installGuideCache({
			agentDir,
			manifest,
			signatureBytes,
			advisories: [{ entry: manifest.guides[0]!, text: tampered }],
			now: NOW,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("hash_mismatch");
		const cache = await readGuideCache({ agentDir, now: NOW });
		expect(cache.ok).toBe(false);
		if (!cache.ok) expect(cache.error.code).toBe("missing_cache");
	});

	it("preserves a prior valid cache when a rollback install is refused", async () => {
		const agentDir = await tempAgentDir();
		const text = "Version one.";
		const v1 = makeManifest({ sequence: 2, guides: [entry("rollback/guide", "Rollback", text)] });
		const installed = await installFixture(agentDir, v1, TEST_PRIVATE_DER_HEX, { "rollback/guide": text });
		expect(installed.ok).toBe(true);
		const v0 = makeManifest({ sequence: 1, guides: [entry("rollback/guide", "Rollback", text)] });
		const signatureBytes = signCanonical(v0, TEST_PRIVATE_DER_HEX);
		const downgrade = await installGuideCache({
			agentDir,
			manifest: v0,
			signatureBytes,
			advisories: [{ entry: v0.guides[0]!, text: new TextEncoder().encode(text) }],
			now: NOW,
		});
		expect(downgrade.ok).toBe(false);
		if (!downgrade.ok) expect(downgrade.error.code).toBe("rollback");
		const read = await readGuideCache({ agentDir, now: NOW });
		expect(read.ok).toBe(true);
		if (read.ok) expect(read.value.manifest.sequence).toBe(2);
	});

	it("reports a corrupted cache (corrupt_cache) and does not delete it", async () => {
		const agentDir = await tempAgentDir();
		const text = "Cache advisory text.";
		const manifest = makeManifest({ guides: [entry("corrupt/guide", "Corrupt", text)] });
		const installed = await installFixture(agentDir, manifest, TEST_PRIVATE_DER_HEX, { "corrupt/guide": text });
		expect(installed.ok).toBe(true);
		const cacheDir = path.join(agentDir, "sdk", "guides", "cache");
		const metaPath = path.join(cacheDir, "meta.json");
		await fs.writeFile(metaPath, "not json");
		const read = await readGuideCache({ agentDir, now: NOW });
		expect(read.ok).toBe(false);
		if (!read.ok) expect(read.error.code).toBe("corrupt_cache");
		expect(await fs.readFile(metaPath, "utf8")).toBe("not json");
	});

	it("verifies the cache signature before renaming the commit point", async () => {
		const agentDir = await tempAgentDir();
		const text = "Cache advisory text.";
		const manifest = makeManifest({ guides: [entry("verify/rename", "Verify rename", text)] });
		const installed = await installFixture(agentDir, manifest, TEST_PRIVATE_DER_HEX, { "verify/rename": text });
		expect(installed.ok).toBe(true);
		const cacheDir = path.join(agentDir, "sdk", "guides", "cache");
		const meta = JSON.parse(await fs.readFile(path.join(cacheDir, "meta.json"), "utf8")) as { generation: string };
		const sigPath = path.join(cacheDir, "generations", meta.generation, "manifest.sig");
		await fs.writeFile(sigPath, Buffer.alloc(64));
		const read = await readGuideCache({ agentDir, now: NOW });
		expect(read.ok).toBe(false);
		if (!read.ok) expect(read.error.code).toBe("corrupt_cache");
	});
	it("serializes the rollback-floor check with the commit pointer replacement across processes", async () => {
		const agentDir = await tempAgentDir();
		const text = "Floor-guard text.";
		const v1 = makeManifest({ sequence: 1, guides: [entry("floor/guard", "Floor guard", text)] });
		const seeded = await installFixture(agentDir, v1, TEST_PRIVATE_DER_HEX, { "floor/guard": text });
		expect(seeded.ok).toBe(true);

		// Park the older contender (seq 2) at the cross-process lock boundary so
		// the newer contender (seq 3) fully commits first. Without the lock the
		// older contender's floor check (read before the commit) would pass and
		// it would downgrade the cache to seq 2 after seq 3 landed.
		let gateRelease: (() => void) | undefined;
		const gate = new Promise<void>(resolve => {
			gateRelease = resolve;
		});
		let parkedResolve: (() => void) | undefined;
		const parked = new Promise<void>(resolve => {
			parkedResolve = resolve;
		});
		let gateOlder = true;
		const originalHook = FileLockTestHooks.afterParentMkdir;
		FileLockTestHooks.afterParentMkdir = async lockPath => {
			if (!lockPath.endsWith("meta.json.lock")) return;
			if (gateOlder) {
				gateOlder = false;
				parkedResolve?.();
				await gate;
			}
		};
		try {
			const v2 = makeManifest({ sequence: 2, guides: [entry("floor/guard", "Floor guard", text)] });
			const v3 = makeManifest({ sequence: 3, guides: [entry("floor/guard", "Floor guard", text)] });
			const older = installFixture(agentDir, v2, TEST_PRIVATE_DER_HEX, { "floor/guard": text });
			await parked;
			const newer = await installFixture(agentDir, v3, TEST_PRIVATE_DER_HEX, { "floor/guard": text });
			expect(newer.ok).toBe(true);
			gateRelease?.();
			const olderResult = await older;
			expect(olderResult.ok).toBe(false);
			if (!olderResult.ok) expect(olderResult.error.code).toBe("rollback");

			const read = await readGuideCache({ agentDir, now: NOW });
			expect(read.ok).toBe(true);
			if (read.ok) expect(read.value.manifest.sequence).toBe(3);

			const cacheDir = path.join(agentDir, "sdk", "guides", "cache");
			expect(await fs.readdir(cacheDir)).not.toContain("meta.json.lock");
		} finally {
			gateRelease?.();
			FileLockTestHooks.afterParentMkdir = originalHook;
		}
	});
});

describe("guide catalog selection", () => {
	it("selects the bundled seed on a fresh install and ships usable advisory text", async () => {
		const agentDir = await tempAgentDir();
		const catalog = new GuideCatalog({ agentDir, now: () => NOW });
		const selection = await catalog.load();
		expect(selection.ok).toBe(true);
		if (!selection.ok) return;
		expect(selection.value.source).toBe("bundled");
		expect(selection.value.guides.length).toBeGreaterThan(0);
		for (const guide of selection.value.guides) {
			expect(guide.text).toBeTypeOf("string");
			expect((guide.text as string).length).toBeGreaterThan(0);
		}
		const shown = await catalog.advisory(selection.value.guides[0]!.id);
		expect(shown.ok).toBe(true);
		if (shown.ok) expect(shown.value.text.length).toBeGreaterThan(0);
	});

	it("falls back to the bundled seed when the online manifest is rejected (structured warnings)", async () => {
		const agentDir = await tempAgentDir();
		const records = new Map<string, { body: Uint8Array }>();
		const fetchImpl = fakeFetch(records, { error: new Error("network unreachable") });
		const catalog = new GuideCatalog({
			agentDir,
			onlineUrl: "https://guides.gajae-code.com/manifest.json",
			fetchImpl,
			now: () => NOW,
		});
		const result = await catalog.refresh();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.source).toBe("bundled");
		expect(result.value.warnings.some(w => w.includes("network_error"))).toBe(true);
	});

	it("keeps the prior valid cache when a tampered online refresh is rejected", async () => {
		const agentDir = await tempAgentDir();
		const text = "Cached text.";
		const manifest = makeManifest({ manifestId: "channel", guides: [entry("online/tamper", "Online tamper", text)] });
		const installed = await installFixture(agentDir, manifest, TEST_PRIVATE_DER_HEX, { "online/tamper": text });
		expect(installed.ok).toBe(true);

		const tamperedManifest = makeManifest({
			manifestId: "channel",
			sequence: 5,
			guides: [entry("online/tamper", "Online tamper", "New tampered text.")],
		});
		const manifestBody = new TextEncoder().encode(JSON.stringify(tamperedManifest));
		const records = new Map<string, { body: Uint8Array }>([
			["https://guides.gajae-code.com/manifest.json", { body: manifestBody }],
			["https://guides.gajae-code.com/manifest.json.sig", { body: Buffer.alloc(64) }],
		]);
		const fetchImpl = fakeFetch(records);
		const catalog = new GuideCatalog({
			agentDir,
			onlineUrl: "https://guides.gajae-code.com/manifest.json",
			fetchImpl,
			now: () => NOW,
		});
		const result = await catalog.refresh();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.source).toBe("cache");
		expect(result.value.guides[0]!.text).toBe(text);
		expect(result.value.warnings.some(w => w.includes("invalid_signature"))).toBe(true);
	});

	it("preserves structured rejection causes when no fallback exists (unavailable error carries them in warnings)", async () => {
		const agentDir = await tempAgentDir();
		const records = new Map<string, { body: Uint8Array }>();
		const fetchImpl = fakeFetch(records, { error: new Error("tamper evident") });
		const catalog = new GuideCatalog({
			agentDir,
			onlineUrl: "https://guides.gajae-code.com/manifest.json",
			fetchImpl,
			now: () => NOW,
			disableBundled: true,
		});
		const result = await catalog.refresh();
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("unavailable");
			expect(result.error.message).toContain("network_error");
		}
	});

	it("rejects a valid-cache fallback only when the cache is corrupt and reports the cause", async () => {
		const agentDir = await tempAgentDir();
		const text = "Cached text.";
		const manifest = makeManifest({ guides: [entry("fallback/guide", "Fallback", text)] });
		const installed = await installFixture(agentDir, manifest, TEST_PRIVATE_DER_HEX, { "fallback/guide": text });
		expect(installed.ok).toBe(true);
		const cacheDir = path.join(agentDir, "sdk", "guides", "cache");
		await fs.writeFile(path.join(cacheDir, "meta.json"), "garbage");
		const catalog = new GuideCatalog({ agentDir, now: () => NOW, disableBundled: true });
		const result = await catalog.load();
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("unavailable");
			expect(result.error.message).toContain("corrupt_cache");
		}
	});

	it("fails closed with an unavailable result when no cache and no bundled manifest exist", async () => {
		const agentDir = await tempAgentDir();
		const catalog = new GuideCatalog({ agentDir, now: () => NOW, disableBundled: true });
		const result = await catalog.load();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("unavailable");
	});
	it("re-checks the rollback floor when concurrent online refreshes race and falls back to the newer cache", async () => {
		const agentDir = await tempAgentDir();
		const text = "Concurrent refresh text.";
		const v1 = makeManifest({ sequence: 1, guides: [entry("concurrent/refresh", "Concurrent refresh", text)] });
		const seeded = await installFixture(agentDir, v1, TEST_PRIVATE_DER_HEX, { "concurrent/refresh": text });
		expect(seeded.ok).toBe(true);

		const v2 = makeManifest({ sequence: 2, guides: [entry("concurrent/refresh", "Concurrent refresh", text)] });
		const v3 = makeManifest({ sequence: 3, guides: [entry("concurrent/refresh", "Concurrent refresh", text)] });
		const records = new Map<string, { body: Uint8Array }>([
			["https://guides.gajae-code.com/manifest-v2.json", { body: new TextEncoder().encode(JSON.stringify(v2)) }],
			["https://guides.gajae-code.com/manifest-v2.json.sig", { body: signCanonical(v2, TEST_PRIVATE_DER_HEX) }],
			["https://guides.gajae-code.com/manifest-v3.json", { body: new TextEncoder().encode(JSON.stringify(v3)) }],
			["https://guides.gajae-code.com/manifest-v3.json.sig", { body: signCanonical(v3, TEST_PRIVATE_DER_HEX) }],
			["https://guides.gajae-code.com/guides/concurrent/refresh", { body: new TextEncoder().encode(text) }],
		]);
		const fetchImpl = fakeFetch(records);

		let gateRelease: (() => void) | undefined;
		const gate = new Promise<void>(resolve => {
			gateRelease = resolve;
		});
		let parkedResolve: (() => void) | undefined;
		const parked = new Promise<void>(resolve => {
			parkedResolve = resolve;
		});
		let gateOlder = true;
		const originalHook = FileLockTestHooks.afterParentMkdir;
		FileLockTestHooks.afterParentMkdir = async lockPath => {
			if (!lockPath.endsWith("meta.json.lock")) return;
			if (gateOlder) {
				gateOlder = false;
				parkedResolve?.();
				await gate;
			}
		};
		try {
			const olderCatalog = new GuideCatalog({
				agentDir,
				onlineUrl: "https://guides.gajae-code.com/manifest-v2.json",
				fetchImpl,
				now: () => NOW,
			});
			const newerCatalog = new GuideCatalog({
				agentDir,
				onlineUrl: "https://guides.gajae-code.com/manifest-v3.json",
				fetchImpl,
				now: () => NOW,
			});
			const olderRefresh = olderCatalog.refresh();
			await parked;
			const newerResult = await newerCatalog.refresh();
			expect(newerResult.ok).toBe(true);
			if (newerResult.ok) {
				expect(newerResult.value.source).toBe("online");
				expect(newerResult.value.manifest.sequence).toBe(3);
			}
			gateRelease?.();
			const olderResult = await olderRefresh;
			expect(olderResult.ok).toBe(true);
			if (olderResult.ok) {
				// The loser must not present its own stale manifest as a
				// success: it falls back to the newer verified cache and
				// reports the rollback as a structured warning.
				expect(olderResult.value.source).toBe("cache");
				expect(olderResult.value.manifest.sequence).toBe(3);
				expect(olderResult.value.warnings.some(w => w.includes("rollback"))).toBe(true);
			}

			const read = await readGuideCache({ agentDir, now: NOW });
			expect(read.ok).toBe(true);
			if (read.ok) expect(read.value.manifest.sequence).toBe(3);
		} finally {
			gateRelease?.();
			FileLockTestHooks.afterParentMkdir = originalHook;
		}
	});
});

describe("guide fetch boundary and CLI-facing selection outcomes", () => {
	it("refuses non-allowlisted URLs", () => {
		expect(isGuideFetchUrlAllowed("https://guides.gajae-code.com/manifest.json")).toBe(true);
		expect(isGuideFetchUrlAllowed("http://guides.gajae-code.com/manifest.json")).toBe(false);
		expect(isGuideFetchUrlAllowed("https://evil.example.com/manifest.json")).toBe(false);
		expect(isGuideFetchUrlAllowed("https://guides.gajae-code.com.evil.example/manifest.json")).toBe(false);
		expect(isGuideFetchUrlAllowed("https://user:pass@guides.gajae-code.com/manifest.json")).toBe(false);
		expect(isGuideFetchUrlAllowed("not a url")).toBe(false);
	});

	it("exposes the fetch policy with credential-free, redirect-blocked defaults", () => {
		const policy = guideFetchPolicy();
		expect(policy.httpsOnly).toBe(true);
		expect(policy.credentials).toBe("omit");
		expect(policy.redirect).toBe("error");
		expect(policy.allowlist.some(entry => entry.host === "guides.gajae-code.com")).toBe(true);
	});

	it("rejects a manifest whose canonical bytes are re-formatted by an attacker", () => {
		const manifest = makeManifest({ guides: [entry("format/attack", "Format attack", "text")] });
		const sig = signCanonical(manifest, TEST_PRIVATE_DER_HEX);
		const reformatted = JSON.parse(JSON.stringify(manifest)) as GuideManifestV1;
		// Reordering keys changes the canonical encoding even when JSON is equal.
		const reordered = {
			guides: reformatted.guides,
			minimumSdkVersion: reformatted.minimumSdkVersion,
			expiresAt: reformatted.expiresAt,
			issuedAt: reformatted.issuedAt,
			sequence: reformatted.sequence,
			keyId: reformatted.keyId,
			manifestId: reformatted.manifestId,
			version: reformatted.version,
		};
		const result = verifyGuideManifest({
			manifest: reordered as unknown as GuideManifestV1,
			signatureBytes: sig,
			now: NOW,
		});
		expect(result.ok).toBe(true);
	});

	it("parses a fresh install manifest into a valid typed manifest", () => {
		const parsed = parseGuideManifest(BUNDLED_GUIDE_MANIFESTS[0]);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.manifest.guides.length).toBeGreaterThan(0);
		expect(parsed.manifest.guides[0]!.id.length).toBeGreaterThan(0);
	});
	it("installs a bounded online manifest and reports an online source", async () => {
		const agentDir = await tempAgentDir();
		const text = "Bounded refresh text.";
		const manifestV1 = makeManifest({ sequence: 1, guides: [entry("bounded/refresh", "Bounded refresh", text)] });
		const manifestV2 = makeManifest({ sequence: 2, guides: [entry("bounded/refresh", "Bounded refresh", text)] });
		const records = new Map<string, { body: Uint8Array }>([
			[
				"https://guides.gajae-code.com/manifest.json",
				{ body: new TextEncoder().encode(JSON.stringify(manifestV1)) },
			],
			["https://guides.gajae-code.com/manifest.json.sig", { body: signCanonical(manifestV1, TEST_PRIVATE_DER_HEX) }],
			["https://guides.gajae-code.com/guides/bounded/refresh", { body: new TextEncoder().encode(text) }],
		]);
		const fetchImpl = fakeFetch(records);

		const catalog = new GuideCatalog({
			agentDir,
			onlineUrl: "https://guides.gajae-code.com/manifest.json",
			fetchImpl,
			now: () => NOW,
		});
		const result = await catalog.refresh();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.source).toBe("online");
		expect(result.value.manifest.sequence).toBe(1);

		// A follow-up CLI refresh that advances the floor still reports online.
		records.set("https://guides.gajae-code.com/manifest.json", {
			body: new TextEncoder().encode(JSON.stringify(manifestV2)),
		});
		records.set("https://guides.gajae-code.com/manifest.json.sig", {
			body: signCanonical(manifestV2, TEST_PRIVATE_DER_HEX),
		});
		const cli = await runGuidesCli({
			action: "refresh",
			url: "https://guides.gajae-code.com/manifest.json",
			agentDir,
			fetchImpl,
		});
		expect(cli.exitCode).toBe(undefined);
		expect(cli.output).toHaveLength(1);
		const payload = cli.output[0] as { ok: boolean; result?: { source: string; manifest: { sequence: number } } };
		expect(payload.ok).toBe(true);
		expect(payload.result?.source).toBe("online");
		expect(payload.result?.manifest.sequence).toBe(2);
	});

	it("fails the refresh verb operationally when online refresh falls back to cache", async () => {
		const agentDir = await tempAgentDir();
		const text = "Cached CLI text.";
		const manifest = makeManifest({ sequence: 1, guides: [entry("cli/fallback", "CLI fallback", text)] });
		const installed = await installFixture(agentDir, manifest, TEST_PRIVATE_DER_HEX, { "cli/fallback": text });
		expect(installed.ok).toBe(true);

		const fetchImpl = fakeFetch(new Map(), { error: new Error("network unreachable") });
		const refresh = await runGuidesCli({
			action: "refresh",
			url: "https://guides.gajae-code.com/manifest.json",
			agentDir,
			fetchImpl,
		});
		expect(refresh.exitCode).toBe(1);
		expect(refresh.output).toHaveLength(1);
		const payload = refresh.output[0] as { ok: boolean; error?: { code: string; message: string } };
		expect(payload.ok).toBe(false);
		expect(payload.error?.code).toBe("online_refresh_failed");
		expect(payload.error?.message).toContain("cache");
		expect(payload.error?.message).toContain("network_error");

		// The failed refresh leaves the prior valid cache intact and usable.
		const read = await readGuideCache({ agentDir, now: NOW });
		expect(read.ok).toBe(true);
		if (read.ok) expect(read.value.manifest.sequence).toBe(1);
		const list = await runGuidesCli({ action: "list", agentDir });
		expect(list.exitCode).toBe(undefined);
		const listPayload = list.output[0] as { ok: boolean; result?: { source: string } };
		expect(listPayload.ok).toBe(true);
		expect(listPayload.result?.source).toBe("cache");
	});

	it("rejects an oversized online manifest before any install (bounded response behavior)", async () => {
		const agentDir = await tempAgentDir();
		const oversizedBody = new Uint8Array(GUIDE_MANIFEST_MAX_BYTES + 1);
		const records = new Map<string, { body: Uint8Array }>([
			["https://guides.gajae-code.com/manifest.json", { body: oversizedBody }],
		]);
		const fetchImpl = fakeFetch(records);

		// The catalog falls back with a structured `oversize` warning and never
		// installs the oversized content.
		const catalog = new GuideCatalog({
			agentDir,
			onlineUrl: "https://guides.gajae-code.com/manifest.json",
			fetchImpl,
			now: () => NOW,
		});
		const result = await catalog.refresh();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.source).toBe("bundled");
		expect(result.value.warnings.some(w => w.includes("oversize"))).toBe(true);
		const cache = await readGuideCache({ agentDir, now: NOW });
		expect(cache.ok).toBe(false);
		if (!cache.ok) expect(cache.error.code).toBe("missing_cache");

		// The CLI fails operationally instead of presenting the fallback as a
		// successful refresh.
		const cli = await runGuidesCli({
			action: "refresh",
			url: "https://guides.gajae-code.com/manifest.json",
			agentDir,
			fetchImpl,
		});
		expect(cli.exitCode).toBe(1);
		const payload = cli.output[0] as { ok: boolean; error?: { code: string; message: string } };
		expect(payload.ok).toBe(false);
		expect(payload.error?.code).toBe("online_refresh_failed");
		expect(payload.error?.message).toContain("oversize");
	});

	it("refuses a non-allowlisted refresh URL as a usage error before any fetch", async () => {
		const agentDir = await tempAgentDir();
		const cli = await runGuidesCli({
			action: "refresh",
			url: "http://guides.gajae-code.com/manifest.json",
			agentDir,
			fetchImpl: fakeFetch(new Map()),
		});
		expect(cli.exitCode).toBe(2);
		expect(cli.output).toHaveLength(1);
		const payload = cli.output[0] as { ok: boolean; error?: { code: string } };
		expect(payload.ok).toBe(false);
		expect(payload.error?.code).toBe("usage");
	});
});
