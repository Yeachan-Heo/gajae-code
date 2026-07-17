import { afterEach, describe, expect, it } from "bun:test";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	acquireExperimentLock,
	aggregate as aggregateEvidence,
	canonicalJson,
	codesignSummary,
	detectedHost,
	type ExperimentResult,
	type Gate0Receipt,
	invokeExperiment,
	loadReceiptSigner,
	loadRestartProof,
	persistReceiptAndConsumeProof,
	type RestartProof,
	readSourceRevision,
	releaseArtifact,
	removeRestartProof,
	restartProofFile,
	restartProofPayload,
	restartRequestCode,
	runBoundedCommand,
	runCellContinuity,
	runCellExperimentPair,
	validRestartProof,
	writeRestartProof,
} from "../../scripts/computer-broker-live-e2e";

const SCRIPT = path.resolve(import.meta.dir, "../../scripts/computer-broker-live-e2e.ts");
const roots: string[] = [];
const REVISION = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe" }).stdout.toString().trim();
const BASELINE_SHA = "a".repeat(64);
const UPDATED_SHA = "b".repeat(64);
const COLLECTION_ID = "gate0-collection-20260717";

async function evidenceRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-gate0-runner-"));
	roots.push(root);
	await fs.mkdir(path.join(root, "receipts"), { mode: 0o700 });
	await fs.mkdir(path.join(root, "request-proofs"), { mode: 0o700 });
	await fs.mkdir(path.join(root, "trusted-signers"), { mode: 0o700 });
	const pair = generateKeyPairSync("ed25519");
	const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
	const publicPem = pair.publicKey.export({ type: "spki", format: "pem" });
	const publicDer = createPublicKey(publicPem).export({ type: "spki", format: "der" }) as Buffer;
	const keyId = createHash("sha256").update(publicDer).digest("hex");
	await fs.writeFile(path.join(root, "receipt-signing.key"), privatePem, { mode: 0o600 });
	await fs.writeFile(path.join(root, "receipt-signing.pub.pem"), publicPem, { mode: 0o644 });
	await fs.writeFile(path.join(root, "trusted-signers", `${keyId}.pem`), publicPem, { mode: 0o644 });
	return root;
}

function cell(
	topology: "A1" | "A2",
	macos: "14" | "15" | "26",
	host: "terminal" | "ghostty" | "cmux",
	timestamps = { startedAt: new Date(Date.now() - 1_000).toISOString(), completedAt: new Date().toISOString() },
): Gate0Receipt {
	return {
		schemaVersion: 1,
		gate: 0,
		collectionId: COLLECTION_ID,
		cell: { topology, macos, host, arch: "arm64" },
		artifact: {
			identity: "packages/coding-agent/dist/gjc",
			sourceRevision: REVISION,
			baselineSha256: BASELINE_SHA,
			updatedSha256: UPDATED_SHA,
		},
		codesign: {
			baseline: { verified: true, signing: "adhoc" },
			updated: { verified: true, signing: "adhoc" },
			compatible: true,
		},
		continuity: { baselineSuccess: true, updatedSuccess: true },
		timestamps,
		permissions: { screenRecordingGranted: true, accessibilityGranted: true, requestAttempted: true },
		ancestry: { kind: topology === "A1" ? "persistent_child" : "outer_owner", bounded: true },
		lifecycle: { markers: ["preflight", "tmux_created", "attached", "detached", "reattached", "cleaned"] },
		result: { success: true, code: "ok" },
	};
}

function experiment(phase: "probe" | "A1" | "A2", success = true): ExperimentResult {
	return {
		topology: "gate0",
		phase,
		permission: { accessibility: true, screenRecording: true },
		requestAttempted: false,
		success,
		code: success ? "ok" : "probe_failed",
		ancestry: { kind: phase === "A1" ? "persistent_child" : "outer_owner", bounded: true },
		lifecycle:
			phase === "probe" ? [] : ["preflight", "tmux_created", "attached", "detached", "reattached", "cleaned"],
	};
}

function successfulPair(topology: "A1" | "A2") {
	return { probe: experiment("probe"), lifecycle: experiment(topology) };
}

function restartProof(overrides: Partial<RestartProof> = {}): RestartProof {
	return {
		schemaVersion: 1,
		kind: "screen-recording-restart-request",
		gate: 0,
		collectionId: COLLECTION_ID,
		cell: { topology: "A1", macos: "26", host: "ghostty", arch: "arm64" },
		artifact: {
			identity: "packages/coding-agent/dist/gjc",
			sourceRevision: REVISION,
			sha256: BASELINE_SHA,
		},
		codesign: { verified: true, signing: "adhoc" },
		requestedAt: new Date().toISOString(),
		request: { attempted: true, code: "permission_pending" },
		...overrides,
	};
}

async function writeSignedRestartProofAt(
	root: string,
	expectedCell: RestartProof["cell"],
	proof: RestartProof,
): Promise<void> {
	const privateKey = await fs.readFile(path.join(root, "receipt-signing.key"));
	const publicKey = createPublicKey(await fs.readFile(path.join(root, "receipt-signing.pub.pem")));
	const keyId = createHash("sha256")
		.update(publicKey.export({ type: "spki", format: "der" }) as Buffer)
		.digest("hex");
	const value = sign(null, restartProofPayload(proof), privateKey).toString("base64");
	const target = path.join(root, "request-proofs", restartProofFile(COLLECTION_ID, expectedCell));
	await fs.writeFile(
		target,
		`${canonicalJson({ proof, signature: { algorithm: "ed25519", keyId, value } } as never)}\n`,
		{ mode: 0o600 },
	);
}

async function writeReceipt(root: string, receipt: Gate0Receipt, signature?: string): Promise<void> {
	const privateKey = await fs.readFile(path.join(root, "receipt-signing.key"));
	const publicKey = createPublicKey(await fs.readFile(path.join(root, "receipt-signing.pub.pem")));
	const keyId = createHash("sha256")
		.update(publicKey.export({ type: "spki", format: "der" }) as Buffer)
		.digest("hex");
	const value = signature ?? sign(null, Buffer.from(canonicalJson(receipt as never)), privateKey).toString("base64");
	const name = `${receipt.cell.topology}-${receipt.cell.macos}-${receipt.cell.host}-${randomBytes(4).toString("hex")}.json`;
	await fs.writeFile(
		path.join(root, "receipts", name),
		`${canonicalJson({ receipt, signature: { algorithm: "ed25519", keyId, value } } as never)}\n`,
		{ mode: 0o600 },
	);
}

