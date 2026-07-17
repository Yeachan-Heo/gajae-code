/**
 * Gajae Trinity compatibility tests.
 *
 * The gajae receipt runtime (separate repo) consumes ReceiptEnvelope JSON
 * across a file/process/RPC boundary and recomputes the canonical-JSON sha256
 * over the envelope minus `sha256`. These tests pin the wire contract: the
 * golden fixtures consumed by gajae's connector tests must always validate
 * against THIS repo's builders/validators, and the hash basis must stay
 * `canonicalJson(envelope minus sha256)`. Breaking either is a cross-repo
 * contract break, not a refactor.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	buildReceipt,
	canonicalJson,
	type ReceiptEnvelope,
	sha256Hex,
	validateReceipt,
} from "../../src/harness-control-plane/receipts";
import { SUPPORTED_HARNESSES } from "../../src/harness-control-plane/seams";

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures");

async function loadGoldenReceipt(): Promise<ReceiptEnvelope<Record<string, unknown>>> {
	return (await Bun.file(path.join(FIXTURES_DIR, "gajae-trinity-completion-receipt.json")).json()) as ReceiptEnvelope<
		Record<string, unknown>
	>;
}

describe("gajae trinity wire contract", () => {
	it("the golden completion receipt is hash-consistent under the canonical basis", async () => {
		const golden = await loadGoldenReceipt();
		const { sha256, ...basis } = golden;
		expect(sha256Hex(canonicalJson(basis))).toBe(sha256);
	});

	it("the golden completion receipt passes this repo's validator", async () => {
		const golden = await loadGoldenReceipt();
		const outcome = validateReceipt(golden);
		expect(outcome.valid).toBe(true);
		expect(outcome.reasons).toEqual([]);
	});

	it("buildReceipt reproduces the golden fixture byte-for-byte given the same inputs", async () => {
		const golden = await loadGoldenReceipt();
		const rebuilt = buildReceipt({
			receiptId: golden.receiptId,
			sessionId: golden.sessionId,
			family: golden.family,
			source: golden.source,
			subject: golden.subject,
			evidence: golden.evidence,
			artifactHashes: golden.artifactHashes,
			createdAt: golden.createdAt,
			valid: golden.valid,
		});
		expect(rebuilt.sha256).toBe(golden.sha256);
		expect(canonicalJson(rebuilt)).toBe(canonicalJson(golden));
	});

	it("golden envelope carries every field the gajae whitelist mapper requires", async () => {
		const golden = await loadGoldenReceipt();
		expect(golden.receiptId).toBeTruthy();
		expect(golden.schemaVersion).toBe(1);
		expect(golden.sessionId).toBeTruthy();
		expect(golden.family).toBe("completion");
		expect(golden.valid).toBe(true);
		expect(Date.parse(golden.createdAt)).not.toBeNaN();
		expect(golden.source).toBeTruthy();
		expect((golden.evidence as { finalLifecycle?: string }).finalLifecycle).toBe("completed");
		for (const [name, hash] of Object.entries(golden.artifactHashes)) {
			expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
			expect(hash).toMatch(/^[0-9a-f]{64}$/);
		}
	});

	it("the supported-harness seam is unchanged", () => {
		expect(SUPPORTED_HARNESSES).toEqual(["gajae-code"]);
	});

	it("tampering any whitelisted field breaks the hash (fail-closed downstream)", async () => {
		const golden = await loadGoldenReceipt();
		const tampered = { ...golden, valid: false };
		const { sha256, ...basis } = tampered;
		expect(sha256Hex(canonicalJson(basis))).not.toBe(sha256);
		expect(validateReceipt(tampered as ReceiptEnvelope<Record<string, unknown>>).valid).toBe(false);
	});
});
