import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	EVIDENCE_LIMITS,
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
async function fixture(run: (root: string, store: string) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), "gjc-evidence-"));
	try {
		await run(root, path.join(root, "cli-error-evidence-v1"));
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}
function publish(root: string, value = "safe-operation-reference") {
	return publishCommandEvidence(
		{ agentDir: root, command: ["sdk", "session", "send"], error, references: [{ kind: "operationRef", value }] },
		{ family: "sdk" },
	);
}

posix("publication proves restrictive immutable files and permits reads while writer lock exists", async () => {
	await fixture(async (root, store) => {
		const retained = await publish(root);
		expect(retained.status).toBe("retained");
		if (retained.status !== "retained") return;
		expect((await fs.stat(store)).mode & 0o7777).toBe(0o700);
		const stat = await fs.stat(path.join(store, "00.json"));
		expect(stat.mode & 0o7777).toBe(0o600);
		expect(stat.nlink).toBe(1);
		expect(await fs.readdir(store)).toEqual(["00.json"]);
		await fs.writeFile(path.join(store, "lock"), "", { mode: 0o600 });
		expect(await publish(root)).toMatchObject({ status: "unavailable", reason: "store_busy", continuation: null });
		expect(
			(await readCommandEvidence({ agentDir: root, family: "sdk", id: retained.id, sha256: retained.sha256 }))
				.status,
		).toBe("available");
		expect(await fs.readFile(path.join(store, "lock"), "utf8")).toBe("");
	});
});

posix(
	"unsafe store permissions, symlinks, hardlinks, unexpected layout, and corrupt records fail closed without repair",
	async () => {
		for (const scenario of ["mode", "symlink", "hardlink", "unexpected", "corrupt"] as const) {
			await fixture(async (root, store) => {
				await fs.mkdir(store, { mode: 0o700 });
				if (scenario === "mode") await fs.chmod(store, 0o755);
				if (scenario === "symlink") await fs.symlink(path.join(root, "absent"), path.join(store, "00.json"));
				if (scenario === "hardlink") {
					await fs.writeFile(path.join(root, "outside"), "untouched", { mode: 0o600 });
					await fs.link(path.join(root, "outside"), path.join(store, "00.json"));
				}
				if (scenario === "unexpected")
					await fs.writeFile(path.join(store, "user-file"), "untouched", { mode: 0o600 });
				if (scenario === "corrupt") await fs.writeFile(path.join(store, "00.json"), "not-json", { mode: 0o600 });
				const result = await publish(root);
				expect(result).toMatchObject({ status: "unavailable", continuation: null });
				if (scenario === "mode") expect((await fs.stat(store)).mode & 0o777).toBe(0o755);
				if (scenario === "hardlink")
					expect(await fs.readFile(path.join(root, "outside"), "utf8")).toBe("untouched");
				if (scenario === "unexpected")
					expect(await fs.readFile(path.join(store, "user-file"), "utf8")).toBe("untouched");
				if (scenario === "corrupt") expect(await fs.readFile(path.join(store, "00.json"), "utf8")).toBe("not-json");
			});
		}
	},
);

posix("untrusted writable parents and symlink ancestors are refused", async () => {
	await fixture(async root => {
		const parent = path.join(root, "untrusted");
		await fs.mkdir(parent, { mode: 0o700 });
		await fs.chmod(parent, 0o777);
		await fs.mkdir(path.join(parent, "agent"), { mode: 0o700 });
		expect(await publish(path.join(parent, "agent"))).toMatchObject({ status: "unavailable", reason: "unsafe_path" });
		await fs.symlink(root, path.join(root, "alias"));
		expect(await publish(path.join(root, "alias"))).toMatchObject({ status: "unavailable", reason: "unsafe_path" });
	});
});

