#!/usr/bin/env bun
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isCompiledBinary } from "@gajae-code/utils/env";

type ExternalExecutable = {
	path: string;
	sha256: string;
};

type GateContract = {
	argv: string[];
	artifactPathPatterns: string[];
	outputArtifactPath: string;
	outputMarker: string;
	externalExecutable?: ExternalExecutable;
};

type Gate = {
	id: string;
	obligation: string;
	required: boolean;
	supersedable: boolean;
	receiptContract: GateContract;
};

type Manifest = {
	version: number;
	receiptDirectory: string;
	snapshotAlgorithm: string;
	limitations: string;
	receiptContract: {
		receiptVersion: number;
		requiredFields: Record<string, string>;
	};
	gates: Gate[];
};

type Receipt = {
	receiptVersion: number;
	gateId: string;
	argv: string[];
	exitCode: number;
	cwd: string;
	treeHash: string;
	artifacts: Array<{ path: string; sha256: string }>;
};

const packageRoot = path.resolve(import.meta.dir, "../..");
const manifestRelativePath = "src/app-server/obligations.manifest.json";
const digestRelativePath = "src/app-server/obligations.digest";
const snapshotAlgorithm = "git-ls-files-content-sha256-v1";
const sha256Pattern = /^[a-f0-9]{64}$/u;
const gateCommandTimeoutMs = 120_000;

function sha256(value: string | Uint8Array): string {
	return crypto.createHash("sha256").update(value).digest("hex");
}

