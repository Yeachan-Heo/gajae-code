import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	type EvidenceClassification,
	publishCommandEvidence,
	readCommandEvidence,
} from "../src/cli/public-command-evidence";

const posix = process.platform === "win32" ? test.skip : test;
const error: EvidenceClassification = {
	code: "operation_uncertain",
	category: "uncertain",
	retryability: "unknown",
	outcomeCertainty: "unknown",
};
async function fixture(run: (root: string, slot: string) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), "gjc-evidence-page-"));
	try {
		await run(root, path.join(root, "cli-error-evidence-v1", "00.json"));
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}
function publish(root: string, value: string, scopeAgentDir?: string) {
	return publishCommandEvidence(
		{ agentDir: root, command: ["sdk", "session", "send"], error, references: [{ kind: "operationRef", value }] },
		{ family: "sdk", scopeAgentDir, json: true },
	);
}

posix("immutable 1024-byte fragments reconstruct exact safe values and pin scope, mode and digest", async () => {
	await fixture(async (root, slot) => {
		const value = '  漢字😀é\n\t"\\\ud800'.repeat(500);
		const retained = await publish(root, value, root);
		if (retained.status !== "retained") throw new Error(retained.reason);
		const chunks: Buffer[] = [];
		let page = 1;
		while (true) {
			const result = await readCommandEvidence({
				agentDir: root,
				family: "sdk",
				id: retained.id,
				sha256: retained.sha256,
				page,
				scopeAgentDir: root,
				json: true,
			});
			if (result.status !== "available") throw new Error(result.reason);
			expect(Buffer.byteLength(`${JSON.stringify(result.page)}\n`)).toBeLessThanOrEqual(8192);
			const fragment = result.page.fragments[0]!;
			expect(fragment.offsetBytes).toBe((page - 1) * 1024);
			expect(fragment.totalBytes).toBe(retained.bytes);
			chunks.push(Buffer.from(fragment.data, "base64"));
			if (result.page.complete) {
				expect(result.page.next).toBeNull();
				break;
			}
			expect(chunks[chunks.length - 1]!.length).toBe(1024);
			expect(result.page.next).toMatchObject({ sha256: retained.sha256, page: page + 1, executable: "gjc" });
			expect(result.page.next!.argv.slice(-3)).toEqual(["--error-agent-dir", root, "--json"]);
			page++;
		}
		const reconstructed = Buffer.concat(chunks);
		expect(reconstructed.equals(await fs.readFile(slot))).toBe(true);
		expect(createHash("sha256").update(reconstructed).digest("hex")).toBe(retained.sha256);
		expect(JSON.parse(reconstructed.toString()).references).toEqual([{ kind: "operationRef", value }]);
		expect(
			await readCommandEvidence({
				agentDir: root,
				family: "sdk",
				id: retained.id,
				sha256: retained.sha256,
				page: page + 1,
			}),
		).toMatchObject({ status: "unavailable", reason: "invalid_request" });
	});
});

posix("allowlist excludes arbitrary nested details and preserves explicitly safe idempotency values", async () => {
	await fixture(async (root, slot) => {
		const result = await publishCommandEvidence(
			{
				agentDir: root,
				command: ["sdk"],
				error: { ...error, ...{ details: "secret-token", message: "secret-token" } },
				references: [{ kind: "idempotencyKey", value: "  exact-key\n", ...{ secret: "secret-token" } }],
			},
			{ family: "sdk" },
		);
		expect(result.status).toBe("retained");
		const bytes = await fs.readFile(slot, "utf8");
		expect(bytes).not.toContain("secret-token");
		expect(JSON.parse(bytes).references).toEqual([{ kind: "idempotencyKey", value: "  exact-key\n" }]);
	});
});

posix("wrong digest, family, ID, invalid page, missing scope and removed bytes never replay", async () => {
	await fixture(async (root, slot) => {
		const retained = await publish(root, "reference");
		if (retained.status !== "retained") throw new Error(retained.reason);
		const request = { agentDir: root, family: "sdk" as const, id: retained.id, sha256: retained.sha256 };
		expect(await readCommandEvidence({ ...request, sha256: "0".repeat(64) })).toMatchObject({
			status: "unavailable",
			reason: "evidence_changed",
		});
		expect(await readCommandEvidence({ ...request, family: "daemon" })).toMatchObject({
			status: "unavailable",
			reason: "evidence_unavailable",
		});
		expect(await readCommandEvidence({ ...request, id: "../escape" })).toMatchObject({
			status: "unavailable",
			reason: "invalid_request",
		});
		for (const page of [0, -1, 1.5, Infinity, 1025])
			expect(await readCommandEvidence({ ...request, page })).toMatchObject({
				status: "unavailable",
				reason: "invalid_request",
			});
		expect(await readCommandEvidence({ ...request, agentDir: path.join(root, "missing") })).toMatchObject({
			status: "unavailable",
			reason: "evidence_unavailable",
		});
		await fs.unlink(slot);
		expect(await readCommandEvidence(request)).toMatchObject({
			status: "unavailable",
			reason: "evidence_unavailable",
			continuation: null,
		});
	});
});