posix("bounded pending remnants are reclaimed but oversized pending is not deleted", async () => {
	await fixture(async (root, store) => {
		await fs.mkdir(store, { mode: 0o700 });
		await fs.writeFile(path.join(store, "pending"), "interrupted-write", { mode: 0o600 });
		expect((await publish(root)).status).toBe("retained");
		await fs.writeFile(path.join(store, "pending"), Buffer.alloc(EVIDENCE_LIMITS.recordBytes + 1), { mode: 0o600 });
		expect(await publish(root)).toMatchObject({ status: "unavailable", reason: "store_corrupt" });
		expect((await fs.stat(path.join(store, "pending"))).size).toBe(EVIDENCE_LIMITS.recordBytes + 1);
	});
});

posix("record byte limit admits exact cap, refuses cap plus one, and does not initialize oversize store", async () => {
	await fixture(async (root, store) => {
		const initial = await publish(root, "");
		expect(initial.status).toBe("retained");
		if (initial.status !== "retained") return;
		const fill = "x".repeat(EVIDENCE_LIMITS.recordBytes - initial.bytes);
		const exact = await publish(root, fill);
		expect(exact).toMatchObject({ status: "retained", bytes: EVIDENCE_LIMITS.recordBytes });
		expect(await publish(root, `${fill}x`)).toMatchObject({
			status: "unavailable",
			reason: "record_too_large",
			continuation: null,
		});
		expect(await fs.readdir(store)).toHaveLength(2);
		const other = path.join(root, "other");
		await fs.mkdir(other, { mode: 0o700 });
		expect(await publish(other, "x".repeat(EVIDENCE_LIMITS.recordBytes + 1))).toMatchObject({
			status: "unavailable",
			reason: "record_too_large",
		});
		expect(await fs.readdir(other)).toEqual([]);
	});
});

posix("64 occupied slots are never evicted", async () => {
	await fixture(async (root, store) => {
		const first = await publish(root);
		expect(first.status).toBe("retained");
		const original = await fs.readFile(path.join(store, "00.json"), "utf8");
		for (let n = 1; n < 64; n++) {
			const record = JSON.parse(original);
			record.id = n.toString(16).padStart(32, "0");
			await fs.writeFile(path.join(store, `${String(n).padStart(2, "0")}.json`), `${JSON.stringify(record)}\n`, {
				mode: 0o600,
			});
		}
		expect(await publish(root)).toMatchObject({ status: "unavailable", reason: "quota_exceeded" });
		expect(await fs.readdir(store)).toHaveLength(64);
		expect(await fs.readFile(path.join(store, "00.json"), "utf8")).toBe(original);
	});
});

posix("aggregate 16MiB allows no further record and preserves all committed bytes", async () => {
	await fixture(async (root, store) => {
		const seed = await publish(root, "");
		if (seed.status !== "retained") throw new Error(seed.reason);
		const raw = JSON.parse(await fs.readFile(path.join(store, "00.json"), "utf8"));
		raw.references[0].value = "x".repeat(EVIDENCE_LIMITS.recordBytes - seed.bytes);
		for (let n = 0; n < 16; n++) {
			raw.id = n.toString(16).padStart(32, "0");
			await fs.writeFile(path.join(store, `${String(n).padStart(2, "0")}.json`), `${JSON.stringify(raw)}\n`, {
				mode: 0o600,
			});
		}
		expect(await publish(root)).toMatchObject({ status: "unavailable", reason: "quota_exceeded" });
		expect(await fs.readdir(store)).toHaveLength(16);
	});
});

posix("concurrent writers attempt once and leave only bounded committed records", async () => {
	await fixture(async (root, store) => {
		const results = await Promise.all(Array.from({ length: 6 }, (_, n) => publish(root, String(n))));
		expect(results.some(result => result.status === "retained")).toBe(true);
		for (const result of results) if (result.status === "unavailable") expect(result.reason).toBe("store_busy");
		expect((await fs.readdir(store)).every(name => /^\d\d\.json$/.test(name))).toBe(true);
	});
});

(process.platform === "win32" ? test : test.skip)("Windows without ACL proof is unavailable", async () => {
	await fixture(async root => {
		expect(await publish(root)).toMatchObject({ status: "unavailable", reason: "permission_unsupported" });
	});
});