export function canonicalize(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string")
		return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
			.join(",")}}`;
	}
	throw new Error("manifest contains a non-JSON value");
}

function assertKeys(value: object, expected: string[], context: string): void {
	const keys = Object.keys(value).sort();
	if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))
		throw new Error(`${context} has unexpected keys`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseGateContract(value: unknown, context: string): GateContract {
	if (!isRecord(value)) throw new Error(`${context} receipt contract is malformed`);
	const expectedKeys = Object.hasOwn(value, "externalExecutable")
		? ["argv", "artifactPathPatterns", "externalExecutable", "outputArtifactPath", "outputMarker"]
		: ["argv", "artifactPathPatterns", "outputArtifactPath", "outputMarker"];
	assertKeys(value, expectedKeys, `${context} receipt contract`);
	if (
		!Array.isArray(value.argv) ||
		value.argv.length === 0 ||
		value.argv.some(argument => typeof argument !== "string" || !argument.length) ||
		!Array.isArray(value.artifactPathPatterns) ||
		value.artifactPathPatterns.length === 0 ||
		value.artifactPathPatterns.some(pattern => typeof pattern !== "string" || !pattern.length) ||
		typeof value.outputArtifactPath !== "string" ||
		!value.outputArtifactPath.length ||
		typeof value.outputMarker !== "string" ||
		!value.outputMarker.length
	)
		throw new Error(`${context} receipt contract is malformed`);
	if (value.argv[0] === "bun") {
		if (Object.hasOwn(value, "externalExecutable"))
			throw new Error(`${context} must not bind Bun to an external executable`);
	} else {
		if (!isRecord(value.externalExecutable)) throw new Error(`${context} external executable is malformed`);
		assertKeys(value.externalExecutable, ["path", "sha256"], `${context} external executable`);
		if (
			typeof value.externalExecutable.path !== "string" ||
			!path.isAbsolute(value.externalExecutable.path) ||
			typeof value.externalExecutable.sha256 !== "string" ||
			!sha256Pattern.test(value.externalExecutable.sha256) ||
			value.argv[0] !== path.basename(value.externalExecutable.path)
		)
			throw new Error(`${context} external executable is malformed`);
	}
	return value as GateContract;
}

function parseManifest(value: unknown): Manifest {
	if (!isRecord(value)) throw new Error("manifest must be an object");
	assertKeys(
		value,
		["gates", "limitations", "receiptContract", "receiptDirectory", "snapshotAlgorithm", "version"],
		"manifest",
	);
	if (
		value.version !== 1 ||
		value.snapshotAlgorithm !== snapshotAlgorithm ||
		typeof value.receiptDirectory !== "string" ||
		!value.receiptDirectory.length ||
		typeof value.limitations !== "string" ||
		!value.limitations.length
	)
		throw new Error(
			"manifest has an unsupported version, receipt directory, snapshot algorithm, or limitations statement",
		);
	if (
		!isRecord(value.receiptContract) ||
		value.receiptContract.receiptVersion !== 1 ||
		!isRecord(value.receiptContract.requiredFields)
	)
		throw new Error("manifest receipt contract is malformed");
	if (!Array.isArray(value.gates) || value.gates.length === 0) throw new Error("manifest has no gates");
	const ids = new Set<string>();
	const gates = value.gates.map((gate, index) => {
		if (!isRecord(gate)) throw new Error(`gate ${index} is malformed`);
		assertKeys(gate, ["id", "obligation", "receiptContract", "required", "supersedable"], `gate ${index}`);
		if (
			typeof gate.id !== "string" ||
			!gate.id.length ||
			typeof gate.obligation !== "string" ||
			!gate.obligation.length ||
			gate.required !== true ||
			gate.supersedable !== false ||
			ids.has(gate.id)
		)
			throw new Error(`gate ${index} violates the required obligation contract`);
		ids.add(gate.id);
		return { ...gate, receiptContract: parseGateContract(gate.receiptContract, `gate ${index}`) } as Gate;
	});
	return { ...value, gates } as Manifest;
}

function isWithinRoot(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function realRepositoryRoot(root: string): Promise<string> {
	const realRoot = await fs.realpath(root);
	if (!(await fs.stat(realRoot)).isDirectory()) throw new Error("repository root is not a directory");
	return realRoot;
}

async function repoPath(root: string, relativePath: string): Promise<string> {
	if (!relativePath || path.isAbsolute(relativePath))
		throw new Error("path must be non-empty and repository-relative");
	const absolutePath = path.resolve(root, relativePath);
	if (!isWithinRoot(root, absolutePath)) throw new Error("path escapes repository root");
	const realPath = await fs.realpath(absolutePath);
	if (!isWithinRoot(root, realPath)) throw new Error("path escapes repository root through a symlink");
	if (realPath !== absolutePath) throw new Error("path traverses a symlink");
	return realPath;
}

function matchesArtifactPattern(relativePath: string, pattern: string): boolean {
	let expression = "^";
	for (let index = 0; index < pattern.length; index++) {
		const character = pattern[index]!;
		if (character === "*" && pattern[index + 1] === "*") {
			expression += ".*";
			index++;
		} else if (character === "*") {
			expression += "[^/]*";
		} else {
			expression += character.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
		}
	}
	return new RegExp(`${expression}$`, "u").test(relativePath.replaceAll("\\", "/"));
}

const gitExecutable = "/usr/bin/git";
const gitEnvironment = { LC_ALL: "C", PATH: "/usr/bin:/bin" };

async function gitOutput(root: string, args: string[]): Promise<string> {
	const process = Bun.spawn([gitExecutable, ...args], {
		cwd: root,
		env: gitEnvironment,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim() || `exit ${exitCode}`}`);
	return stdout;
}

async function repositoryRoot(root: string): Promise<string> {
	return (await gitOutput(root, ["rev-parse", "--show-toplevel"])).trim();
}

export async function currentTreeHash(root: string, receiptDirectory: string): Promise<string> {
	const realRoot = await realRepositoryRoot(root);
	const gitRoot = await realRepositoryRoot(await repositoryRoot(realRoot));
	const receiptPrefix = `${path.posix.join(path.relative(gitRoot, realRoot).replaceAll("\\", "/"), receiptDirectory)}/`;
	const paths = (await gitOutput(gitRoot, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]))
		.split("\0")
		.filter(Boolean)
		.filter(relativePath => !relativePath.startsWith(receiptPrefix))
		.sort();
	const files: Array<{ path: string; sha256: string }> = [];
	for (const relativePath of paths) {
		const absolutePath = await repoPath(gitRoot, relativePath);
		const stats = await fs.lstat(absolutePath);
		if (!stats.isFile()) throw new Error(`snapshot input is not a regular file: ${relativePath}`);
		files.push({ path: relativePath, sha256: sha256(new Uint8Array(await Bun.file(absolutePath).arrayBuffer())) });
	}
	return sha256(canonicalize({ algorithm: snapshotAlgorithm, files }));
}