async function seedMatrix(
	root: string,
	topology: "A1" | "A2" = "A1",
	timestamps?: Gate0Receipt["timestamps"],
): Promise<void> {
	for (const macos of ["14", "15", "26"] as const) {
		for (const host of ["terminal", "ghostty", "cmux"] as const)
			await writeReceipt(root, cell(topology, macos, host, timestamps));
	}
}

async function removeCell(
	root: string,
	topology: "A1" | "A2",
	macos: "14" | "15" | "26",
	host: "terminal" | "ghostty" | "cmux",
): Promise<void> {
	const prefix = `${topology}-${macos}-${host}-`;
	const name = (await fs.readdir(path.join(root, "receipts"))).find(entry => entry.startsWith(prefix));
	if (!name) throw new Error("fixture receipt is missing");
	await fs.rm(path.join(root, "receipts", name));
}

async function aggregate(
	root: string,
	topology: "A1" | "A2" = "A1",
	dependencies: Parameters<typeof aggregateEvidence>[1] = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const previousRoot = process.env.GJC_COMPUTER_GATE0_EVIDENCE_ROOT;
	const previousCollection = process.env.GJC_COMPUTER_GATE0_COLLECTION_ID;
	process.env.GJC_COMPUTER_GATE0_EVIDENCE_ROOT = root;
	process.env.GJC_COMPUTER_GATE0_COLLECTION_ID = COLLECTION_ID;
	try {
		await aggregateEvidence(
			["--gate=0", `--topology=${topology}`, "--macos=14,15,26", "--hosts=terminal,ghostty,cmux", "--require-all"],
			{
				execute: async command =>
					command[1] === "status"
						? { exitCode: 0, stdout: "?? .gjc/runtime-state\n", stderr: "", timedOut: false }
						: { exitCode: 0, stdout: REVISION, stderr: "", timedOut: false },
				...dependencies,
			},
		);
		return { exitCode: 0, stdout: "", stderr: "" };
	} catch (error) {
		return { exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : "gate0: internal error" };
	} finally {
		if (previousRoot === undefined) delete process.env.GJC_COMPUTER_GATE0_EVIDENCE_ROOT;
		else process.env.GJC_COMPUTER_GATE0_EVIDENCE_ROOT = previousRoot;
		if (previousCollection === undefined) delete process.env.GJC_COMPUTER_GATE0_COLLECTION_ID;
		else process.env.GJC_COMPUTER_GATE0_COLLECTION_ID = previousCollection;
	}
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("computer broker Gate-0 receipt runner", () => {
	for (const topology of ["A1", "A2"] as const) {
		it(`accepts only a complete, passing, exact nine-cell ${topology} topology matrix`, async () => {
			const root = await evidenceRoot();
			await seedMatrix(root, topology);
			expect((await aggregate(root, topology)).exitCode).toBe(0);
		});

		it(`rejects missing, duplicate, and wrong-ancestry ${topology} cells`, async () => {
			const missing = await evidenceRoot();
			await seedMatrix(missing, topology);
			await removeCell(missing, topology, "14", "terminal");
			expect((await aggregate(missing, topology)).exitCode).not.toBe(0);

			const duplicate = await evidenceRoot();
			await seedMatrix(duplicate, topology);
			await writeReceipt(duplicate, cell(topology, "14", "terminal"));
			expect((await aggregate(duplicate, topology)).exitCode).not.toBe(0);

			const wrongAncestry = await evidenceRoot();
			await seedMatrix(wrongAncestry, topology);
			await removeCell(wrongAncestry, topology, "14", "terminal");
			await writeReceipt(wrongAncestry, {
				...cell(topology, "14", "terminal"),
				ancestry: { kind: topology === "A1" ? "outer_owner" : "persistent_child", bounded: true },
			});
			expect((await aggregate(wrongAncestry, topology)).exitCode).not.toBe(0);
		});
	}

	it("accepts cross-cell artifact hashes but rejects invalid cells and continuity hashes", async () => {
		const crossMachine = await evidenceRoot();
		await seedMatrix(crossMachine);
		await removeCell(crossMachine, "A1", "14", "terminal");
		await writeReceipt(crossMachine, {
			...cell("A1", "14", "terminal"),
			artifact: {
				...cell("A1", "14", "terminal").artifact,
				baselineSha256: "c".repeat(64),
				updatedSha256: "d".repeat(64),
			},
		});
		expect((await aggregate(crossMachine)).exitCode).toBe(0);

		for (const mutate of [
			(receipt: Gate0Receipt) => ({ ...receipt, cell: { ...receipt.cell, macos: "13" as "14" } }),
			(receipt: Gate0Receipt) => ({ ...receipt, cell: { ...receipt.cell, host: "unknown" as "terminal" } }),
			(receipt: Gate0Receipt) => ({ ...receipt, cell: { ...receipt.cell, arch: "x64" as "arm64" } }),
			(receipt: Gate0Receipt) => ({
				...receipt,
				artifact: { ...receipt.artifact, updatedSha256: receipt.artifact.baselineSha256 },
			}),
			(receipt: Gate0Receipt) => ({
				...receipt,
				permissions: { ...receipt.permissions, accessibilityGranted: false },
			}),
			(receipt: Gate0Receipt) => ({
				...receipt,
				permissions: { ...receipt.permissions, screenRecordingGranted: false },
			}),
			(receipt: Gate0Receipt) => ({
				...receipt,
				codesign: { ...receipt.codesign, baseline: { verified: true, signing: "other" as const } },
			}),
		]) {
			const root = await evidenceRoot();
			await seedMatrix(root);
			await removeCell(root, "A1", "14", "terminal");
			await writeReceipt(root, mutate(cell("A1", "14", "terminal")));
			expect((await aggregate(root)).exitCode).not.toBe(0);
		}
	});

	it("rejects source-revision mismatch, invalid signatures, and failed cells", async () => {
		const sourceMismatch = await evidenceRoot();
		await seedMatrix(sourceMismatch);
		await removeCell(sourceMismatch, "A1", "14", "terminal");
		await writeReceipt(sourceMismatch, {
			...cell("A1", "14", "terminal"),
			artifact: { ...cell("A1", "14", "terminal").artifact, sourceRevision: "2".repeat(40) },
		});
		expect((await aggregate(sourceMismatch)).exitCode).not.toBe(0);

		const unsigned = await evidenceRoot();
		await seedMatrix(unsigned);
		await removeCell(unsigned, "A1", "14", "terminal");
		await writeReceipt(unsigned, cell("A1", "14", "terminal"), "0".repeat(64));
		expect((await aggregate(unsigned)).exitCode).not.toBe(0);

		const failed = await evidenceRoot();
		await seedMatrix(failed);
		await removeCell(failed, "A1", "14", "terminal");
		await writeReceipt(failed, {
			...cell("A1", "14", "terminal"),
			result: { success: false, code: "permission_denied" },
		});
		expect((await aggregate(failed)).exitCode).not.toBe(0);
	});

	it("isolates Ed25519 trust, canonical signature, label, and local signer guards", async () => {
		const otherKey = await evidenceRoot();
		await seedMatrix(otherKey);
		const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
		const rsaDer = rsa.export({ type: "spki", format: "der" }) as Buffer;
		const rsaId = createHash("sha256").update(rsaDer).digest("hex");
		const name = (await fs.readdir(path.join(otherKey, "receipts")))[0]!;
		const receiptPath = path.join(otherKey, "receipts", name);
		const envelope = JSON.parse(await fs.readFile(receiptPath, "utf8"));
		envelope.signature.keyId = rsaId;
		await fs.writeFile(receiptPath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
		await fs.writeFile(
			path.join(otherKey, "trusted-signers", `${rsaId}.pem`),
			rsa.export({ type: "spki", format: "pem" }),
			{
				mode: 0o644,
			},
		);
		expect((await aggregate(otherKey)).stderr).toBe("gate0: trusted signer key must be Ed25519");

		const nonCanonical = await evidenceRoot();
		await seedMatrix(nonCanonical);
		const nonCanonicalName = (await fs.readdir(path.join(nonCanonical, "receipts")))[0]!;
		const nonCanonicalPath = path.join(nonCanonical, "receipts", nonCanonicalName);
		const nonCanonicalEnvelope = JSON.parse(await fs.readFile(nonCanonicalPath, "utf8"));
		const canonicalSignature = nonCanonicalEnvelope.signature.value;
		const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
		const lastDataIndex = nonCanonicalEnvelope.signature.value.length - 3;
		const original = nonCanonicalEnvelope.signature.value[lastDataIndex]!;
		nonCanonicalEnvelope.signature.value = `${nonCanonicalEnvelope.signature.value.slice(0, lastDataIndex)}${alphabet[alphabet.indexOf(original) ^ 1]}==`;
		expect(
			Buffer.from(nonCanonicalEnvelope.signature.value, "base64").equals(Buffer.from(canonicalSignature, "base64")),
		).toBe(true);
		await fs.writeFile(nonCanonicalPath, `${JSON.stringify(nonCanonicalEnvelope)}\n`, { mode: 0o600 });
		expect((await aggregate(nonCanonical)).stderr).toBe("gate0: receipt signature is invalid");

		const wrongLabel = await evidenceRoot();
		await seedMatrix(wrongLabel);
		const wrongLabelName = (await fs.readdir(path.join(wrongLabel, "receipts")))[0]!;
		const wrongLabelPath = path.join(wrongLabel, "receipts", wrongLabelName);
		const wrongLabelEnvelope = JSON.parse(await fs.readFile(wrongLabelPath, "utf8"));
		wrongLabelEnvelope.signature.algorithm = "rsa";
		await fs.writeFile(wrongLabelPath, `${JSON.stringify(wrongLabelEnvelope)}\n`, { mode: 0o600 });
		expect((await aggregate(wrongLabel)).stderr).toBe("gate0: receipt is malformed");

		const nonEdSigner = await evidenceRoot();
		const rsaPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
		await fs.writeFile(
			path.join(nonEdSigner, "receipt-signing.key"),
			rsaPair.privateKey.export({ type: "pkcs8", format: "pem" }),
			{
				mode: 0o600,
			},
		);
		await fs.writeFile(
			path.join(nonEdSigner, "receipt-signing.pub.pem"),
			rsaPair.publicKey.export({ type: "spki", format: "pem" }),
			{
				mode: 0o644,
			},
		);
		await expect(loadReceiptSigner(nonEdSigner)).rejects.toThrow("receipt signer keys must be Ed25519");

		const mismatchedSigner = await evidenceRoot();
		const first = generateKeyPairSync("ed25519");
		const second = generateKeyPairSync("ed25519");
		await fs.writeFile(
			path.join(mismatchedSigner, "receipt-signing.key"),
			first.privateKey.export({ type: "pkcs8", format: "pem" }),
			{
				mode: 0o600,
			},
		);
		await fs.writeFile(
			path.join(mismatchedSigner, "receipt-signing.pub.pem"),
			second.publicKey.export({ type: "spki", format: "pem" }),
			{
				mode: 0o644,
			},
		);
		await expect(loadReceiptSigner(mismatchedSigner)).rejects.toThrow("receipt signer key pair does not match");
	});

	it("rejects untrusted signers, collection replay, and extra signed-envelope keys", async () => {
		const untrusted = await evidenceRoot();
		await seedMatrix(untrusted);
		await fs.rm(path.join(untrusted, "trusted-signers"), { recursive: true });
		await fs.mkdir(path.join(untrusted, "trusted-signers"), { mode: 0o700 });
		expect((await aggregate(untrusted)).exitCode).not.toBe(0);

		const replay = await evidenceRoot();
		await seedMatrix(replay);
		await removeCell(replay, "A1", "14", "terminal");
		await writeReceipt(replay, { ...cell("A1", "14", "terminal"), collectionId: "another-collection-20260717" });
		expect((await aggregate(replay)).exitCode).not.toBe(0);

		const extraEnvelope = await evidenceRoot();
		await seedMatrix(extraEnvelope);
		const name = (await fs.readdir(path.join(extraEnvelope, "receipts")))[0]!;
		const receiptPath = path.join(extraEnvelope, "receipts", name);
		const envelope = JSON.parse(await fs.readFile(receiptPath, "utf8"));
		envelope.untrusted = true;
		await fs.writeFile(receiptPath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
		expect((await aggregate(extraEnvelope)).exitCode).not.toBe(0);
	});

	it("accepts independently signed machine receipts only after public-key trust import", async () => {
		const aggregateRoot = await evidenceRoot();
		await seedMatrix(aggregateRoot);
		await removeCell(aggregateRoot, "A1", "14", "terminal");

		const contributorRoot = await evidenceRoot();
		await writeReceipt(contributorRoot, cell("A1", "14", "terminal"));
		const contributorReceipt = (await fs.readdir(path.join(contributorRoot, "receipts")))[0]!;
		const publicPem = await fs.readFile(path.join(contributorRoot, "receipt-signing.pub.pem"));
		const publicDer = createPublicKey(publicPem).export({ type: "spki", format: "der" }) as Buffer;
		const contributorId = createHash("sha256").update(publicDer).digest("hex");
		await fs.copyFile(
			path.join(contributorRoot, "receipts", contributorReceipt),
			path.join(aggregateRoot, "receipts", contributorReceipt),
		);
		await fs.copyFile(
			path.join(contributorRoot, "receipt-signing.pub.pem"),
			path.join(aggregateRoot, "trusted-signers", `${contributorId}.pem`),
		);
		expect((await aggregate(aggregateRoot)).exitCode).toBe(0);
	});

	it("rejects symlinked receipt evidence paths", async () => {
		const root = await evidenceRoot();
		await seedMatrix(root);
		const name = (await fs.readdir(path.join(root, "receipts")))[0]!;
		const target = path.join(root, "receipts", name);
		const link = path.join(root, "receipts", "linked.json");
		await fs.symlink(target, link);
		expect((await aggregate(root)).exitCode).not.toBe(0);
	});

	it("rejects symlinked trusted signer files", async () => {
		const root = await evidenceRoot();
		await seedMatrix(root);
		const trusted = (await fs.readdir(path.join(root, "trusted-signers")))[0]!;
		await fs.rm(path.join(root, "trusted-signers", trusted));
		await fs.symlink(path.join(root, "receipt-signing.pub.pem"), path.join(root, "trusted-signers", trusted));
		expect((await aggregate(root)).exitCode).not.toBe(0);
	});

	it("stores only the redacted receipt contract", () => {
		const receipt = cell("A1", "14", "terminal");
		const serialized = canonicalJson(receipt as never);
		expect(Object.keys(receipt).sort()).toEqual([
			"ancestry",
			"artifact",
			"cell",
			"codesign",
			"collectionId",
			"continuity",
			"gate",
			"lifecycle",
			"permissions",
			"result",
			"schemaVersion",
			"timestamps",
		]);
		expect(serialized).not.toContain("screenshot");
		expect(serialized).not.toContain("coordinate");
		expect(serialized).not.toContain("prompt");
		expect(serialized).not.toContain("secret");
		expect(serialized).not.toContain("/Users/");
	});

	it("redacts absolute paths and sentinel secrets at the CLI error boundary", async () => {
		const sentinelRoot = "/dev/null/SENTINEL_SECRET_gate0_absolute_path";
		const proc = Bun.spawn(
			[
				process.execPath,
				SCRIPT,
				"aggregate",
				"--gate=0",
				"--topology=A1",
				"--macos=14,15,26",
				"--hosts=terminal,ghostty,cmux",
				"--require-all",
			],
			{
				env: {
					...process.env,
					GJC_COMPUTER_GATE0_EVIDENCE_ROOT: sentinelRoot,
					GJC_COMPUTER_GATE0_COLLECTION_ID: COLLECTION_ID,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode).not.toBe(0);
		expect(stdout).toBe("");
		expect(stderr).toBe("gate0: internal error\n");
		expect(stderr).not.toContain("SENTINEL_SECRET");
		expect(stderr).not.toContain(sentinelRoot);
	});

	it("parses only one valid redacted hidden-result line and rejects every other child outcome", async () => {
		const encoded = (value: string) =>
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(value));
					controller.close();
				},
			});
		const cases: Array<{ name: string; stdout: ReadableStream<Uint8Array>; exitCode: number; expected?: string }> = [
			{ name: "valid", stdout: encoded(`${JSON.stringify(experiment("probe"))}\n`), exitCode: 0 },
			{
				name: "malformed JSON",
				stdout: encoded("{\n"),
				exitCode: 0,
				expected: "gate0: hidden experiment result is not JSON",
			},
			{
				name: "extra record",
				stdout: encoded("{}\n{}\n"),
				exitCode: 0,
				expected: "gate0: hidden experiment must emit exactly one JSON result",
			},
			{
				name: "leading blank line",
				stdout: encoded(`\n${JSON.stringify(experiment("probe"))}\n`),
				exitCode: 0,
				expected: "gate0: hidden experiment must emit exactly one JSON result",
			},
			{
				name: "trailing blank line",
				stdout: encoded(`${JSON.stringify(experiment("probe"))}\n\n`),
				exitCode: 0,
				expected: "gate0: hidden experiment must emit exactly one JSON result",
			},
			{
				name: "whitespace-only extra line",
				stdout: encoded(`${JSON.stringify(experiment("probe"))}\n \n`),
				exitCode: 0,
				expected: "gate0: hidden experiment must emit exactly one JSON result",
			},
			{
				name: "invalid schema",
				stdout: encoded("{}\n"),
				exitCode: 0,
				expected: "gate0: hidden experiment returned an invalid Gate-0 result",
			},
			{
				name: "nonzero exit",
				stdout: encoded(`${JSON.stringify(experiment("probe"))}\n`),
				exitCode: 1,
				expected: "gate0: hidden experiment exited unsuccessfully",
			},
			{
				name: "stream rejection",
				stdout: new ReadableStream<Uint8Array>({
					start: controller => controller.error(new Error("SENTINEL_SECRET")),
				}),
				exitCode: 0,
				expected: "gate0: hidden experiment exited unsuccessfully",
			},
		];
		for (const testCase of cases) {
			const result = invokeExperiment("unused", { operation: "probe" }, () => ({
				stdout: testCase.stdout,
				exited: Promise.resolve(testCase.exitCode),
				kill: () => {},
			}));
			if (!testCase.expected) await expect(result).resolves.toMatchObject({ phase: "probe", success: true });
			else await expect(result).rejects.toThrow(testCase.expected);
		}
	});

	it("cleans up a live child after hidden stdout fails", async () => {
		const exited = Promise.withResolvers<number>();
		const signals: string[] = [];
		await expect(
			invokeExperiment(
				"unused",
				{ operation: "probe" },
				() => ({
					stdout: new ReadableStream<Uint8Array>({
						start: controller => controller.error(new Error("SENTINEL_SECRET")),
					}),
					exited: exited.promise,
					kill: signal => {
						signals.push(signal);
						if (signal === "SIGKILL") exited.resolve(-1);
					},
				}),
				100,
			),
		).rejects.toThrow("gate0: hidden experiment exited unsuccessfully");
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
	});

	it("fails closed when hidden stdout rejection cannot confirm child exit", async () => {
		const signals: string[] = [];
		await expect(
			invokeExperiment(
				"unused",
				{ operation: "probe" },
				() => ({
					stdout: new ReadableStream<Uint8Array>({
						start: controller => controller.error(new Error("SENTINEL_SECRET")),
					}),
					exited: new Promise<number>(() => {}),
					kill: signal => signals.push(signal),
				}),
				100,
			),
		).rejects.toThrow("gate0: timed-out child cleanup failed");
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
	});

	it("returns a timeout only after TERM/SIGKILL cleanup confirms exit", async () => {
		const exited = Promise.withResolvers<number>();
		const signals: string[] = [];
		const result = await invokeExperiment(
			"unused",
			{ operation: "lifecycle", phase: "A1" },
			() => ({
				stdout: new ReadableStream<Uint8Array>(),
				exited: exited.promise,
				kill: signal => {
					signals.push(signal);
					if (signal === "SIGKILL") exited.resolve(-1);
				},
			}),
			100,
		);
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(result).toMatchObject({ phase: "A1", success: false, code: "timeout" });
	});

	it("rejects timed-out experiments when exit cannot be confirmed", async () => {
		const signals: string[] = [];
		await expect(
			invokeExperiment(
				"unused",
				{ operation: "probe" },
				() => ({
					stdout: new ReadableStream<Uint8Array>(),
					exited: new Promise<number>(() => {}),
					kill: signal => signals.push(signal),
				}),
				100,
			),
		).rejects.toThrow(/^gate0: timed-out child cleanup failed$/);
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
	});

	it("rejects timed-out experiments when child termination throws", async () => {
		const signals: string[] = [];
		await expect(
			invokeExperiment(
				"unused",
				{ operation: "probe" },
				() => ({
					stdout: new ReadableStream<Uint8Array>(),
					exited: new Promise<number>(() => {}),
					kill: signal => {
						signals.push(signal);
						throw new Error("private child output");
					},
				}),
				100,
			),
		).rejects.toThrow(/^gate0: timed-out child cleanup failed$/);
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
	});

	it("requires codesign verification as well as display metadata", async () => {
		const displayOnly = await codesignSummary("unused", async command => ({
			exitCode: command[1] === "--verify" ? 1 : 0,
			stdout: "Signature=adhoc",
			stderr: "",
			timedOut: false,
		}));
		expect(displayOnly).toEqual({ verified: false, signing: "unavailable" });

		const verified = await codesignSummary("unused", async () => ({
			exitCode: 0,
			stdout: "Signature=adhoc",
			stderr: "",
			timedOut: false,
		}));
		expect(verified).toEqual({ verified: true, signing: "adhoc" });
	});

	it("kills and awaits a bounded command before returning timeout", async () => {
		const started = Date.now();
		const result = await runBoundedCommand([process.execPath, "-e", "await Bun.sleep(10_000)"], undefined, 20);
		expect(result.timedOut).toBe(true);
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it("cleans up a live child after stdout rejection before returning a synthetic command failure", async () => {
		const exited = Promise.withResolvers<number>();
		const signals: string[] = [];
		const result = await runBoundedCommand(["unused"], undefined, 50, () => ({
			stdout: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.error(new Error("private stdout"));
				},
			}),
			stderr: new ReadableStream<Uint8Array>(),
			exited: exited.promise,
			kill: signal => {
				signals.push(signal);
				if (signal === "SIGKILL") exited.resolve(23);
			},
		}));
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(result).toEqual({ exitCode: -1, stdout: "", stderr: "", timedOut: false });
	});

	it("cleans up a live child after stderr rejection before returning a synthetic command failure", async () => {
		const exited = Promise.withResolvers<number>();
		const signals: string[] = [];
		const result = await runBoundedCommand(["unused"], undefined, 50, () => ({
			stdout: new ReadableStream<Uint8Array>(),
			stderr: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.error(new Error("private stderr"));
				},
			}),
			exited: exited.promise,
			kill: signal => {
				signals.push(signal);
				if (signal === "SIGKILL") exited.resolve(29);
			},
		}));
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(result).toEqual({ exitCode: -1, stdout: "", stderr: "", timedOut: false });
	});

	it("redacts live-child stream rejection when cleanup cannot confirm exit", async () => {
		const signals: string[] = [];
		const result = runBoundedCommand(["unused"], undefined, 50, () => ({
			stdout: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.error(new Error("private child output"));
				},
			}),
			stderr: new ReadableStream<Uint8Array>(),
			exited: new Promise<number>(() => {}),
			kill: signal => signals.push(signal),
		}));
		let failure: unknown;
		try {
			await result;
		} catch (error) {
			failure = error;
		}
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toBe("gate0: timed-out child cleanup failed");
	});

	it("falls back to SIGKILL when SIGTERM throws during stream-rejection cleanup", async () => {
		const exited = Promise.withResolvers<number>();
		const signals: string[] = [];
		const result = await runBoundedCommand(["unused"], undefined, 50, () => ({
			stdout: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.error(new Error("private child output"));
				},
			}),
			stderr: new ReadableStream<Uint8Array>(),
			exited: exited.promise,
			kill: signal => {
				signals.push(signal);
				if (signal === "SIGTERM") throw new Error("private kill failure");
				exited.resolve(31);
			},
		}));
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(result).toEqual({ exitCode: -1, stdout: "", stderr: "", timedOut: false });
	});

	it("rejects unchanged update hashes and baseline or post-update failures at the continuity seam", async () => {
		const common = {
			build: async () => {},
			readArtifact: async () => ({ path: "updated", sha256: UPDATED_SHA }),
			codesign: async () => ({ verified: true as const, signing: "adhoc" as const }),
			sourceRevision: async () => REVISION,
		};
		await expect(
			runCellContinuity({ path: "baseline", sha256: BASELINE_SHA }, "A1", {
				...common,
				readArtifact: async () => ({ path: "updated", sha256: BASELINE_SHA }),
				runPair: async () => successfulPair("A1"),
			}),
		).rejects.toThrow("rebuilt release artifact did not change");
		await expect(
			runCellContinuity({ path: "baseline", sha256: BASELINE_SHA }, "A1", {
				...common,
				codesign: async () => ({ verified: true, signing: "other" }),
				runPair: async () => successfulPair("A1"),
			}),
		).rejects.toThrow("verified ad-hoc signature");
		await expect(
			runCellContinuity({ path: "baseline", sha256: BASELINE_SHA }, "A1", {
				...common,
				runPair: async () => ({ ...successfulPair("A1"), probe: experiment("probe", false) }),
			}),
		).rejects.toThrow("baseline hidden experiment failed");
		let calls = 0;
		await expect(
			runCellContinuity({ path: "baseline", sha256: BASELINE_SHA }, "A1", {
				...common,
				runPair: async () => {
					calls += 1;
					return calls === 1
						? successfulPair("A1")
						: { ...successfulPair("A1"), lifecycle: experiment("A1", false) };
				},
			}),
		).rejects.toThrow("updated hidden experiment failed");
	});

	it("accepts one pending baseline request when the later lifecycle proves the grant", async () => {
		let calls = 0;
		const pending = experiment("probe", false);
		pending.code = "permission_pending";
		pending.requestAttempted = true;
		const result = await runCellContinuity({ path: "baseline", sha256: BASELINE_SHA }, "A2", {
			build: async () => {},
			readArtifact: async () => ({ path: "updated", sha256: UPDATED_SHA }),
			codesign: async () => ({ verified: true, signing: "adhoc" }),
			sourceRevision: async () => REVISION,
			runPair: async () => (++calls === 1 ? { probe: pending, lifecycle: experiment("A2") } : successfulPair("A2")),
		});
		expect(result.baselinePair.probe.code).toBe("permission_pending");
		expect(result.updatedPair.probe.requestAttempted).toBe(false);
	});

	it("rejects dirty source inputs while allowing only Ultragoal state", async () => {
		const commandResult = (stdout: string) => ({ exitCode: 0, stdout, stderr: "", timedOut: false });
		await expect(
			readSourceRevision(async command =>
				command[1] === "status"
					? commandResult("?? packages/coding-agent/src/untracked.ts\n")
					: commandResult(REVISION),
			),
		).rejects.toThrow("source changes must be committed");
		await expect(
			readSourceRevision(async command =>
				command[1] === "status" ? commandResult("?? .gjc/runtime-state\n") : commandResult(REVISION),
			),
		).resolves.toBe(REVISION);
	});

	it("uses the default clean-source reader before and immediately before aggregate success", async () => {
		const root = await evidenceRoot();
		await seedMatrix(root);
		const commandResult = (stdout: string) => ({ exitCode: 0, stdout, stderr: "", timedOut: false });
		const dirty = await aggregate(root, "A1", {
			execute: async command =>
				command[1] === "status"
					? commandResult("?? packages/coding-agent/src/untracked.ts\n")
					: commandResult(REVISION),
		});
		expect(dirty).toMatchObject({
			exitCode: 1,
			stderr: "gate0: source changes must be committed before recording Gate-0 evidence",
		});

		let statusCalls = 0;
		const finalDirty = await aggregate(root, "A1", {
			execute: async command => {
				if (command[1] !== "status") return commandResult(REVISION);
				return commandResult(
					statusCalls++ === 0 ? "?? .gjc/runtime-state\n" : " M packages/coding-agent/src/runtime.ts\n",
				);
			},
		});
		expect(finalDirty).toMatchObject({
			exitCode: 1,
			stderr: "gate0: source changes must be committed before recording Gate-0 evidence",
		});

		let revisionCalls = 0;
		const revisionChanged = await aggregate(root, "A1", {
			execute: async command =>
				command[1] === "status"
					? commandResult("?? .gjc/runtime-state\n")
					: commandResult(revisionCalls++ === 0 ? REVISION : "f".repeat(40)),
		});
		expect(revisionChanged).toMatchObject({
			exitCode: 1,
			stderr: "gate0: source revision changed during aggregation",
		});

		const calls: string[] = [];
		const clean = await aggregate(root, "A1", {
			execute: async command => {
				calls.push(command[1]!);
				return commandResult(command[1] === "status" ? "?? .gjc/runtime-state\n" : REVISION);
			},
		});
		expect(clean).toMatchObject({ exitCode: 0 });
		expect(calls).toEqual(["status", "rev-parse", "status", "rev-parse"]);
	});

	it("enforces independently signed receipt timestamp boundaries", async () => {
		const now = Date.parse("2026-07-17T12:00:00.000Z");
		for (const [name, timestamps, accepted] of [
			["reversed", { startedAt: new Date(now).toISOString(), completedAt: new Date(now - 1).toISOString() }, false],
			[
				"stale",
				{
					startedAt: new Date(now - 30 * 24 * 60 * 60_000 - 1).toISOString(),
					completedAt: new Date(now).toISOString(),
				},
				false,
			],
			[
				"future",
				{ startedAt: new Date(now + 60_001).toISOString(), completedAt: new Date(now + 60_001).toISOString() },
				false,
			],
			[
				"completed future",
				{ startedAt: new Date(now).toISOString(), completedAt: new Date(now + 60_001).toISOString() },
				false,
			],
			[
				"window edge",
				{
					startedAt: new Date(now - 30 * 24 * 60 * 60_000).toISOString(),
					completedAt: new Date(now).toISOString(),
				},
				true,
			],
			[
				"skew edge",
				{ startedAt: new Date(now + 60_000).toISOString(), completedAt: new Date(now + 60_000).toISOString() },
				true,
			],
			[
				"completed skew edge",
				{ startedAt: new Date(now).toISOString(), completedAt: new Date(now + 60_000).toISOString() },
				true,
			],
		] as const) {
			const root = await evidenceRoot();
			await seedMatrix(root, "A1", timestamps);
			expect((await aggregate(root, "A1", { now: () => now })).exitCode, name).toBe(accepted ? 0 : 1);
		}
	});

	it("admits the literal default release artifact path through injected file checks", async () => {
		const artifact = path.resolve("packages/coding-agent/dist/gjc");
		const stats = { isSymbolicLink: () => false, isFile: () => true, mode: 0o700 } as never;
		await expect(
			releaseArtifact(artifact, { lstat: async () => stats, hash: async () => "c".repeat(64) }),
		).resolves.toEqual({
			path: artifact,
			sha256: "c".repeat(64),
		});
		await expect(
			releaseArtifact(path.resolve("packages/coding-agent/dist/gjc-adjacent"), { lstat: async () => stats }),
		).rejects.toThrow("--artifact must be packages/coding-agent/dist/gjc");
	});
	it("admits only the exact non-symlink executable release artifact and hashes its bytes", async () => {
		const root = await evidenceRoot();
		const artifact = path.join(root, "gjc");
		await fs.writeFile(artifact, "release bytes", { mode: 0o700 });
		const expectedSha = createHash("sha256").update("release bytes").digest("hex");
		await expect(releaseArtifact(path.join(root, "wrong"), { expectedPath: artifact })).rejects.toThrow(
			"--artifact must be",
		);
		await expect(
			releaseArtifact(path.join(root, "missing"), { expectedPath: path.join(root, "missing") }),
		).rejects.toThrow("non-symlink executable");
		const link = path.join(root, "linked-gjc");
		await fs.symlink(artifact, link);
		await expect(releaseArtifact(link, { expectedPath: link })).rejects.toThrow("non-symlink executable");
		await fs.chmod(artifact, 0o600);
		await expect(releaseArtifact(artifact, { expectedPath: artifact })).rejects.toThrow("non-symlink executable");
		await fs.chmod(artifact, 0o700);
		await expect(releaseArtifact(artifact, { expectedPath: artifact })).resolves.toEqual({
			path: artifact,
			sha256: expectedSha,
		});
	});

	it("never reaps a live experiment lock and safely reaps a proven-dead owner", async () => {
		const root = await evidenceRoot();
		const lock = path.join(root, "experiment.lock");
		for (const createdAt of [Date.now(), Date.now() - 60 * 60_000]) {
			await fs.writeFile(lock, JSON.stringify({ pid: process.pid, createdAt, token: "a".repeat(48) }), {
				mode: 0o600,
			});
			await expect(acquireExperimentLock(root)).rejects.toThrow("already running");
		}
		await fs.writeFile(
			lock,
			JSON.stringify({ pid: 2_147_483_647, createdAt: Date.now() - 60 * 60_000, token: "b".repeat(48) }),
			{ mode: 0o600 },
		);
		const release = await acquireExperimentLock(root);
		await release();
		await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("accepts only explicit pending or granted restart request results", () => {
		const pending = experiment("probe", false);
		pending.requestAttempted = true;
		pending.code = "permission_pending";
		pending.permission.screenRecording = false;
		expect(restartRequestCode(pending)).toBe("permission_pending");

		const granted = experiment("probe");
		granted.requestAttempted = true;
		expect(restartRequestCode(granted)).toBe("ok");

		expect(() => restartRequestCode(experiment("probe"))).toThrow("restart request contract");
		pending.permission.screenRecording = true;
		expect(() => restartRequestCode(pending)).toThrow("restart request contract");
	});

	it("roundtrips an exact signed restart proof and refuses overwrite", async () => {
		const root = await evidenceRoot();
		const proof = restartProof();
		expect(validRestartProof(proof)).toBe(true);
		expect(validRestartProof({ ...proof, extra: true })).toBe(false);
		await writeRestartProof(root, proof);
		expect(await loadRestartProof(root, COLLECTION_ID, proof.cell)).toEqual(proof);
		await expect(writeRestartProof(root, proof)).rejects.toMatchObject({ code: "EEXIST" });
	});

	it("rejects tampered, noncanonical, and untrusted restart proofs", async () => {
		const tamperedRoot = await evidenceRoot();
		const proof = restartProof();
		await writeRestartProof(tamperedRoot, proof);
		const file = path.join(tamperedRoot, "request-proofs", restartProofFile(COLLECTION_ID, proof.cell));
		const tampered = JSON.parse(await fs.readFile(file, "utf8"));
		tampered.proof.request.code = "ok";
		await fs.writeFile(file, `${canonicalJson(tampered)}\n`, { mode: 0o600 });
		await expect(loadRestartProof(tamperedRoot, COLLECTION_ID, proof.cell)).rejects.toThrow("signature is invalid");

		const noncanonicalRoot = await evidenceRoot();
		await writeRestartProof(noncanonicalRoot, proof);
		const noncanonicalFile = path.join(
			noncanonicalRoot,
			"request-proofs",
			restartProofFile(COLLECTION_ID, proof.cell),
		);
		const noncanonical = JSON.parse(await fs.readFile(noncanonicalFile, "utf8"));
		noncanonical.signature.value += "=";
		await fs.writeFile(noncanonicalFile, `${canonicalJson(noncanonical)}\n`, { mode: 0o600 });
		await expect(loadRestartProof(noncanonicalRoot, COLLECTION_ID, proof.cell)).rejects.toThrow(
			"receipt signature is invalid",
		);

		const untrustedRoot = await evidenceRoot();
		await writeRestartProof(untrustedRoot, proof);
		const untrustedFile = path.join(untrustedRoot, "request-proofs", restartProofFile(COLLECTION_ID, proof.cell));
		const untrusted = JSON.parse(await fs.readFile(untrustedFile, "utf8"));
		await fs.unlink(path.join(untrustedRoot, "trusted-signers", `${untrusted.signature.keyId}.pem`));
		await expect(loadRestartProof(untrustedRoot, COLLECTION_ID, proof.cell)).rejects.toThrow(
			"required evidence path is missing",
		);
	});

	it("rejects stale and exact-cell-mismatched restart proofs", async () => {
		const staleRoot = await evidenceRoot();
		const stale = restartProof({ requestedAt: new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString() });
		await writeRestartProof(staleRoot, stale);
		await expect(loadRestartProof(staleRoot, COLLECTION_ID, stale.cell)).rejects.toThrow(
			"timestamp is outside the collection window",
		);

		const mismatchRoot = await evidenceRoot();
		const expected = restartProof().cell;
		const mismatch = restartProof({
			collectionId: "gate0-other-collection",
			cell: { ...expected, host: "terminal" },
		});
		await writeSignedRestartProofAt(mismatchRoot, expected, mismatch);
		await expect(loadRestartProof(mismatchRoot, COLLECTION_ID, expected)).rejects.toThrow(
			"does not match the requested cell",
		);
	});

	it("preserves restart proof on receipt failure and consumes it only after receipt success", async () => {
		const root = await evidenceRoot();
		const proof = restartProof();
		const proofPath = path.join(root, "request-proofs", restartProofFile(COLLECTION_ID, proof.cell));
		await writeRestartProof(root, proof);
		await expect(
			persistReceiptAndConsumeProof(root, cell("A1", "26", "ghostty"), proof, {
				writeReceipt: async () => {
					throw new Error("receipt write failed");
				},
				removeRestartProof,
			}),
		).rejects.toThrow("receipt write failed");
		expect((await fs.lstat(proofPath)).isFile()).toBe(true);

		await persistReceiptAndConsumeProof(root, cell("A1", "26", "ghostty"), proof);
		await expect(fs.lstat(proofPath)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await fs.readdir(path.join(root, "receipts"))).length).toBe(1);
	});

	it("runs both post-restart continuity probes without another Screen Recording request", async () => {
		const requests: boolean[] = [];
		await runCellContinuity(
			{ path: "baseline", sha256: BASELINE_SHA },
			"A1",
			{
				build: async () => {},
				readArtifact: async () => ({ path: "updated", sha256: UPDATED_SHA }),
				codesign: async () => ({ verified: true, signing: "adhoc" }),
				sourceRevision: async () => REVISION,
				runPair: async (_artifact, _topology, _invoke, request) => {
					requests.push(request === true);
					return successfulPair("A1");
				},
			},
			false,
		);
		expect(requests).toEqual([false, false]);
	});

	it("uses exactly one permission request across baseline and updated continuity", async () => {
		const requests: boolean[] = [];
		await runCellContinuity({ path: "baseline", sha256: BASELINE_SHA }, "A1", {
			build: async () => {},
			readArtifact: async () => ({ path: "updated", sha256: UPDATED_SHA }),
			codesign: async () => ({ verified: true, signing: "adhoc" }),
			sourceRevision: async () => REVISION,
			runPair: async (_artifact, _topology, _invoke, request) => {
				requests.push(request === true);
				return successfulPair("A1");
			},
		});
		expect(requests).toEqual([true, false]);

		let revisions = 0;
		await expect(
			runCellContinuity({ path: "baseline", sha256: BASELINE_SHA }, "A1", {
				build: async () => {},
				readArtifact: async () => ({ path: "updated", sha256: UPDATED_SHA }),
				codesign: async () => ({ verified: true, signing: "adhoc" }),
				sourceRevision: async () => (revisions++ === 0 ? REVISION : "f".repeat(40)),
				runPair: async () => successfulPair("A1"),
			}),
		).rejects.toThrow("source revision changed during rebuild");
	});

	it("uses the hidden Gate-0 result schema at the run-cell invocation seam", async () => {
		const pair = await runCellExperimentPair("unused", "A1", async (_artifact, input) =>
			(input as { operation?: unknown }).operation === "probe" ? experiment("probe") : experiment("A1"),
		);
		expect(pair.lifecycle.ancestry.kind).toBe("persistent_child");
		const unexpectedRequest = experiment("probe");
		unexpectedRequest.requestAttempted = true;
		await expect(
			runCellExperimentPair(
				"unused",
				"A1",
				async (_artifact, input) =>
					(input as { operation?: unknown }).operation === "probe" ? unexpectedRequest : experiment("A1"),
				false,
			),
		).rejects.toThrow("does not match the run-cell contract");
	});

	it("detects the originating terminal through managed tmux markers", () => {
		expect(detectedHost({ TERM_PROGRAM: "tmux", CMUX_BUNDLE_ID: "com.cmuxterm.app" })).toBe("cmux");
		expect(detectedHost({ TERM_PROGRAM: "tmux", GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app" })).toBe(
			"ghostty",
		);
		expect(detectedHost({ TERM_PROGRAM: "Apple_Terminal" })).toBe("terminal");
	});
});