posix("publication fault ladder never advertises retention and preserves prior immutable evidence", async () => {
	for (const phase of ["write", "file-sync", "link", "directory-sync", "readback", "cleanup"] as const) {
		await fixture(async (root, store) => {
			const prior = await publish(root);
			if (prior.status !== "retained") throw new Error(prior.reason);
			const original = await fs.readFile(path.join(store, "00.json"));
			const calls: string[] = [];
			const result = await publishCommandEvidence(
				{
					agentDir: root,
					command: ["sdk"],
					error,
					references: [{ kind: "operationRef", value: "new-safe-reference" }],
				},
				{ family: "sdk" },
				{
					before(current) {
						calls.push(current);
						if (current === phase)
							throw Object.assign(new Error("private-path-secret-canary"), {
								code: phase === "write" ? "ENOSPC" : "EROFS",
							});
					},
				},
			);
			expect(result).toMatchObject({ status: "unavailable", reason: "io_error", continuation: null });
			expect(JSON.stringify(result)).not.toContain("private-path-secret-canary");
			expect(calls.filter(value => value === phase)).toHaveLength(1);
			expect((await fs.readFile(path.join(store, "00.json"))).equals(original)).toBe(true);
			const entries = await fs.readdir(store);
			expect(entries.length).toBeLessThanOrEqual(3);
			let bytes = 0;
			for (const name of entries) bytes += (await fs.stat(path.join(store, name))).size;
			expect(bytes).toBeLessThanOrEqual(2 * EVIDENCE_LIMITS.recordBytes + 4096);
			expect(entries.includes("lock")).toBe(phase === "cleanup");
			expect(
				(await readCommandEvidence({ agentDir: root, family: "sdk", id: prior.id, sha256: prior.sha256 })).status,
			).toBe("available");
		});
	}
});

posix("readback detects altered bytes and atomic publication never overwrites a newly occupied slot", async () => {
	for (const phase of ["link", "readback"] as const) {
		await fixture(async (root, store) => {
			await publish(root);
			const original = await fs.readFile(path.join(store, "00.json"));
			const result = await publishCommandEvidence(
				{ agentDir: root, command: ["sdk"], error, references: [] },
				{ family: "sdk" },
				{
					async before(current) {
						if (current !== phase) return;
						if (phase === "link")
							await fs.writeFile(path.join(store, "01.json"), original, { mode: 0o600, flag: "wx" });
						else await fs.writeFile(path.join(store, "01.json"), "changed-readback", { mode: 0o600 });
					},
				},
			);
			expect(result).toMatchObject({ status: "unavailable", continuation: null });
			if (phase === "readback") expect(result).toMatchObject({ reason: "verification_failed" });
			expect((await fs.readFile(path.join(store, "00.json"))).equals(original)).toBe(true);
			if (phase === "link") expect((await fs.readFile(path.join(store, "01.json"))).equals(original)).toBe(true);
		});
	}
});

posix("generated ID collision fails once before pending publication", async () => {
	await fixture(async (root, store) => {
		const prior = await publish(root);
		if (prior.status !== "retained") throw new Error(prior.reason);
		const bytes = await fs.readFile(path.join(store, "00.json"));
		const phases: string[] = [];
		const result = await publishCommandEvidence(
			{ agentDir: root, command: ["sdk"], error, references: [] },
			{ family: "sdk" },
			{
				id: prior.id,
				before: phase => {
					phases.push(phase);
				},
			},
		);
		expect(result).toMatchObject({ status: "unavailable", reason: "verification_failed", continuation: null });
		expect(phases).toEqual(["cleanup"]);
		expect(await fs.readdir(store)).toEqual(["00.json"]);
		expect((await fs.readFile(path.join(store, "00.json"))).equals(bytes)).toBe(true);
	});
});