async function parseReceipt(value: unknown, gate: Gate, root: string, receiptDirectory: string): Promise<Receipt> {
	if (!isRecord(value)) throw new Error("receipt must be an object");
	assertKeys(value, ["argv", "artifacts", "cwd", "exitCode", "gateId", "receiptVersion", "treeHash"], "receipt");
	if (
		value.receiptVersion !== 1 ||
		value.gateId !== gate.id ||
		!Array.isArray(value.argv) ||
		value.argv.length === 0 ||
		value.argv.some(argument => typeof argument !== "string" || !argument.length) ||
		value.exitCode !== 0 ||
		value.cwd !== "." ||
		typeof value.treeHash !== "string" ||
		!sha256Pattern.test(value.treeHash) ||
		!Array.isArray(value.artifacts) ||
		value.artifacts.length === 0
	)
		throw new Error("receipt fields do not satisfy the contract");
	const argv = value.argv as string[];
	const artifacts = value.artifacts as unknown[];
	const artifactPaths: string[] = [];
	if (
		argv.length !== gate.receiptContract.argv.length ||
		gate.receiptContract.argv.some((argument, index) => argv[index] !== argument)
	)
		throw new Error(`receipt argv does not exactly match the ${gate.id} contract`);
	const receiptPath = await repoPath(root, receiptDirectory);
	for (const artifact of artifacts) {
		if (!isRecord(artifact)) throw new Error("receipt artifact is malformed");
		assertKeys(artifact, ["path", "sha256"], "receipt artifact");
		if (
			typeof artifact.path !== "string" ||
			typeof artifact.sha256 !== "string" ||
			!sha256Pattern.test(artifact.sha256)
		)
			throw new Error("receipt artifact fields are malformed");
		const artifactPath = await repoPath(root, artifact.path);
		if (artifactPath === receiptPath || artifactPath.startsWith(`${receiptPath}${path.sep}`))
			throw new Error("receipt artifact must be outside the receipt directory");
		artifactPaths.push(artifact.path);
	}
	if (
		gate.receiptContract.artifactPathPatterns.some(
			pattern => !artifactPaths.some(artifactPath => matchesArtifactPattern(artifactPath, pattern)),
		)
	)
		throw new Error(`receipt artifacts do not match the ${gate.id} contract`);
	return value as Receipt;
}

async function verifyReceiptArtifacts(root: string, receipt: Receipt): Promise<string | undefined> {
	for (const artifact of receipt.artifacts) {
		try {
			const artifactPath = await repoPath(root, artifact.path);
			const stats = await fs.lstat(artifactPath);
			if (!stats.isFile()) return `artifact is not a regular file: ${artifact.path}`;
			if (sha256(new Uint8Array(await Bun.file(artifactPath).arrayBuffer())) !== artifact.sha256)
				return `artifact SHA-256 mismatch: ${artifact.path}`;
		} catch (error) {
			return `artifact is missing or unreadable: ${artifact.path} (${error instanceof Error ? error.message : String(error)})`;
		}
	}
}

