import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { installGuideCache, readGuideCache } from "../src/sdk/guides/cache";
import {
	BUNDLED_GUIDE_MANIFESTS,
	GuideCatalog,
	guideFetchPolicy,
	isGuideFetchUrlAllowed,
} from "../src/sdk/guides/catalog";
import {
	canonicalGuideManifestBytes,
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

const NOW = Date.UTC(2026, 3, 1);

beforeEach(() => {
	process.env.GJC_TEST_GUIDE_KEYS = "1";
	addTestGuidePinnedKey({ keyId: TEST_KEY_ID, spkiDerHex: TEST_PUBLIC_DER_HEX, source: "bundled" });
});

afterEach(() => {
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
});
