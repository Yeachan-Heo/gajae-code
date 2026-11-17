import { afterEach, describe, expect, it, vi } from "bun:test";
import { createHmac } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { dispatchPublicCommand } from "../src/cli/public-command-entry";
import { PUBLIC_COMMAND_DIAGNOSTICS, type PublicCommandDiagnosticCode } from "../src/cli/public-command-errors";
import Sdk from "../src/commands/sdk";
import { MAX_SPAWN_IDEMPOTENCY_KEY_LENGTH } from "../src/sdk/broker/identity";
import { LifecycleLedger, type LifecycleLedgerEntry } from "../src/sdk/broker/lifecycle-ledger";
import { SpawnAuthorityStore } from "../src/sdk/broker/spawn-authority";
import { renderSpawnAnchorAttestation, runSpawnAnchorAttestation } from "../src/sdk/cli/spawn-anchor-attestation-cli";

const identityKey = "ab".repeat(32);
const roots: string[] = [];
const cli = path.resolve(import.meta.dir, "../src/cli.ts");
const canTestPermissions = process.platform !== "win32" && process.getuid?.() !== 0;

interface Fixture {
	root: string;
	agentDir: string;
	ledgerPath: string;
	attestationPath: string;
	evidencePath: string;
}

async function fixture(): Promise<Fixture> {
	const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "gjc-attest-spawn-"));
	roots.push(root);
	const agentDir = path.join(root, "agent");
	await Bun.write(path.join(agentDir, "sdk", "broker.identity"), `${identityKey}\n`);
	const evidencePath = path.join(root, "evidence.jsonl");
	await Bun.write(evidencePath, "");
	return {
		root,
		agentDir,
		ledgerPath: path.join(agentDir, "sdk", "lifecycle-ledger.jsonl"),
		attestationPath: path.join(agentDir, "sdk", "lifecycle-ledger.spawn-anchor-attestation.json"),
		evidencePath,
	};
}

function identity(token: string, operation = "session.spawn", version = 3): string {
	return createHmac("sha256", Buffer.from(identityKey, "hex"))
		.update(`${version}|${operation}|${token}${version === 4 ? "|" : ""}`)
		.digest("hex");
}

function row(id: string, fields: Partial<LifecycleLedgerEntry> = {}): LifecycleLedgerEntry {
	return { version: 1, identity: id, requestHash: "request", state: "accepted", ts: 1, ...fields };
}

async function writeRows(f: Fixture, rows: LifecycleLedgerEntry[]): Promise<void> {
	await Bun.write(f.ledgerPath, `${rows.map(entry => JSON.stringify(entry)).join("\n")}\n`);
}

async function cliCommand(f: Fixture, flags: string[]) {
	const proc = Bun.spawn(
		[process.execPath, cli, "sdk", "broker", "attest-spawn-anchors", "--agent-dir", f.agentDir, ...flags],
		{
			cwd: f.root,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				HOME: f.root,
				GJC_CODING_AGENT_DIR: f.agentDir,
				PI_CODING_AGENT_DIR: f.agentDir,
				GJC_MALLOC_ENV_REEXEC: "1",
				BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
			},
		},
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, code };
}

function expectFailureEnvelope(
	result: { stdout: string; stderr: string; code: number },
	diagnostic: PublicCommandDiagnosticCode,
	outcome: "not-applied" | "unknown" | "applied" = "not-applied",
): void {
	expect(result.code).toBe(1);
	expect(result.stderr).toBe("");
	expect(JSON.parse(result.stdout)).toEqual({
		schema: "gjc.command-error",
		version: 1,
		ok: false,
		command: ["sdk", "broker", "attest-spawn-anchors"],
		error: {
			code: "operation_failed",
			category: "operation",
			message: "The operation failed. Its outcome could not be established.",
			retryability: "unknown",
			outcomeCertainty: outcome,
			references: [],
			nextSteps: [
				{
					description:
						"Keep the broker stopped. Preserve the existing attestation and restore the original sdk/broker.identity, then rerun this command without --write to inspect the result.",
					disruption: "none",
					requiresConfirmation: false,
				},
				...(outcome === "unknown"
					? [
							{
								description:
									"The operation outcome is unknown. Reconcile available evidence and do not blindly retry.",
								disruption: "none",
								requiresConfirmation: false,
							},
						]
					: []),
			],
		},
		omittedOptional: [],
		complete: true,
		evidence: { status: "inline" },
		continuation: null,
		diagnostics: [{ code: diagnostic, message: PUBLIC_COMMAND_DIAGNOSTICS[diagnostic] }],
	});
	expect(result.stdout.endsWith("\n")).toBe(true);
	expect(result.stdout).not.toMatch(/[a-f0-9]{64}/i);
}