posix("expired evidence is refused, lazily reclaimed by publication, and future clocks fail closed", async () => {
	await fixture(async (root, slot) => {
		const retained = await publish(root, "reference");
		if (retained.status !== "retained") throw new Error(retained.reason);
		const record = JSON.parse(await fs.readFile(slot, "utf8"));
		record.createdAt = new Date(Date.now() - 86_400_001).toISOString();
		record.expiresAt = new Date(Date.parse(record.createdAt) + 86_400_000).toISOString();
		await fs.writeFile(slot, `${JSON.stringify(record)}\n`);
		const request = { agentDir: root, family: "sdk" as const, id: retained.id, sha256: retained.sha256 };
		expect(await readCommandEvidence(request)).toMatchObject({
			status: "unavailable",
			reason: "evidence_unavailable",
		});
		expect((await publish(root, "replacement")).status).toBe("retained");
		const replacement = JSON.parse(await fs.readFile(slot, "utf8"));
		expect(replacement.id).not.toBe(retained.id);
		replacement.createdAt = new Date(Date.now() + 60_000).toISOString();
		replacement.expiresAt = new Date(Date.parse(replacement.createdAt) + 86_400_000).toISOString();
		await fs.writeFile(slot, `${JSON.stringify(replacement)}\n`);
		expect(await readCommandEvidence({ ...request, id: replacement.id })).toMatchObject({
			status: "unavailable",
			reason: "evidence_clock_invalid",
		});
	});
});

posix("changed canonical bytes and malformed records report distinct unavailable causes", async () => {
	await fixture(async (root, slot) => {
		const retained = await publish(root, "reference");
		if (retained.status !== "retained") throw new Error(retained.reason);
		const request = { agentDir: root, family: "sdk" as const, id: retained.id, sha256: retained.sha256 };
		const record = JSON.parse(await fs.readFile(slot, "utf8"));
		record.references[0].value = "changed-reference";
		await fs.writeFile(slot, `${JSON.stringify(record)}\n`);
		expect(await readCommandEvidence(request)).toMatchObject({ status: "unavailable", reason: "evidence_changed" });
		await fs.writeFile(slot, "{");
		expect(await readCommandEvidence(request)).toMatchObject({ status: "unavailable", reason: "evidence_corrupt" });
	});
});

posix("oversized locator fails before publication with no fabricated continuation", async () => {
	await fixture(async root => {
		expect(await publish(root, "reference".repeat(1000), "x".repeat(9000))).toMatchObject({
			status: "unavailable",
			reason: "locator_too_large",
			continuation: null,
		});
		expect(await fs.readdir(root)).toEqual([]);
	});
});

posix(
	"exact 24-hour expiry, non-sliding reads, rollback and busy-lock expiry use canonical unmodified bytes",
	async () => {
		await fixture(async (root, slot) => {
			const created = Date.now();
			let now = created;
			const clock = spyOn(Date, "now").mockImplementation(() => now);
			try {
				const retained = await publish(root, "immutable-time-reference");
				if (retained.status !== "retained") throw new Error(retained.reason);
				const bytes = await fs.readFile(slot);
				const stat = await fs.stat(slot);
				const record = JSON.parse(bytes.toString());
				expect(Date.parse(record.createdAt)).toBe(created);
				expect(Date.parse(record.expiresAt)).toBe(created + 86_400_000);
				expect(retained.expiresAt).toBe(record.expiresAt);
				const request = { agentDir: root, family: "sdk" as const, id: retained.id, sha256: retained.sha256 };
				for (const instant of [created, created + 1, created + 86_400_000 - 1, created + 86_400_000 - 1]) {
					now = instant;
					expect((await readCommandEvidence(request)).status).toBe("available");
					expect((await fs.readFile(slot)).equals(bytes)).toBe(true);
					const after = await fs.stat(slot);
					expect(after.mtimeMs).toBe(stat.mtimeMs);
					expect(after.ctimeMs).toBe(stat.ctimeMs);
				}
				for (const instant of [created + 86_400_000, created + 86_400_001]) {
					now = instant;
					expect(await readCommandEvidence(request)).toMatchObject({
						status: "unavailable",
						reason: "evidence_unavailable",
						continuation: null,
					});
				}
				now = created - 1;
				expect(await readCommandEvidence(request)).toMatchObject({
					status: "unavailable",
					reason: "evidence_clock_invalid",
					continuation: null,
				});
				const lock = path.join(path.dirname(slot), "lock");
				await fs.writeFile(lock, "", { mode: 0o600, flag: "wx" });
				const lockStat = await fs.stat(lock);
				now = created + 86_400_000;
				expect(await readCommandEvidence(request)).toMatchObject({
					status: "unavailable",
					reason: "evidence_unavailable",
					continuation: null,
				});
				expect(await publish(root, "must-not-steal-lock")).toMatchObject({
					status: "unavailable",
					reason: "store_busy",
					continuation: null,
				});
				expect((await fs.stat(lock)).ino).toBe(lockStat.ino);
				expect((await fs.readFile(slot)).equals(bytes)).toBe(true);
				expect((await fs.stat(slot)).mtimeMs).toBe(stat.mtimeMs);
			} finally {
				clock.mockRestore();
			}
		});
	},
);