const ansiEscapePattern = /\u001B\[[0-?]*[ -/]*[@-~]/gu;
const trailingHorizontalWhitespacePattern = /[\t ]+$/gmu;
const runnerDurationPattern = / \[(?:\d+(?:\.\d+)?)(?:ms|s)\](?=\n|$)/gu;

/** Canonicalizes terminal decoration, CRLF, line-end horizontal whitespace, and runner duration suffixes only. */
export function normalizeCapturedOutput(output: string): string {
	return output
		.replace(ansiEscapePattern, "")
		.replaceAll("\r\n", "\n")
		.replace(trailingHorizontalWhitespacePattern, "")
		.replace(runnerDurationPattern, " <duration>");
}

function hasExpectedOutputMarker(output: string, gate: Gate): boolean {
	return output.includes(gate.receiptContract.outputMarker);
}

async function resolveApprovedArgv(root: string, gate: Gate): Promise<string[]> {
	const { argv, externalExecutable } = gate.receiptContract;
	if (argv[0] !== "bun") {
		if (!externalExecutable) throw new Error(`gate ${gate.id} does not bind its external executable`);
		const executablePath = await fs.realpath(externalExecutable.path);
		if (executablePath !== externalExecutable.path)
			throw new Error(`external executable realpath does not match the ${gate.id} contract`);
		if (sha256(new Uint8Array(await Bun.file(executablePath).arrayBuffer())) !== externalExecutable.sha256)
			throw new Error(`external executable SHA-256 does not match the ${gate.id} contract`);
		return [executablePath, ...argv.slice(1)];
	}
	const repository = await realRepositoryRoot(await repositoryRoot(root));
	const resolvedArguments = await Promise.all(
		argv.slice(1).map(async argument => {
			if (!argument.endsWith(".ts")) return argument;
			const scriptPath = await fs.realpath(path.resolve(root, argument));
			if (!isWithinRoot(repository, scriptPath)) throw new Error(`gate ${gate.id} script escapes the repository`);
			return scriptPath;
		}),
	);
	return [await fs.realpath(process.execPath), ...resolvedArguments];
}

async function reexecuteGate(root: string, gate: Gate, receipt: Receipt): Promise<string | undefined> {
	const outputArtifact = receipt.artifacts.find(artifact => artifact.path === gate.receiptContract.outputArtifactPath);
	if (!outputArtifact) return `receipt does not include output artifact: ${gate.receiptContract.outputArtifactPath}`;
	const outputArtifactPath = await repoPath(root, outputArtifact.path);
	const recordedOutput = await Bun.file(outputArtifactPath).text();
	const normalizedRecordedOutput = normalizeCapturedOutput(recordedOutput);
	if (recordedOutput !== normalizedRecordedOutput)
		return `recorded output artifact is not normalized: ${outputArtifact.path}`;
	if (!hasExpectedOutputMarker(normalizedRecordedOutput, gate))
		return `recorded output artifact is missing expected marker: ${gate.receiptContract.outputArtifactPath}`;
	const approvedArgv = await resolveApprovedArgv(root, gate);
	const preRunTreeHash = await currentTreeHash(root, "obligations.receipts");
	if (preRunTreeHash !== receipt.treeHash)
		return "repository snapshot changed after receipt validation and before re-execution";
	let subprocess: Bun.Subprocess;
	try {
		subprocess = Bun.spawn(approvedArgv, {
			cwd: root,
			env: {
				CI: "1",
				HOME: path.join(root, ".obligations-home"),
				NO_COLOR: "1",
				PATH: "/usr/bin:/bin",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (error) {
		return `gate command is not executable: ${error instanceof Error ? error.message : String(error)}`;
	}
	const timedOut = await Promise.race([
		subprocess.exited.then(() => false),
		Bun.sleep(gateCommandTimeoutMs).then(() => true),
	]);
	if (timedOut) {
		subprocess.kill();
		await subprocess.exited;
		return `gate command timed out after ${gateCommandTimeoutMs}ms`;
	}
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(subprocess.stdout as ReadableStream<Uint8Array>).arrayBuffer(),
		new Response(subprocess.stderr as ReadableStream<Uint8Array>).arrayBuffer(),
		subprocess.exited,
	]);
	const postRunTreeHash = await currentTreeHash(root, "obligations.receipts");
	if (postRunTreeHash !== preRunTreeHash) return "gate command changed the repository snapshot during re-execution";
	if (exitCode !== receipt.exitCode)
		return `live exit code ${exitCode} does not match receipt exit code ${receipt.exitCode}`;
	const output = new Uint8Array(stdout.byteLength + stderr.byteLength);
	output.set(new Uint8Array(stdout));
	output.set(new Uint8Array(stderr), stdout.byteLength);
	const normalizedLiveOutput = normalizeCapturedOutput(new TextDecoder().decode(output));
	if (!hasExpectedOutputMarker(normalizedLiveOutput, gate)) return "live gate output is missing expected marker";
	if (sha256(normalizedLiveOutput) !== outputArtifact.sha256)
		return `live output does not match recorded artifact: ${outputArtifact.path}`;
}

export async function verifyObligations(root = packageRoot): Promise<{ verified: string[]; blocked: string[] }> {
	if (isCompiledBinary() && root === packageRoot) {
		process.stderr.write(
			"VERIFIER UNAVAILABLE: frozen obligations re-execution is unavailable in a compiled GJC artifact.\n",
		);
		return { verified: [], blocked: ["compiled-artifact"] };
	}
	let realRoot: string;
	try {
		realRoot = await realRepositoryRoot(root);
	} catch (error) {
		process.stderr.write(`MANIFEST BLOCKED: ${error instanceof Error ? error.message : String(error)}\n`);
		return { verified: [], blocked: ["manifest"] };
	}
	let manifestPath: string;
	let digestPath: string;
	try {
		[manifestPath, digestPath] = await Promise.all([
			repoPath(realRoot, manifestRelativePath),
			repoPath(realRoot, digestRelativePath),
		]);
	} catch (error) {
		process.stderr.write(`MANIFEST BLOCKED: ${error instanceof Error ? error.message : String(error)}\n`);
		return { verified: [], blocked: ["manifest"] };
	}
	let manifestText: string;
	let digest: string;
	try {
		[manifestText, digest] = await Promise.all([fs.readFile(manifestPath, "utf8"), fs.readFile(digestPath, "utf8")]);
	} catch (error) {
		process.stderr.write(`MANIFEST BLOCKED: ${error instanceof Error ? error.message : String(error)}\n`);
		return { verified: [], blocked: ["manifest"] };
	}
	let manifest: Manifest;
	try {
		manifest = parseManifest(JSON.parse(manifestText));
		if (digest !== `${sha256(canonicalize(manifest))}\n`)
			throw new Error("frozen obligations.digest does not match canonical manifest content");
	} catch (error) {
		process.stderr.write(`MANIFEST BLOCKED: ${error instanceof Error ? error.message : String(error)}\n`);
		return { verified: [], blocked: ["manifest"] };
	}
	const treeHash = await currentTreeHash(realRoot, manifest.receiptDirectory);
	const verified: string[] = [];
	const blocked: string[] = [];
	for (const gate of manifest.gates.filter(gate => gate.required)) {
		const receiptRelativePath = path.posix.join(
			manifest.receiptDirectory.replaceAll("\\", "/"),
			`${gate.id}.receipt.json`,
		);
		let receiptText: string;
		try {
			const receiptPath = await repoPath(realRoot, receiptRelativePath);
			receiptText = await fs.readFile(receiptPath, "utf8");
		} catch {
			blocked.push(gate.id);
			process.stderr.write(`GATE ${gate.id} BLOCKED: receipt is missing\n`);
			continue;
		}
		try {
			const receipt = await parseReceipt(JSON.parse(receiptText), gate, realRoot, manifest.receiptDirectory);
			if (receipt.treeHash !== treeHash)
				throw new Error("receipt treeHash does not match the current repository snapshot");
			const artifactFailure = await verifyReceiptArtifacts(realRoot, receipt);
			if (artifactFailure) throw new Error(artifactFailure);
			const reexecutionFailure = await reexecuteGate(realRoot, gate, receipt);
			if (reexecutionFailure) throw new Error(reexecutionFailure);
			verified.push(gate.id);
			process.stdout.write(`GATE ${gate.id} VERIFIED\n`);
		} catch (error) {
			blocked.push(gate.id);
			const reason = error instanceof Error ? error.message : String(error);
			process.stderr.write(`GATE ${gate.id} BLOCKED: ${reason}\n`);
		}
	}
	return { verified, blocked };
}

function parseRootArgument(argv: string[]): string | undefined {
	if (argv.length === 0) return undefined;
	if (argv.length === 2 && argv[0] === "--root" && argv[1] && !argv[1].startsWith("--")) return path.resolve(argv[1]);
	throw new Error("Usage: verify-app-server-obligations.ts [--root <package-root>]");
}

export async function main(): Promise<void> {
	let root: string | undefined;
	try {
		root = parseRootArgument(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 2;
		return;
	}
	try {
		const result = await verifyObligations(root);
		if (result.blocked.length > 0) process.exitCode = 1;
	} catch (error) {
		process.stderr.write(`VERIFIER BLOCKED: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}

if (import.meta.main) await main();