async function dispatchInProcess(f: Fixture, flags: string[], failFirstOutput = false) {
	let stdout = "";
	let stderr = "";
	const out = vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
		if (failFirstOutput) {
			failFirstOutput = false;
			throw new Error("private-output-error");
		}
		stdout += String(chunk);
		return true;
	});
	const err = vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
		stderr += String(chunk);
		return true;
	});
	const originalExitCode = process.exitCode ?? 0;
	try {
		process.exitCode = 0;
		await dispatchPublicCommand(["broker", "attest-spawn-anchors", "--agent-dir", f.agentDir, ...flags], {
			command: "sdk",
			bin: "gjc",
			version: "test",
			load: async () => Sdk,
		});
		return { stdout, stderr, code: Number(process.exitCode) };
	} finally {
		process.exitCode = originalExitCode;
		out.mockRestore();
		err.mockRestore();
	}
}

afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("SDK spawn-anchor attestation", () => {
	it("writes a v3 proof from escaped JSONL evidence and lifts the real ledger fence", async () => {
		const f = await fixture();
		const token = "first-hand-spawn-key-canary";
		const id = identity(token);
		const ledger = await new LifecycleLedger(f.agentDir).open();
		await ledger.begin(id, "spawn-request");
		expect(ledger.hasLegacyIdentity(new Set(), { ignoreFinalRows: true })).toBe(true);
		await Bun.write(f.evidencePath, `${JSON.stringify({ text: `gjc sdk spawn --idempotency-key "${token}"` })}\n`);
		const originalLedger = await Bun.file(f.ledgerPath).text();
		const result = await cliCommand(f, ["--evidence", f.evidencePath, "--write", "--json"]);
		expect(result).toMatchObject({ code: 0 });
		expect(JSON.parse(result.stdout)).toMatchObject({ candidates: 1, proven: 1, unproven: 0, written: true });
		expect(result.stderr).toContain("next broker start");
		expect(await Bun.file(f.attestationPath).json()).toEqual({ version: 1, identities: [id] });
		if (process.platform !== "win32") expect((await fs.stat(f.attestationPath)).mode & 0o777).toBe(0o600);
		expect(await Bun.file(f.ledgerPath).text()).toBe(originalLedger);
		expect(
			(await new LifecycleLedger(f.agentDir).open()).hasLegacyIdentity(new Set(), { ignoreFinalRows: true }),
		).toBe(false);
		for (const output of [result.stdout, result.stderr]) {
			for (const secret of [token, id, identityKey]) expect(output).not.toContain(secret);
			expect(output).not.toMatch(/[a-f0-9]{64}/i);
		}
	}, 30_000);

	it("does not prove a session.create HMAC or an absent token, and both remain fencing after write", async () => {
		const f = await fixture();
		const spawn = identity("spawn-positive");
		const create = identity("create-negative", "session.create");
		const unknown = identity("missing-negative");
		const ledger = await new LifecycleLedger(f.agentDir).open();
		for (const id of [spawn, create, unknown]) await ledger.begin(id, "request");
		await Bun.write(f.evidencePath, '"spawn-positive" "create-negative"');
		const result = await runSpawnAnchorAttestation({ agentDir: f.agentDir, evidence: [f.evidencePath], write: true });
		expect(result).toMatchObject({ candidates: 3, proven: 1, unproven: 2, written: true });
		expect(await Bun.file(f.attestationPath).json()).toEqual({ version: 1, identities: [spawn] });
		const reopened = await new LifecycleLedger(f.agentDir).open();
		expect(reopened.hasLegacyIdentity(new Set([unknown]), { ignoreFinalRows: true })).toBe(true);
		expect(reopened.hasLegacyIdentity(new Set([create]), { ignoreFinalRows: true })).toBe(true);
		expect(reopened.hasLegacyIdentity(new Set([create, unknown]), { ignoreFinalRows: true })).toBe(false);
	});

	it("dry run leaves all broker state untouched and never prints identities or evidence tokens", async () => {
		const f = await fixture();
		const token = "dry-run-key-canary";
		const id = identity(token);
		await writeRows(f, [row(id)]);
		await Bun.write(f.evidencePath, token);
		const before = await Bun.file(f.ledgerPath).text();
		const files = await fs.readdir(path.dirname(f.ledgerPath));
		const result = await runSpawnAnchorAttestation({ agentDir: f.agentDir, evidence: [f.evidencePath] });
		expect(result).toMatchObject({ candidates: 1, proven: 1, written: false });
		expect(await Bun.file(f.attestationPath).exists()).toBe(false);
		expect(await Bun.file(f.ledgerPath).text()).toBe(before);
		expect(await fs.readdir(path.dirname(f.ledgerPath))).toEqual(files);
		for (const json of [false, true]) {
			const output = renderSpawnAnchorAttestation(result, json);
			for (const secret of [token, id, identityKey]) expect(output).not.toContain(secret);
			expect(output).not.toMatch(/[a-f0-9]{64}/i);
		}
	});

	it("unions a valid attestation and excludes current claims and already-attested rows", async () => {
		const f = await fixture();
		const prior = identity("prior-token");
		const next = identity("next-token");
		const current = identity("current-token");
		const preserved = "preserved-identity-not-in-this-ledger";
		await writeRows(f, [row(prior), row(next), row(current)]);
		await Bun.write(f.attestationPath, JSON.stringify({ version: 1, identities: [prior, preserved] }));
		const authority = new SpawnAuthorityStore(f.agentDir, identityKey);
		await authority.open();
		await authority.reserveManagedKeyAliases([identity("managed-alias")], identity("managed-native"), f.root);
		await authority.claimOrJoin(current, "c".repeat(64));
		const journal = (await Bun.file(authority.file).text()).trim().split("\n");
		await Bun.write(authority.file, `${journal.map(line => `${line} // archived journal annotation`).join("\n")}\n`);
		await new SpawnAuthorityStore(f.agentDir, identityKey).open();
		await Bun.write(f.evidencePath, "prior-token next-token current-token");
		const result = await runSpawnAnchorAttestation({ agentDir: f.agentDir, evidence: [f.evidencePath], write: true });
		expect(result).toMatchObject({ candidates: 1, proven: 1, unproven: 0, alreadyAttested: 1, written: true });
		expect(await Bun.file(f.attestationPath).json()).toEqual({
			version: 1,
			identities: [prior, next, preserved].sort(),
		});
		if (process.platform !== "win32") expect((await fs.stat(f.attestationPath)).mode & 0o777).toBe(0o600);
		expect((await fs.readdir(path.dirname(f.ledgerPath))).some(name => name.endsWith(".tmp"))).toBe(false);
	});

	it("the real CLI dry run emits counts without writing agent state", async () => {
		const f = await fixture();
		await writeRows(f, [row(identity("cli-dry-run-canary"))]);
		await Bun.write(f.evidencePath, "cli-dry-run-canary");
		const before = await fs.readdir(f.agentDir, { recursive: true });
		const ledgerBefore = await Bun.file(f.ledgerPath).text();
		const result = await cliCommand(f, ["--evidence", f.evidencePath, "--json"]);
		expect(result).toMatchObject({ code: 0 });
		expect(JSON.parse(result.stdout)).toMatchObject({ candidates: 1, proven: 1, written: false });
		expect(await fs.readdir(f.agentDir, { recursive: true })).toEqual(before);
		expect(await Bun.file(f.ledgerPath).text()).toBe(ledgerBefore);
	}, 30_000);

	it("fails nonzero without altering a malformed existing attestation", async () => {
		const f = await fixture();
		const token = "malformed-attestation-token";
		await writeRows(f, [row(identity(token))]);
		await Bun.write(f.evidencePath, token);
		const malformed = '{"version":1,"identities":[7]}';
		await Bun.write(f.attestationPath, malformed);
		const result = await cliCommand(f, ["--evidence", f.evidencePath, "--write", "--json"]);
		expectFailureEnvelope(result, "spawn_anchor_attestation_invalid");
		expect(await Bun.file(f.attestationPath).text()).toBe(malformed);
		expect(result.stdout).not.toContain(token);
		expect(result.stderr).not.toContain(token);
	}, 30_000);

	it("never candidates multi-row, keyed, marked or target-bound histories even with matching evidence", async () => {
		const f = await fixture();
		const multi = identity("multi");
		const rows = [
			row(multi),
			row(multi, { state: "effect_started", ts: 2 }),
			row(identity("keyed"), { operationKey: "session.create\u0000keyed" }),
			row(identity("marked"), { spawnAnchor: true }),
			row(identity("target"), { intendedSessionId: "session" }),
			row(identity("fingerprint"), { fingerprint: "fingerprint" }),
			row(identity("bound"), { closeAuthorityBound: false }),
		];
		await writeRows(f, rows);
		await Bun.write(f.evidencePath, "multi keyed marked target fingerprint bound");
		const result = await runSpawnAnchorAttestation({ agentDir: f.agentDir, evidence: [f.evidencePath], write: true });
		expect(result).toMatchObject({ candidates: 0, proven: 0, written: false });
		expect(await Bun.file(f.attestationPath).exists()).toBe(false);
	});

	it("proves the v4 spawn identity format", async () => {
		const f = await fixture();
		const token = "v4-spawn-token";
		const id = identity(token, "session.spawn", 4);
		await writeRows(f, [row(id)]);
		await Bun.write(f.evidencePath, token);
		const result = await runSpawnAnchorAttestation({ agentDir: f.agentDir, evidence: [f.evidencePath], write: true });
		expect(result).toMatchObject({ candidates: 1, proven: 1, written: true });
		expect(
			(await new LifecycleLedger(f.agentDir).open()).hasLegacyIdentity(new Set(), { ignoreFinalRows: true }),
		).toBe(false);
	});

	it("fails before reading other state when broker.identity is missing and never creates it", async () => {
		const f = await fixture();
		const keyPath = path.join(f.agentDir, "sdk", "broker.identity");
		await fs.rm(keyPath);
		await Bun.write(f.ledgerPath, "malformed ledger that must not be read first");
		const result = await cliCommand(f, ["--evidence", f.evidencePath, "--write", "--json"]);
		expectFailureEnvelope(result, "spawn_anchor_identity_unavailable");
		expect(await Bun.file(keyPath).exists()).toBe(false);
		expect(await Bun.file(f.attestationPath).exists()).toBe(false);
	}, 30_000);

	it.each([
		"{not-json",
		JSON.stringify({ version: 1, identity: "invalid-shape" }),
		JSON.stringify({ ...row("future"), stateVersion: 2 }),
	])("fails closed on malformed or unsupported ledger rows (%s)", async malformed => {
		const f = await fixture();
		const id = identity("valid-but-blocked");
		await Bun.write(f.ledgerPath, `${JSON.stringify(row(id))}\n${malformed}\n`);
		await Bun.write(f.evidencePath, "valid-but-blocked");
		const original = JSON.stringify({ version: 1, identities: ["retained"] });
		await Bun.write(f.attestationPath, original);
		await expect(
			runSpawnAnchorAttestation({ agentDir: f.agentDir, evidence: [f.evidencePath], write: true }),
		).rejects.toMatchObject({ input: { proof: "pre-effect", diagnostics: ["spawn_anchor_ledger_invalid"] } });
		const result = await cliCommand(f, ["--evidence", f.evidencePath, "--write", "--json"]);
		expectFailureEnvelope(result, "spawn_anchor_ledger_invalid");
		expect(await Bun.file(f.attestationPath).text()).toBe(original);
		expect(await Bun.file(`${f.ledgerPath}.corrupt`).exists()).toBe(false);
	});

	it("excludes a structurally valid bad-digest history while attesting an unrelated proof", async () => {
		const f = await fixture();
		const good = identity("good-digest");
		const bad = identity("bad-digest");
		await writeRows(f, [row(good), row(bad, { response: { ok: true }, responseDigest: "wrong" })]);
		await Bun.write(f.evidencePath, "good-digest bad-digest");
		const result = await runSpawnAnchorAttestation({ agentDir: f.agentDir, evidence: [f.evidencePath], write: true });
		expect(result).toMatchObject({ candidates: 1, proven: 1, written: true });
		expect(await Bun.file(f.attestationPath).json()).toEqual({ version: 1, identities: [good] });
	});

	it("recursively scans regular files, deduplicates paths/tokens and skips symlinks, oversized and unreadable sources", async () => {
		const f = await fixture();
		const evidence = path.join(f.root, "evidence");
		const nested = path.join(evidence, "nested", "transcript");
		const external = path.join(f.root, "external", "secret");
		await Bun.write(nested, "known known");
		await Bun.write(external, "external-token");
		const unreadable = path.join(evidence, "unreadable");
		if (canTestPermissions) {
			await Bun.write(unreadable, "external-token");
			await fs.chmod(unreadable, 0o000);
		}
		await fs.symlink(path.dirname(external), path.join(evidence, "linked-directory"));
		await fs.symlink(external, path.join(evidence, "linked-file"));
		const large = await fs.open(path.join(evidence, "oversized"), "wx");
		await large.truncate(256 * 1024 * 1024 + 1);
		await large.close();
		await writeRows(f, [row(identity("known")), row(identity("external-token"))]);
		const result = await runSpawnAnchorAttestation({
			agentDir: f.agentDir,
			evidence: [evidence, nested, path.join(f.root, "missing-file")],
		});
		expect(result).toMatchObject({
			candidates: 2,
			proven: 1,
			unproven: 1,
			filesScanned: 1,
			filesSkipped: 4 + Number(canTestPermissions),
		});
	});

	it("proves valid byte tokens alongside invalid UTF-8 and never proves replacement-decoded text", async () => {
		const f = await fixture();
		await writeRows(f, [row(identity("known-binary-token")), row(identity("\ufffd"))]);
		await Bun.write(
			f.evidencePath,
			Buffer.concat([Buffer.from([0xff]), Buffer.from(" known-binary-token "), Buffer.from([0xff])]),
		);
		const result = await runSpawnAnchorAttestation({ agentDir: f.agentDir, evidence: [f.evidencePath] });
		expect(result).toMatchObject({ candidates: 2, proven: 1, unproven: 1, filesScanned: 1, filesSkipped: 0 });
	});

	it("handles Unicode caller keys and whitespace across stream chunks", async () => {
		const f = await fixture();
		const unicodeKey = "증거".repeat(128);
		await writeRows(f, [row(identity(unicodeKey)), row(identity("unicode-space-token"))]);
		await Bun.write(
			f.evidencePath,
			`${" ".repeat(65535)}\u3000${unicodeKey}\u2003${"unicode-space-token\u00a0".repeat(100)}`,
		);
		const result = await runSpawnAnchorAttestation({ agentDir: f.agentDir, evidence: [f.evidencePath] });
		expect(result).toMatchObject({ candidates: 2, proven: 2, filesScanned: 1, filesSkipped: 0 });
	});

	it.skipIf(!canTestPermissions)("rejects an unreadable existing attestation without replacing it", async () => {
		const f = await fixture();
		await writeRows(f, [row(identity("unreadable-attestation-token"))]);
		await Bun.write(f.evidencePath, "unreadable-attestation-token");
		const original = JSON.stringify({ version: 1, identities: ["preserved"] });
		await Bun.write(f.attestationPath, original);
		await fs.chmod(f.attestationPath, 0o000);
		try {
			await expect(
				runSpawnAnchorAttestation({ agentDir: f.agentDir, evidence: [f.evidencePath], write: true }),
			).rejects.toMatchObject({ input: { proof: "pre-effect", diagnostics: ["spawn_anchor_attestation_invalid"] } });
		} finally {
			await fs.chmod(f.attestationPath, 0o600);
		}
		expect(await Bun.file(f.attestationPath).text()).toBe(original);
	});

	it("fails closed on malformed spawn-authority journal without changing broker state", async () => {
		const f = await fixture();
		await writeRows(f, [row(identity("journal-canary"))]);
		await Bun.write(f.evidencePath, "journal-canary");
		await Bun.write(path.join(f.agentDir, "sdk", "spawn-authority.jsonl"), "{broken");
		await expect(
			runSpawnAnchorAttestation({ agentDir: f.agentDir, evidence: [f.evidencePath], write: true }),
		).rejects.toMatchObject({ input: { proof: "pre-effect", diagnostics: ["spawn_anchor_journal_invalid"] } });
		expect(await Bun.file(f.attestationPath).exists()).toBe(false);
	});

	it.skipIf(!canTestPermissions)(
		"leaves an existing attestation unchanged when atomic publication cannot create its temporary file",
		async () => {
			const f = await fixture();
			await writeRows(f, [row(identity("write-error-token"))]);
			await Bun.write(f.evidencePath, "write-error-token");
			const original = JSON.stringify({ version: 1, identities: ["preserved"] });
			await Bun.write(f.attestationPath, original);
			const sdkDir = path.dirname(f.ledgerPath);
			await fs.chmod(sdkDir, 0o500);
			try {
				await expect(
					runSpawnAnchorAttestation({ agentDir: f.agentDir, evidence: [f.evidencePath], write: true }),
				).rejects.toMatchObject({ input: { proof: "pre-effect", diagnostics: ["spawn_anchor_write_failed"] } });
			} finally {
				await fs.chmod(sdkDir, 0o700);
			}
			expect(await Bun.file(f.attestationPath).text()).toBe(original);
			expect((await fs.readdir(sdkDir)).some(name => name.endsWith(".tmp"))).toBe(false);
		},
	);

	it("succeeds with zero proofs and no write when all evidence sources are skipped", async () => {
		const f = await fixture();
		await writeRows(f, [row(identity("absent-canary"))]);
		const result = await runSpawnAnchorAttestation({
			agentDir: f.agentDir,
			evidence: [path.join(f.root, "absent")],
			write: true,
		});
		expect(result).toMatchObject({
			candidates: 1,
			proven: 0,
			unproven: 1,
			filesScanned: 0,
			filesSkipped: 1,
			written: false,
		});
		expect(await Bun.file(f.attestationPath).exists()).toBe(false);
	});

	it("splits all specified delimiters, rejects oversized/control-bearing tokens, and preserves chunk-boundary tokens", async () => {
		const f = await fixture();
		const tokens = [
			"first",
			"second",
			"third",
			"fourth",
			"fifth",
			"sixth",
			"seventh",
			"eighth",
			"ninth",
			"tenth",
			"eleventh",
			"twelfth",
			"thirteenth",
			"fourteenth",
			"fifteenth",
			"sixteenth",
			"seventeenth",
			"eighteenth",
		];
		const separators = [" ", '"', "'", "`", "\\", ",", ";", "|", "=", "(", ")", "[", "]", "{", "}", "<", ">"];
		await writeRows(f, [
			...tokens.map(token => row(identity(token))),
			row(identity("x".repeat(MAX_SPAWN_IDEMPOTENCY_KEY_LENGTH))),
			row(identity("control\u0000token")),
		]);
		await Bun.write(
			f.evidencePath,
			`${tokens.map((token, index) => token + (separators[index] ?? " ")).join("")}${"x".repeat(MAX_SPAWN_IDEMPOTENCY_KEY_LENGTH + 1)} control\u0000token\n${" ".repeat(65530)} eighteenth`,
		);
		const result = await runSpawnAnchorAttestation({ agentDir: f.agentDir, evidence: [f.evidencePath] });
		expect(result).toMatchObject({ candidates: 20, proven: 18, unproven: 2, filesScanned: 1 });
	});

	it("has local help and requires evidence through the real registry boundary", async () => {
		const f = await fixture();
		const help = await cliCommand(f, ["--help", "--help-section", "usage", "--json"]);
		expect(help.code).toBe(0);
		expect(JSON.parse(help.stdout)).toMatchObject({
			schema: "gjc.command-help",
			command: ["sdk", "broker", "attest-spawn-anchors"],
		});
		expect(help.stdout).toContain("evidence");
		const usage = await cliCommand(f, ["--json"]);
		expect(usage.code).toBe(2);
		expect(await Bun.file(f.attestationPath).exists()).toBe(false);
	}, 30_000);

	it.each([257, 512, 513])("enforces the actual spawn caller-key limit for %i-character evidence", async length => {
		const f = await fixture();
		const token = "k".repeat(length);
		await writeRows(f, [row(identity(token))]);
		await Bun.write(f.evidencePath, token);
		const result = await runSpawnAnchorAttestation({ agentDir: f.agentDir, evidence: [f.evidencePath], write: true });
		const accepted = length <= MAX_SPAWN_IDEMPOTENCY_KEY_LENGTH;
		expect(result).toMatchObject({
			candidates: 1,
			proven: Number(accepted),
			unproven: Number(!accepted),
			written: accepted,
		});
		expect(await Bun.file(f.attestationPath).exists()).toBe(accepted);
		if (accepted)
			expect(
				(await new LifecycleLedger(f.agentDir).open()).hasLegacyIdentity(new Set(), { ignoreFinalRows: true }),
			).toBe(false);
	});

	it("proves a maximum-length multibyte UTF-8 spawn caller key", async () => {
		const f = await fixture();
		const token = "증".repeat(MAX_SPAWN_IDEMPOTENCY_KEY_LENGTH);
		await writeRows(f, [row(identity(token))]);
		await Bun.write(f.evidencePath, token);
		const result = await runSpawnAnchorAttestation({ agentDir: f.agentDir, evidence: [f.evidencePath] });
		expect(result).toMatchObject({ candidates: 1, proven: 1, unproven: 0 });
	});

	it.each([
		"shape",
		"unsupported-version",
		"bad-integrity",
		"missing-integrity",
		"claim-history",
		"reservation-history",
		"alias-conflict",
	])("fails closed on authenticated journal replay violation: %s", async damage => {
		const f = await fixture();
		const id = identity("journal-proof-canary");
		await writeRows(f, [row(id)]);
		await Bun.write(f.evidencePath, "journal-proof-canary");
		const store = new SpawnAuthorityStore(f.agentDir, identityKey);
		await store.open();
		await store.claimOrJoin(identity("current-claim"), "d".repeat(64));
		const alias = identity("managed-alias");
		await store.reserveManagedKeyAliases([alias], identity("managed-native"), f.root);
		const rows = (await Bun.file(store.file).text()).trim().split("\n");
		const claimRow = JSON.parse(rows[0]!) as Record<string, unknown>;
		if (damage === "shape") rows.push("{}");
		else if (damage === "unsupported-version") rows[0] = JSON.stringify({ ...claimRow, version: 2 });
		else if (damage === "bad-integrity") rows[0] = JSON.stringify({ ...claimRow, integrity: "0".repeat(64) });
		else if (damage === "missing-integrity") {
			delete claimRow.integrity;
			rows[0] = JSON.stringify(claimRow);
		} else if (damage === "claim-history") rows.push(rows[0]!);
		else if (damage === "reservation-history") rows.push(rows[1]!);
		else {
			const other = new SpawnAuthorityStore(path.join(f.root, "other-agent"), identityKey);
			await other.open();
			await other.claimOrJoin(alias, "e".repeat(64));
			rows.push((await Bun.file(other.file).text()).trim());
		}
		await Bun.write(store.file, `${rows.join("\n")}\n`);
		const original = JSON.stringify({ version: 1, identities: ["preserved"] });
		await Bun.write(f.attestationPath, original);
		const result = await cliCommand(f, ["--evidence", f.evidencePath, "--write", "--json"]);
		expectFailureEnvelope(result, "spawn_anchor_journal_invalid");
		expect(await Bun.file(f.attestationPath).text()).toBe(original);
		await expect(new SpawnAuthorityStore(f.agentDir, identityKey).open()).rejects.toThrow();
	}, 30_000);

	it.each(
		process.platform === "win32" ? ["temporary-sync"] : ["temporary-sync", "directory-sync"],
	)("reports publication certainty through the real public boundary on %s failure", async phase => {
		const f = await fixture();
		const id = identity("publication-canary");
		await writeRows(f, [row(id)]);
		await Bun.write(f.evidencePath, "publication-canary");
		const original = JSON.stringify({ version: 1, identities: ["preserved"] });
		await Bun.write(f.attestationPath, original);
		const open = fs.open;
		const fault = vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
			const handle = await open(file, flags, mode);
			if (
				(phase === "temporary-sync" && String(file).endsWith(".tmp")) ||
				(phase === "directory-sync" && file === path.dirname(f.attestationPath))
			) {
				vi.spyOn(handle, "sync").mockRejectedValue(new Error(`private-error-${id}`));
			}
			return handle;
		});
		let result: { stdout: string; stderr: string; code: number };
		try {
			result = await dispatchInProcess(f, ["--evidence", f.evidencePath, "--write", "--json"]);
		} finally {
			fault.mockRestore();
		}
		const renamed = phase === "directory-sync";
		expectFailureEnvelope(
			result,
			renamed ? "spawn_anchor_publication_uncertain" : "spawn_anchor_write_failed",
			renamed ? "unknown" : "not-applied",
		);
		expect(result.stdout).not.toContain("private-error");
		if (renamed)
			expect(await Bun.file(f.attestationPath).json()).toEqual({ version: 1, identities: ["preserved", id].sort() });
		else expect(await Bun.file(f.attestationPath).text()).toBe(original);
		expect((await fs.readdir(path.dirname(f.attestationPath))).some(name => name.endsWith(".tmp"))).toBe(false);
	});

	it("routes text failures only to stderr with a static diagnostic", async () => {
		const f = await fixture();
		await fs.rm(path.join(f.agentDir, "sdk", "broker.identity"));
		const result = await cliCommand(f, ["--evidence", f.evidencePath, "--write"]);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(PUBLIC_COMMAND_DIAGNOSTICS.spawn_anchor_identity_unavailable);
		expect(result.stderr).not.toMatch(/[a-f0-9]{64}/i);
	}, 30_000);

	it("reports an applied publication when result output fails after a successful write", async () => {
		const f = await fixture();
		const id = identity("output-failure-canary");
		await writeRows(f, [row(id)]);
		await Bun.write(f.evidencePath, "output-failure-canary");
		const result = await dispatchInProcess(f, ["--evidence", f.evidencePath, "--write", "--json"], true);
		expectFailureEnvelope(result, "spawn_anchor_output_failed", "applied");
		expect(await Bun.file(f.attestationPath).json()).toEqual({ version: 1, identities: [id] });
	});

	it("discards staged proofs if an evidence file fails after returning a matching token", async () => {
		const f = await fixture();
		await writeRows(f, [row(identity("partial-read-canary"))]);
		const source = Bun.file(f.evidencePath);
		let reads = 0;
		const stream = vi.spyOn(source, "stream").mockImplementation(
			() =>
				new ReadableStream<Uint8Array<ArrayBuffer>>({
					pull(controller) {
						if (reads++ === 0) controller.enqueue(new TextEncoder().encode("partial-read-canary   "));
						else controller.error(new Error("private-read-error"));
					},
				}),
		);
		const file = Bun.file;
		const factory = vi
			.spyOn(Bun, "file")
			.mockImplementation(((input: string, options?: BlobPropertyBag) =>
				input === f.evidencePath ? source : file(input, options)) as typeof Bun.file);
		try {
			const result = await runSpawnAnchorAttestation({
				agentDir: f.agentDir,
				evidence: [f.evidencePath],
				write: true,
			});
			expect(reads).toBeGreaterThan(1);
			expect(result).toMatchObject({
				candidates: 1,
				proven: 0,
				unproven: 1,
				filesScanned: 0,
				filesSkipped: 1,
				written: false,
			});
			expect(await file(f.attestationPath).exists()).toBe(false);
		} finally {
			factory.mockRestore();
			stream.mockRestore();
		}
	});
});