posix("actual publisher exit leaves bounded crash remnants and its lock is never stolen", async () => {
	for (const phase of ["file-sync", "directory-sync", "cleanup"] as const) {
		await fixture(async (root, store) => {
			const prior = await publish(root);
			if (prior.status !== "retained") throw new Error(prior.reason);
			const original = await fs.readFile(path.join(store, "00.json"));
			const modulePath = path.resolve(import.meta.dir, "../src/cli/public-command-evidence.ts");
			const source = `import {publishCommandEvidence} from ${JSON.stringify(modulePath)}; await publishCommandEvidence(${JSON.stringify({ agentDir: root, command: ["sdk"], error, references: [] })}, {family:"sdk"}, {before(phase){if(phase===${JSON.stringify(phase)})process.exit(73)}}); process.exit(99);`;
			const child = Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" });
			const [exit, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(exit).toBe(73);
			expect(stdout).toBe("");
			expect(stderr).toBe("");
			const before = (await fs.readdir(store)).sort();
			expect(before).toContain("lock");
			expect(before.length).toBeLessThanOrEqual(3);
			expect(await publish(root)).toMatchObject({ status: "unavailable", reason: "store_busy", continuation: null });
			expect((await fs.readdir(store)).sort()).toEqual(before);
			expect((await fs.readFile(path.join(store, "00.json"))).equals(original)).toBe(true);
			expect(
				(await readCommandEvidence({ agentDir: root, family: "sdk", id: prior.id, sha256: prior.sha256 })).status,
			).toBe("available");
		});
	}
});

posix(
	"aggregate admission is calibrated against committed canonical bytes at cap minus one, cap, and cap plus one",
	async () => {
		for (const delta of [-1, 0, 1]) {
			await fixture(async (root, store) => {
				const seed = await publish(root, "");
				if (seed.status !== "retained") throw new Error(seed.reason);
				const template = JSON.parse(await fs.readFile(path.join(store, "00.json"), "utf8"));
				const existingTarget = EVIDENCE_LIMITS.totalBytes + delta - seed.bytes;
				let remaining = existingTarget;
				for (let n = 0; remaining > 0; n++) {
					const desired = Math.min(EVIDENCE_LIMITS.recordBytes, remaining);
					const record = {
						...template,
						id: n.toString(16).padStart(32, "0"),
						references: [{ kind: "operationRef", value: "x".repeat(desired - seed.bytes) }],
					};
					const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
					expect(bytes.length).toBe(desired);
					await fs.writeFile(path.join(store, `${String(n).padStart(2, "0")}.json`), bytes, { mode: 0o600 });
					remaining -= bytes.length;
				}
				const committedBytes = async () => {
					let total = 0;
					for (const name of await fs.readdir(store))
						if (/^\d\d\.json$/.test(name)) total += (await fs.stat(path.join(store, name))).size;
					return total;
				};
				expect(await committedBytes()).toBe(existingTarget);
				const result = await publish(root, "");
				if (delta <= 0) {
					expect(result.status).toBe("retained");
					expect(await committedBytes()).toBe(EVIDENCE_LIMITS.totalBytes + delta);
				} else {
					expect(result).toMatchObject({ status: "unavailable", reason: "quota_exceeded", continuation: null });
					expect(await committedBytes()).toBe(existingTarget);
				}
			});
		}
	},
);

posix("crash-style multiply linked pending remains unsafe and is never repaired or unlinked", async () => {
	await fixture(async (root, store) => {
		await publish(root);
		const prior = await fs.readFile(path.join(store, "00.json"));
		await fs.writeFile(path.join(store, "pending"), "interrupted-link-publication", { mode: 0o600 });
		await fs.link(path.join(store, "pending"), path.join(store, "01.json"));
		const result = await publish(root);
		expect(result).toMatchObject({ status: "unavailable", reason: "unsafe_path", continuation: null });
		expect((await fs.stat(path.join(store, "pending"))).nlink).toBe(2);
		expect((await fs.stat(path.join(store, "01.json"))).nlink).toBe(2);
		expect((await fs.readFile(path.join(store, "00.json"))).equals(prior)).toBe(true);
		expect((await fs.readdir(store)).sort()).toEqual(["00.json", "01.json", "pending"]);
	});
});
