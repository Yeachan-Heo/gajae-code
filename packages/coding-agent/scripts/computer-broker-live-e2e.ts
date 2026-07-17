import {
	createHash,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	randomBytes,
	sign,
	verify,
} from "node:crypto";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
	type Gate0AncestryKind,
	type Gate0Code,
	type Gate0LifecycleMarker,
	type Gate0Result,
	isGate0Result,
} from "../src/gjc-runtime/computer-broker-gate0";

type Topology = "A1" | "A2";
type Macos = "14" | "15" | "26";
type Host = "terminal" | "ghostty" | "cmux";
type Signing = "adhoc" | "other" | "unavailable";
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface Gate0Receipt {
	schemaVersion: 1;
	gate: 0;
	collectionId: string;
	cell: { topology: Topology; macos: Macos; host: Host; arch: "arm64" };
	artifact: {
		identity: "packages/coding-agent/dist/gjc";
		sourceRevision: string;
		baselineSha256: string;
		updatedSha256: string;
	};
	codesign: {
		baseline: { verified: boolean; signing: Signing };
		updated: { verified: boolean; signing: Signing };
		compatible: boolean;
	};
	continuity: { baselineSuccess: true; updatedSuccess: true };
	timestamps: { startedAt: string; completedAt: string };
	permissions: { screenRecordingGranted: boolean; accessibilityGranted: boolean; requestAttempted: boolean };
	ancestry: { kind: Gate0AncestryKind; bounded: true };
	lifecycle: { markers: Gate0LifecycleMarker[] };
	result: { success: boolean; code: Gate0Code };
}

interface SignedReceipt {
	receipt: Gate0Receipt;
	signature: { algorithm: "ed25519"; keyId: string; value: string };
}

export interface HostProcessIdentity {
	host: Host;
	pid: number;
	executableSha256: string;
	startTokenSha256: string;
}

export interface RestartProof {
	schemaVersion: 1;
	kind: "screen-recording-restart-request";
	gate: 0;
	collectionId: string;
	cell: Gate0Receipt["cell"];
	artifact: { identity: "packages/coding-agent/dist/gjc"; sourceRevision: string; sha256: string };
	codesign: CodeSignSummary;
	hostProcess: HostProcessIdentity;
	requestedAt: string;
	request: { attempted: true; code: "permission_pending" | "ok" };
}

interface SignedRestartProof {
	proof: RestartProof;
	signature: { algorithm: "ed25519"; keyId: string; value: string };
}
export interface ReleaseArtifact {
	path: string;
	sha256: string;
}
export interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}
export type CommandRunner = (command: string[], cwd?: string, timeoutMs?: number) => Promise<CommandResult>;
interface HiddenArtifactChild {
	stdout: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	kill(signal: "SIGTERM" | "SIGKILL"): void;
}
export type HiddenArtifactSpawner = (artifact: string, input: JsonValue) => HiddenArtifactChild;
export type ExperimentResult = Gate0Result;
export type Gate0ExperimentInvoker = (artifact: string, input: JsonValue) => Promise<ExperimentResult>;
export interface CodeSignSummary {
	verified: boolean;
	signing: Signing;
}
export interface RunCellContinuityDependencies {
	runPair?: typeof runCellExperimentPair;
	build?: () => Promise<void>;
	readArtifact?: (value: string) => Promise<ReleaseArtifact>;
	codesign?: (artifact: string) => Promise<CodeSignSummary>;
	sourceRevision?: () => Promise<string>;
}
export interface RunCellContinuityResult {
	sourceRevision: string;
	baseline: ReleaseArtifact;
	updated: ReleaseArtifact;
	baselineCodesign: CodeSignSummary;
	updatedCodesign: CodeSignSummary;
	baselinePair: { probe: ExperimentResult; lifecycle: ExperimentResult };
	updatedPair: { probe: ExperimentResult; lifecycle: ExperimentResult };
}

const MACOS_VALUES = new Set<Macos>(["14", "15", "26"]);
const HOST_VALUES = new Set<Host>(["terminal", "ghostty", "cmux"]);
const TOPOLOGY_VALUES = new Set<Topology>(["A1", "A2"]);
const RECEIPT_ROOT_ENV = "GJC_COMPUTER_GATE0_EVIDENCE_ROOT";
const COLLECTION_ID_ENV = "GJC_COMPUTER_GATE0_COLLECTION_ID";
const PRIVATE_KEY_NAME = "receipt-signing.key";
const PUBLIC_KEY_NAME = "receipt-signing.pub.pem";
const TRUSTED_SIGNERS_NAME = "trusted-signers";
const EXPERIMENT_LOCK_NAME = "experiment.lock";
const INVOCATION_TIMEOUT_MS = 15_000;
const BUILD_TIMEOUT_MS = 15 * 60_000;
const COLLECTION_WINDOW_MS = 30 * 24 * 60 * 60_000;
const RESTART_PROOFS_NAME = "request-proofs";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

export class Gate0RunnerError extends Error {
	constructor(message: string) {
		super(`gate0: ${message}`);
		this.name = "Gate0RunnerError";
	}
}

function fail(message: string): never {
	throw new Gate0RunnerError(message);
}
function stringFlag(args: string[], name: string): string | null {
	const matches = args.filter(arg => arg.startsWith(`--${name}=`));
	return matches.length === 1 ? matches[0]!.slice(name.length + 3) : null;
}
function requireFlag(args: string[], name: string): string {
	const value = stringFlag(args, name);
	if (!value) fail(`--${name} is required exactly once`);
	return value;
}
function collectionId(env: NodeJS.ProcessEnv = process.env): string {
	const value = env[COLLECTION_ID_ENV];
	if (!value || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(value))
		fail(`${COLLECTION_ID_ENV} must be a bounded UUID-like token`);
	return value;
}
function parseCell(args: string[]): Gate0Receipt["cell"] {
	if (requireFlag(args, "gate") !== "0") fail("only --gate=0 is supported");
	const topology = requireFlag(args, "topology"),
		macos = requireFlag(args, "macos"),
		host = requireFlag(args, "host"),
		arch = requireFlag(args, "arch");
	if (!TOPOLOGY_VALUES.has(topology as Topology)) fail("--topology must be A1 or A2");
	if (!MACOS_VALUES.has(macos as Macos)) fail("--macos must be 14, 15, or 26");
	if (!HOST_VALUES.has(host as Host)) fail("--host must be terminal, ghostty, or cmux");
	if (arch !== "arm64") fail("--arch must be arm64");
	return { topology: topology as Topology, macos: macos as Macos, host: host as Host, arch: "arm64" };
}
function defaultEvidenceRoot(): string {
	return path.join(os.homedir(), "Library", "Application Support", "gajae-code", "gate0-evidence-v2");
}
function evidenceRoot(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env[RECEIPT_ROOT_ENV];
	return configured ? path.resolve(configured) : defaultEvidenceRoot();
}
function canonicalize(value: JsonValue): JsonValue {
	return Array.isArray(value)
		? value.map(canonicalize)
		: value !== null && typeof value === "object"
			? Object.fromEntries(
					Object.entries(value)
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([key, child]) => [key, canonicalize(child)]),
				)
			: value;
}
export function canonicalJson(value: JsonValue): string {
	return JSON.stringify(canonicalize(value));
}
function receiptPayload(receipt: Gate0Receipt): Buffer {
	return Buffer.from(canonicalJson(receipt as unknown as JsonValue));
}

export function restartProofPayload(proof: RestartProof): Buffer {
	return Buffer.from(canonicalJson(proof as unknown as JsonValue));
}

function keyId(publicDer: Buffer): string {
	return createHash("sha256").update(publicDer).digest("hex");
}

async function lstatSafe(target: string): Promise<Stats> {
	try {
		return await fs.lstat(target);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			fail("required evidence path is missing");
		throw error;
	}
}

function ownedByCurrentUser(stats: Stats): boolean {
	return typeof process.getuid !== "function" || stats.uid === process.getuid();
}

async function requireDirectPath(target: string): Promise<void> {
	const [actual, parent] = await Promise.all([fs.realpath(target), fs.realpath(path.dirname(target))]);
	if (actual !== path.join(parent, path.basename(target))) fail("evidence path traverses a symbolic link");
}
async function secureDirectory(target: string): Promise<void> {
	const stats = await lstatSafe(target);
	await requireDirectPath(target);
	if (stats.isSymbolicLink() || !stats.isDirectory() || !ownedByCurrentUser(stats) || (stats.mode & 0o077) !== 0)
		fail("evidence directory is unsafe");
}
async function secureFile(target: string, privateFile: boolean): Promise<void> {
	const stats = await lstatSafe(target);
	await requireDirectPath(target);
	const unsafeMode = privateFile ? (stats.mode & 0o077) !== 0 : (stats.mode & 0o022) !== 0;
	if (stats.isSymbolicLink() || !stats.isFile() || !ownedByCurrentUser(stats) || unsafeMode)
		fail("evidence file is unsafe");
}
async function ensureEvidenceRoot(root: string): Promise<void> {
	try {
		await secureDirectory(root);
	} catch (error) {
		if (!(error instanceof Error) || error.message !== "gate0: required evidence path is missing") throw error;
		await fs.mkdir(root, { recursive: true, mode: 0o700 });
		await secureDirectory(root);
	}
	await fs.chmod(root, 0o700);
	await secureDirectory(root);
	for (const name of ["receipts", RESTART_PROOFS_NAME, TRUSTED_SIGNERS_NAME]) {
		const target = path.join(root, name);
		await fs.mkdir(target, { recursive: true, mode: 0o700 });
		await fs.chmod(target, 0o700);
		await secureDirectory(target);
	}
}
async function signer(root: string): Promise<{ privateKey: ReturnType<typeof createPrivateKey>; id: string }> {
	const privatePath = path.join(root, PRIVATE_KEY_NAME),
		publicPath = path.join(root, PUBLIC_KEY_NAME);
	try {
		const pair = generateKeyPairSync("ed25519");
		const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
		const publicPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
		const handle = await fs.open(privatePath, "wx", 0o600);
		try {
			await handle.writeFile(privatePem);
		} finally {
			await handle.close();
		}
		await fs.writeFile(publicPath, publicPem, { mode: 0o644, flag: "wx" });
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
	}
	await secureFile(privatePath, true);
	await secureFile(publicPath, false);
	let privateKey: ReturnType<typeof createPrivateKey>;
	let publicKey: ReturnType<typeof createPublicKey>;
	try {
		privateKey = createPrivateKey(await fs.readFile(privatePath));
		publicKey = createPublicKey(await fs.readFile(publicPath));
	} catch {
		fail("receipt signer PEM is malformed");
	}
	if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519")
		fail("receipt signer keys must be Ed25519");
	const publicDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
	const id = keyId(publicDer);
	const derived = createPublicKey(privateKey.export({ type: "pkcs8", format: "pem" })).export({
		type: "spki",
		format: "der",
	}) as Buffer;
	if (!derived.equals(publicDer)) fail("receipt signer key pair does not match");
	const trustedPath = path.join(root, TRUSTED_SIGNERS_NAME, `${id}.pem`);
	try {
		await fs.writeFile(trustedPath, await fs.readFile(publicPath), { mode: 0o644, flag: "wx" });
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
	}
	await secureFile(trustedPath, false);
	return { privateKey, id };
}

export async function loadReceiptSigner(root: string): Promise<void> {
	await signer(root);
}
async function sha256File(file: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256"),
		handle = await fs.open(file, "r");
	try {
		const buffer = Buffer.allocUnsafe(64 * 1024);
		for (;;) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
			if (!bytesRead) break;
			hasher.update(buffer.subarray(0, bytesRead));
		}
	} finally {
		await handle.close();
	}
	return hasher.digest("hex");
}
export interface ReleaseArtifactDependencies {
	expectedPath?: string;
	lstat?: (target: string) => Promise<Stats>;
	hash?: (target: string) => Promise<string>;
}

export async function releaseArtifact(
	value: string,
	dependencies: ReleaseArtifactDependencies = {},
): Promise<ReleaseArtifact> {
	const artifact = path.resolve(value),
		expected = path.resolve(dependencies.expectedPath ?? path.resolve(import.meta.dir, "../dist/gjc")),
		lstat = dependencies.lstat ?? fs.lstat,
		hash = dependencies.hash ?? sha256File;
	if (artifact !== expected) fail("--artifact must be packages/coding-agent/dist/gjc");
	let stats: Stats;
	try {
		stats = await lstat(artifact);
	} catch {
		fail("--artifact must be a non-symlink executable packaged release artifact");
	}
	if (stats.isSymbolicLink() || !stats.isFile() || (stats.mode & 0o111) === 0)
		fail("--artifact must be a non-symlink executable packaged release artifact");
	return { path: artifact, sha256: await hash(artifact) };
}
export function detectedHost(env: NodeJS.ProcessEnv = process.env): Host | null {
	if (env.CMUX_BUNDLE_ID?.toLowerCase() === "com.cmuxterm.app" || env.CMUX_SHELL_INTEGRATION === "1") return "cmux";
	const terminal = env.TERM_PROGRAM?.toLowerCase();
	if (terminal === "apple_terminal" || terminal === "terminal") return "terminal";
	if (terminal === "ghostty" || env.GHOSTTY_RESOURCES_DIR) return "ghostty";
	return terminal === "cmux" ? "cmux" : null;
}
function hostMacosMajor(): string | null {
	const result = Bun.spawnSync(["/usr/bin/sw_vers", "-productVersion"], { stdout: "pipe", stderr: "ignore" });
	return result.exitCode === 0 ? (result.stdout.toString().trim().split(".")[0] ?? null) : null;
}
function validateEnvironment(cell: Gate0Receipt["cell"]): void {
	if (process.platform !== "darwin") fail("host platform is not macOS");
	if (process.arch !== "arm64") fail("host architecture is not arm64");
	if (hostMacosMajor() !== cell.macos) fail("declared macOS version does not match the host");
	if (detectedHost() !== cell.host) fail("declared terminal host does not match the process host");
}
function cleanupFailure(): Gate0RunnerError {
	return new Gate0RunnerError("timed-out child cleanup failed");
}

async function killAndWait(
	child: { kill(signal: "SIGTERM" | "SIGKILL"): void; exited: Promise<number> },
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + Math.max(timeoutMs, 1);
	const exited = child.exited.then(
		() => true,
		() => false,
	);
	const waitForExit = async (until: number): Promise<boolean> => {
		const remaining = until - Date.now();
		if (remaining <= 0) return false;
		return Promise.race([exited, Bun.sleep(remaining).then(() => false)]);
	};
	if (await Promise.race([exited, Bun.sleep(0).then(() => false)])) return true;
	try {
		child.kill("SIGTERM");
	} catch {}
	if (await waitForExit(Math.min(deadline, Date.now() + Math.max(1, Math.floor((deadline - Date.now()) / 2)))))
		return true;
	try {
		child.kill("SIGKILL");
	} catch {}
	return waitForExit(deadline);
}

export type BoundedCommandSpawner = (
	command: string[],
	options: { cwd?: string; stdout: "pipe"; stderr: "pipe" },
) => {
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	kill(signal: "SIGTERM" | "SIGKILL"): void;
};

export async function runBoundedCommand(
	command: string[],
	cwd?: string,
	timeoutMs = INVOCATION_TIMEOUT_MS,
	spawn: BoundedCommandSpawner = (argv, options) => Bun.spawn(argv, options),
): Promise<CommandResult> {
	const child = spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
	const settled = Promise.withResolvers<CommandResult>();
	let closing = false;
	const limit = Math.max(timeoutMs, 1);
	const cleanupMs = Math.min(250, Math.max(25, Math.floor(limit / 10)), Math.max(1, limit - 1));
	const deadline = Date.now() + limit;
	let timer: ReturnType<typeof setTimeout>;
	const finishFailure = async (timedOut: boolean): Promise<void> => {
		if (closing) return;
		closing = true;
		clearTimeout(timer);
		if (!(await killAndWait(child, Math.max(1, deadline - Date.now())))) {
			settled.reject(cleanupFailure());
			return;
		}
		settled.resolve({ exitCode: -1, stdout: "", stderr: "", timedOut });
	};
	timer = setTimeout(() => void finishFailure(true), Math.max(1, limit - cleanupMs));
	void Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).then(
		([stdout, stderr, exitCode]) => {
			if (closing) return;
			closing = true;
			clearTimeout(timer);
			settled.resolve({ exitCode, stdout, stderr, timedOut: false });
		},
		() => void finishFailure(false),
	);
	return settled.promise;
}

const HOST_PROCESS_ANCESTRY_LIMIT = 32;
const HOST_PROCESS_TIMEOUT_MS = 1_000;

export interface HostProcessDependencies {
	execute?: CommandRunner;
	ppid?: number;
}

function hostExecutableMatches(host: Host, executable: string): boolean {
	const normalized = executable.toLowerCase();
	if (host === "terminal") return normalized === "terminal.app" || normalized.includes("/terminal.app/");
	if (host === "ghostty")
		return normalized === "ghostty" || normalized.endsWith("/ghostty") || normalized.includes("/ghostty.app/");
	return normalized === "cmux" || normalized.endsWith("/cmux") || normalized.includes("/cmux.app/");
}

function psField(value: string, maximumLength: number): string | null {
	const trimmed = value.trim();
	return trimmed && trimmed.length <= maximumLength && !/[\r\n]/.test(trimmed) ? trimmed : null;
}

export async function captureHostProcess(
	host: Host,
	dependencies: HostProcessDependencies = {},
): Promise<HostProcessIdentity> {
	const execute = dependencies.execute ?? runBoundedCommand;
	let pid = dependencies.ppid ?? process.ppid;
	const visited = new Set<number>();
	const deadline = Date.now() + HOST_PROCESS_TIMEOUT_MS;
	for (let depth = 0; depth < HOST_PROCESS_ANCESTRY_LIMIT; depth++) {
		if (!Number.isSafeInteger(pid) || pid <= 0 || visited.has(pid)) break;
		visited.add(pid);
		const remaining = deadline - Date.now();
		if (remaining <= 0) fail("terminal host process ancestry is unavailable");
		const [ppidResult, executableResult, startResult] = await Promise.all([
			execute(["/bin/ps", "-o", "ppid=", "-p", String(pid)], undefined, remaining),
			execute(["/bin/ps", "-o", "comm=", "-p", String(pid)], undefined, remaining),
			execute(["/bin/ps", "-o", "lstart=", "-p", String(pid)], undefined, remaining),
		]);
		const ppidText = !ppidResult.timedOut && ppidResult.exitCode === 0 ? psField(ppidResult.stdout, 16) : null;
		const executable =
			!executableResult.timedOut && executableResult.exitCode === 0 ? psField(executableResult.stdout, 1_024) : null;
		const startToken = !startResult.timedOut && startResult.exitCode === 0 ? psField(startResult.stdout, 128) : null;
		const ppid = ppidText && /^\d+$/.test(ppidText) ? Number(ppidText) : NaN;
		if (!Number.isSafeInteger(ppid) || ppid < 0 || !executable || !startToken)
			fail("terminal host process ancestry is unavailable");
		const record = { ppid, executable, startToken };
		if (hostExecutableMatches(host, record.executable)) {
			return {
				host,
				pid,
				executableSha256: createHash("sha256").update(record.executable).digest("hex"),
				startTokenSha256: createHash("sha256").update(record.startToken).digest("hex"),
			};
		}
		pid = record.ppid;
	}
	fail("declared terminal host is not a direct process ancestor");
}

function sameHostProcess(left: HostProcessIdentity, right: HostProcessIdentity): boolean {
	return (
		left.host === right.host &&
		left.pid === right.pid &&
		left.executableSha256 === right.executableSha256 &&
		left.startTokenSha256 === right.startTokenSha256
	);
}

export function requireStableHostProcess(
	before: HostProcessIdentity,
	after: HostProcessIdentity,
	phase: "restart request" | "post-restart continuity",
): void {
	if (!sameHostProcess(before, after)) fail(`terminal host process changed during ${phase}`);
}

export function requireRestartedHostProcess(proof: HostProcessIdentity, current: HostProcessIdentity): void {
	if (proof.host !== current.host || proof.executableSha256 !== current.executableSha256)
		fail("restart proof does not match the current terminal host executable");
	if (proof.pid === current.pid && proof.startTokenSha256 === current.startTokenSha256)
		fail("restart proof does not prove a terminal host process restart");
}

export function requireRestartProofContinuity(proof: RestartProof, continuity: RunCellContinuityResult): void {
	if (
		continuity.sourceRevision !== proof.artifact.sourceRevision ||
		continuity.baseline.sha256 !== proof.artifact.sha256 ||
		!continuity.baselineCodesign.verified ||
		continuity.baselineCodesign.signing !== proof.codesign.signing ||
		continuity.baselineCodesign.verified !== proof.codesign.verified
	)
		fail("restart proof does not match the executed baseline continuity");
}
export async function codesignSummary(
	artifact: string,
	execute: CommandRunner = runBoundedCommand,
): Promise<CodeSignSummary> {
	const verification = await execute(["codesign", "--verify", "--strict", "--verbose=2", artifact]);
	if (verification.timedOut || verification.exitCode !== 0) return { verified: false, signing: "unavailable" };
	const display = await execute(["codesign", "--display", "--verbose=2", artifact]);
	if (display.timedOut || display.exitCode !== 0) return { verified: false, signing: "unavailable" };
	const signing = /signature=adhoc/i.test(`${display.stdout}\n${display.stderr}`) ? "adhoc" : "other";
	return { verified: true, signing };
}
async function buildReleaseArtifact(execute: CommandRunner = runBoundedCommand): Promise<void> {
	const result = await execute(["bun", "--cwd=packages/coding-agent", "run", "build"], REPO_ROOT, BUILD_TIMEOUT_MS);
	if (result.timedOut) fail("release artifact build timed out");
	if (result.exitCode !== 0) fail("release artifact build failed");
}
async function readHeadRevision(execute: CommandRunner = runBoundedCommand): Promise<string> {
	const result = await execute(["git", "rev-parse", "HEAD"], REPO_ROOT);
	const revision = result.stdout.trim();
	if (result.timedOut || result.exitCode !== 0 || !/^[a-f0-9]{40,64}$/.test(revision))
		fail("source revision is unavailable");
	return revision;
}

export async function readSourceRevision(execute: CommandRunner = runBoundedCommand): Promise<string> {
	const status = await execute(["git", "status", "--porcelain", "--untracked-files=all"], REPO_ROOT);
	if (
		status.timedOut ||
		status.exitCode !== 0 ||
		status.stdout.split("\n").some(line => line !== "" && !line.startsWith("?? .gjc/"))
	)
		fail("source changes must be committed before recording Gate-0 evidence");
	return readHeadRevision(execute);
}
export function experimentResult(value: unknown): ExperimentResult {
	if (!isGate0Result(value)) fail("hidden experiment returned an invalid Gate-0 result");
	return value;
}
export async function runCellExperimentPair(
	artifact: string,
	topology: Topology,
	invoke: Gate0ExperimentInvoker = invokeExperiment,
	request = true,
): Promise<{ probe: ExperimentResult; lifecycle: ExperimentResult }> {
	const probe = experimentResult(await invoke(artifact, { operation: "probe", request }));
	const lifecycle = experimentResult(await invoke(artifact, { operation: "lifecycle", phase: topology }));
	if (
		probe.phase !== "probe" ||
		probe.ancestry.kind !== "outer_owner" ||
		(!request && probe.requestAttempted) ||
		lifecycle.phase !== topology ||
		lifecycle.requestAttempted ||
		lifecycle.ancestry.kind !== (topology === "A1" ? "persistent_child" : "outer_owner") ||
		lifecycle.lifecycle.join(",") !== "preflight,tmux_created,attached,detached,reattached,cleaned"
	)
		fail("hidden experiment result does not match the run-cell contract");
	return { probe, lifecycle };
}
function timeoutResult(input: JsonValue): ExperimentResult {
	const record = input as { operation?: unknown; phase?: unknown },
		phase =
			record.operation === "lifecycle" && (record.phase === "A1" || record.phase === "A2") ? record.phase : "probe";
	return {
		topology: "gate0",
		phase,
		permission: { accessibility: false, screenRecording: false },
		requestAttempted: false,
		success: false,
		code: "timeout",
		ancestry: { kind: phase === "A1" ? "persistent_child" : "outer_owner", bounded: true },
		lifecycle: [],
	};
}
function spawnHiddenArtifact(artifact: string, input: JsonValue): HiddenArtifactChild {
	return Bun.spawn([artifact, "--internal-computer-gate0"], {
		env: { ...process.env, GJC_COMPUTER_GATE0_INPUT: canonicalJson(input) },
		stdout: "pipe",
		stderr: "ignore",
	});
}
export async function invokeExperiment(
	artifact: string,
	input: JsonValue,
	spawn: HiddenArtifactSpawner = spawnHiddenArtifact,
	timeoutMs = INVOCATION_TIMEOUT_MS,
): Promise<ExperimentResult> {
	const child = spawn(artifact, input);
	const settled = Promise.withResolvers<{ stdout: string; exitCode: number } | null>();
	let closing = false;
	const limit = Math.min(Math.max(timeoutMs, 1), INVOCATION_TIMEOUT_MS);
	const cleanupMs = Math.min(250, Math.max(1, Math.floor(limit / 10)));
	const deadline = Date.now() + limit;
	let timer: ReturnType<typeof setTimeout>;
	const finishFailure = async (timedOut: boolean): Promise<void> => {
		if (closing) return;
		closing = true;
		clearTimeout(timer);
		if (!(await killAndWait(child, Math.max(1, deadline - Date.now())))) {
			settled.reject(cleanupFailure());
			return;
		}
		settled.resolve(timedOut ? null : { stdout: "", exitCode: -1 });
	};
	timer = setTimeout(() => void finishFailure(true), Math.max(1, limit - cleanupMs));
	void Promise.all([new Response(child.stdout).text(), child.exited]).then(
		([stdout, exitCode]) => {
			if (closing) return;
			closing = true;
			clearTimeout(timer);
			settled.resolve({ stdout, exitCode });
		},
		() => void finishFailure(false),
	);
	const outcome = await settled.promise;
	if (!outcome) return timeoutResult(input);
	if (outcome.exitCode !== 0) fail("hidden experiment exited unsuccessfully");
	const line = outcome.stdout.endsWith("\n") ? outcome.stdout.slice(0, -1) : outcome.stdout;
	if (!line || line.includes("\n")) fail("hidden experiment must emit exactly one JSON result");
	try {
		return experimentResult(JSON.parse(line));
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("gate0:")) throw error;
		fail("hidden experiment result is not JSON");
	}
}
function pairSucceeded(
	pair: { probe: ExperimentResult; lifecycle: ExperimentResult },
	allowPendingRequest = false,
): boolean {
	return (
		pair.lifecycle.success &&
		(pair.probe.success ||
			(allowPendingRequest && pair.probe.requestAttempted && pair.probe.code === "permission_pending"))
	);
}
export async function runCellContinuity(
	artifact: ReleaseArtifact,
	topology: Topology,
	dependencies: RunCellContinuityDependencies = {},
	baselineRequest = true,
): Promise<RunCellContinuityResult> {
	const runPair = dependencies.runPair ?? runCellExperimentPair,
		build = dependencies.build ?? buildReleaseArtifact,
		readArtifact = dependencies.readArtifact ?? releaseArtifact,
		codesign = dependencies.codesign ?? codesignSummary,
		source = dependencies.sourceRevision ?? readSourceRevision;
	const sourceRevision = await source();
	const baselineCodesign = await codesign(artifact.path);
	if (!baselineCodesign.verified || baselineCodesign.signing !== "adhoc")
		fail("baseline release artifact must have a verified ad-hoc signature");
	const baselinePair = await runPair(artifact.path, topology, undefined, baselineRequest);

	if (!pairSucceeded(baselinePair, baselineRequest)) fail("baseline hidden experiment failed");
	await build();
	const postBuildRevision = await source();
	if (postBuildRevision !== sourceRevision) fail("source revision changed during rebuild");
	const updated = await readArtifact(artifact.path);
	if (updated.sha256 === artifact.sha256) fail("rebuilt release artifact did not change");
	const updatedCodesign = await codesign(updated.path);
	if (!updatedCodesign.verified || updatedCodesign.signing !== "adhoc")
		fail("updated release artifact must have a verified ad-hoc signature");
	const updatedPair = await runPair(updated.path, topology, undefined, false);
	if (!pairSucceeded(updatedPair)) fail("updated hidden experiment failed");
	return { sourceRevision, baseline: artifact, updated, baselineCodesign, updatedCodesign, baselinePair, updatedPair };
}
export async function acquireExperimentLock(root: string): Promise<() => Promise<void>> {
	const lockPath = path.join(root, EXPERIMENT_LOCK_NAME);
	const token = randomBytes(24).toString("hex");
	const record = JSON.stringify({ pid: process.pid, createdAt: Date.now(), token });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const handle = await fs.open(lockPath, "wx", 0o600);
			try {
				await handle.writeFile(record);
			} finally {
				await handle.close();
			}
			return async () => {
				try {
					if ((await fs.readFile(lockPath, "utf8")) === record) await fs.unlink(lockPath);
				} catch (error) {
					if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
				}
			};
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
		}
		await secureFile(lockPath, true);
		let current: { pid?: unknown; createdAt?: unknown; token?: unknown };
		let observed: string;
		try {
			observed = await fs.readFile(lockPath, "utf8");
			current = JSON.parse(observed);
		} catch {
			fail("experiment lock is malformed");
		}
		if (
			typeof current.pid !== "number" ||
			!Number.isSafeInteger(current.pid) ||
			current.pid <= 0 ||
			typeof current.createdAt !== "number" ||
			!Number.isSafeInteger(current.createdAt) ||
			typeof current.token !== "string" ||
			!/^[a-f0-9]{48}$/.test(current.token)
		)
			fail("experiment lock is malformed");
		if (Date.now() - current.createdAt < -60_000) fail("experiment lock is malformed");
		let live = false;
		try {
			process.kill(current.pid, 0);
			live = true;
		} catch (ownerError) {
			if (
				!(ownerError instanceof Error) ||
				!("code" in ownerError) ||
				(ownerError.code !== "ESRCH" && ownerError.code !== "EPERM")
			)
				throw ownerError;
			live = ownerError.code === "EPERM";
		}
		if (live) fail("a Gate-0 experiment is already running");
		if ((await fs.readFile(lockPath, "utf8")) === observed) await fs.unlink(lockPath);
	}
	fail("a Gate-0 experiment is already running");
}
async function writeReceipt(root: string, receipt: Gate0Receipt): Promise<void> {
	const local = await signer(root);
	const signed: SignedReceipt = {
		receipt,
		signature: {
			algorithm: "ed25519",
			keyId: local.id,
			value: sign(null, receiptPayload(receipt), local.privateKey).toString("base64"),
		},
	};
	const file = `${receipt.cell.topology}-${receipt.cell.macos}-${receipt.cell.host}-${receipt.cell.arch}-${Date.now()}-${randomBytes(6).toString("hex")}.json`,
		destination = path.join(root, "receipts", file),
		temporary = `${destination}.tmp`;
	await fs.writeFile(temporary, `${canonicalJson(signed as unknown as JsonValue)}\n`, { mode: 0o600, flag: "wx" });
	await fs.rename(temporary, destination);
}
export function restartProofFile(collection: string, cell: Gate0Receipt["cell"]): string {
	const name = `${collection}-${cell.topology}-${cell.macos}-${cell.host}-${cell.arch}.json`;
	if (name.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9._-]+\.json$/.test(name)) fail("restart proof filename is unsafe");
	return name;
}

function sameCell(left: Gate0Receipt["cell"], right: Gate0Receipt["cell"]): boolean {
	return (
		left.topology === right.topology &&
		left.macos === right.macos &&
		left.host === right.host &&
		left.arch === right.arch
	);
}

export function validRestartProof(value: unknown): value is RestartProof {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"artifact",
			"cell",
			"codesign",
			"collectionId",
			"gate",
			"hostProcess",
			"kind",
			"request",
			"requestedAt",
			"schemaVersion",
		])
	)
		return false;
	const { artifact, cell, codesign, hostProcess, request } = value;

	return (
		value.schemaVersion === 1 &&
		value.kind === "screen-recording-restart-request" &&
		value.gate === 0 &&
		typeof value.collectionId === "string" &&
		/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(value.collectionId) &&
		isRecord(cell) &&
		hasExactKeys(cell, ["arch", "host", "macos", "topology"]) &&
		TOPOLOGY_VALUES.has(cell.topology as Topology) &&
		MACOS_VALUES.has(cell.macos as Macos) &&
		HOST_VALUES.has(cell.host as Host) &&
		cell.arch === "arm64" &&
		isRecord(artifact) &&
		hasExactKeys(artifact, ["identity", "sha256", "sourceRevision"]) &&
		artifact.identity === "packages/coding-agent/dist/gjc" &&
		typeof artifact.sourceRevision === "string" &&
		/^[a-f0-9]{40,64}$/.test(artifact.sourceRevision) &&
		typeof artifact.sha256 === "string" &&
		/^[a-f0-9]{64}$/.test(artifact.sha256) &&
		validCodeSign(codesign) &&
		validHostProcess(hostProcess) &&
		hostProcess.host === cell.host &&
		typeof value.requestedAt === "string" &&
		!Number.isNaN(Date.parse(value.requestedAt)) &&
		isRecord(request) &&
		hasExactKeys(request, ["attempted", "code"]) &&
		request.attempted === true &&
		(request.code === "permission_pending" || request.code === "ok")
	);
}

export async function writeRestartProof(root: string, proof: RestartProof): Promise<void> {
	const local = await signer(root);
	const signed: SignedRestartProof = {
		proof,
		signature: {
			algorithm: "ed25519",
			keyId: local.id,
			value: sign(null, restartProofPayload(proof), local.privateKey).toString("base64"),
		},
	};
	const destination = path.join(root, RESTART_PROOFS_NAME, restartProofFile(proof.collectionId, proof.cell));
	await fs.writeFile(destination, `${canonicalJson(signed as unknown as JsonValue)}\n`, { mode: 0o600, flag: "wx" });
}

async function validateRestartProofDirectory(root: string): Promise<void> {
	const directory = path.join(root, RESTART_PROOFS_NAME);
	await secureDirectory(directory);
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		if (entry.isSymbolicLink() || !entry.isFile()) fail("restart proof path is unsafe");
		await secureFile(path.join(directory, entry.name), true);
	}
}

export async function loadRestartProof(
	root: string,
	collection: string,
	cell: Gate0Receipt["cell"],
): Promise<RestartProof | null> {
	const directory = path.join(root, RESTART_PROOFS_NAME);
	await validateRestartProofDirectory(root);
	const proofPath = path.join(directory, restartProofFile(collection, cell));
	try {
		await fs.lstat(proofPath);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
	await secureFile(proofPath, true);
	let parsed: unknown;
	try {
		parsed = JSON.parse(await fs.readFile(proofPath, "utf8"));
	} catch {
		fail("restart proof is unreadable");
	}
	if (
		!isRecord(parsed) ||
		!hasExactKeys(parsed, ["proof", "signature"]) ||
		!validRestartProof(parsed.proof) ||
		!isRecord(parsed.signature) ||
		!hasExactKeys(parsed.signature, ["algorithm", "keyId", "value"]) ||
		parsed.signature.algorithm !== "ed25519" ||
		typeof parsed.signature.value !== "string"
	)
		fail("restart proof is malformed");
	const publicKey = await trustedPublicKey(root, parsed.signature.keyId);
	const signature = canonicalEd25519Signature(parsed.signature.value);
	if (!verify(null, restartProofPayload(parsed.proof), publicKey, signature))
		fail("restart proof signature is invalid");
	const requested = Date.parse(parsed.proof.requestedAt);
	const now = Date.now();
	if (now - requested > COLLECTION_WINDOW_MS || requested > now + 60_000)
		fail("restart proof timestamp is outside the collection window");
	if (parsed.proof.collectionId !== collection || !sameCell(parsed.proof.cell, cell))
		fail("restart proof does not match the requested cell");
	return parsed.proof;
}

export async function removeRestartProof(root: string, proof: RestartProof): Promise<void> {
	const target = path.join(root, RESTART_PROOFS_NAME, restartProofFile(proof.collectionId, proof.cell));
	await secureFile(target, true);
	await fs.unlink(target);
}

export function restartRequestCode(result: ExperimentResult): RestartProof["request"]["code"] {
	if (
		result.phase !== "probe" ||
		result.ancestry.kind !== "outer_owner" ||
		result.lifecycle.length !== 0 ||
		result.requestAttempted !== true ||
		(result.code !== "permission_pending" && result.code !== "ok") ||
		(result.code === "permission_pending" && result.permission.screenRecording) ||
		(result.code === "ok" && (!result.permission.screenRecording || !result.permission.accessibility))
	)
		fail("hidden experiment result does not match the restart request contract");
	return result.code;
}

export interface PersistReceiptDependencies {
	writeReceipt?: (root: string, receipt: Gate0Receipt) => Promise<void>;
	removeRestartProof?: (root: string, proof: RestartProof) => Promise<void>;
}

export async function persistReceiptAndConsumeProof(
	root: string,
	receipt: Gate0Receipt,
	proof: RestartProof | null,
	dependencies: PersistReceiptDependencies = {},
): Promise<void> {
	await (dependencies.writeReceipt ?? writeReceipt)(root, receipt);
	if (proof) await (dependencies.removeRestartProof ?? removeRestartProof)(root, proof);
}

async function requestCell(args: string[]): Promise<void> {
	const cell = parseCell(args),
		collection = collectionId();
	validateEnvironment(cell);
	const root = evidenceRoot();
	await ensureEvidenceRoot(root);
	const releaseLock = await acquireExperimentLock(root);
	try {
		const artifact = await releaseArtifact(requireFlag(args, "artifact"));
		const sourceRevision = await readSourceRevision();
		const codesign = await codesignSummary(artifact.path);
		if (!codesign.verified || codesign.signing !== "adhoc")
			fail("release artifact must have a verified ad-hoc signature");
		const existing = await loadRestartProof(root, collection, cell);
		if (existing) fail("restart proof already exists for this cell");
		const requestHost = await captureHostProcess(cell.host);

		const result = experimentResult(await invokeExperiment(artifact.path, { operation: "probe", request: true }));
		const requestCode = restartRequestCode(result);
		const currentArtifact = await releaseArtifact(artifact.path);
		const currentSource = await readSourceRevision();
		const currentCodesign = await codesignSummary(currentArtifact.path);
		if (
			currentArtifact.sha256 !== artifact.sha256 ||
			currentSource !== sourceRevision ||
			!currentCodesign.verified ||
			currentCodesign.signing !== "adhoc" ||
			currentCodesign.signing !== codesign.signing ||
			currentCodesign.verified !== codesign.verified
		)
			fail("artifact, source, or codesign state changed during restart request collection");
		const postRequestHost = await captureHostProcess(cell.host);
		requireStableHostProcess(requestHost, postRequestHost, "restart request");

		const proof: RestartProof = {
			schemaVersion: 1,
			kind: "screen-recording-restart-request",
			gate: 0,
			collectionId: collection,
			cell,
			artifact: { identity: "packages/coding-agent/dist/gjc", sourceRevision, sha256: artifact.sha256 },
			codesign,
			hostProcess: requestHost,

			requestedAt: new Date().toISOString(),
			request: { attempted: true, code: requestCode },
		};
		await writeRestartProof(root, proof);
		process.stdout.write(`${canonicalJson({ gate: 0, cell, restartRequired: true } as JsonValue)}\n`);
	} finally {
		await releaseLock();
	}
}

async function runCell(args: string[]): Promise<void> {
	const cell = parseCell(args),
		collection = collectionId();
	validateEnvironment(cell);
	const root = evidenceRoot();
	await ensureEvidenceRoot(root);
	const releaseLock = await acquireExperimentLock(root);
	try {
		const startedAt = new Date().toISOString(),
			artifact = await releaseArtifact(requireFlag(args, "artifact"));
		const proof = await loadRestartProof(root, collection, cell);
		let restartHost: HostProcessIdentity | null = null;
		if (proof) {
			restartHost = await captureHostProcess(cell.host);
			requireRestartedHostProcess(proof.hostProcess, restartHost);

			const sourceRevision = await readSourceRevision();
			const codesign = await codesignSummary(artifact.path);
			if (
				proof.artifact.sourceRevision !== sourceRevision ||
				proof.artifact.sha256 !== artifact.sha256 ||
				!validCodeSign(codesign) ||
				codesign.signing !== proof.codesign.signing ||
				codesign.verified !== proof.codesign.verified
			)
				fail("restart proof does not match the current artifact, source, or codesign state");
		}
		const continuity = await runCellContinuity(artifact, cell.topology, {}, !proof);
		if (proof) requireRestartProofContinuity(proof, continuity);
		if (!proof && !continuity.baselinePair.probe.requestAttempted)
			fail("baseline did not exercise the explicit Screen Recording request");
		const receipt: Gate0Receipt = {
			schemaVersion: 1,
			gate: 0,
			collectionId: collection,
			cell,
			artifact: {
				identity: "packages/coding-agent/dist/gjc",
				sourceRevision: continuity.sourceRevision,
				baselineSha256: continuity.baseline.sha256,
				updatedSha256: continuity.updated.sha256,
			},
			codesign: { baseline: continuity.baselineCodesign, updated: continuity.updatedCodesign, compatible: true },
			continuity: { baselineSuccess: true, updatedSuccess: true },
			timestamps: { startedAt, completedAt: new Date().toISOString() },
			permissions: {
				screenRecordingGranted: continuity.updatedPair.lifecycle.permission.screenRecording,
				accessibilityGranted: continuity.updatedPair.lifecycle.permission.accessibility,
				requestAttempted: proof ? true : continuity.baselinePair.probe.requestAttempted,
			},
			ancestry: continuity.updatedPair.lifecycle.ancestry,
			lifecycle: { markers: continuity.updatedPair.lifecycle.lifecycle },
			result: { success: true, code: "ok" },
		};
		if (proof && restartHost) {
			requireStableHostProcess(restartHost, await captureHostProcess(cell.host), "post-restart continuity");
		}

		await persistReceiptAndConsumeProof(root, receipt, proof);
		process.stdout.write(`${canonicalJson({ gate: 0, cell, result: receipt.result } as JsonValue)}\n`);
	} finally {
		await releaseLock();
	}
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}
function validHostProcess(value: unknown): value is HostProcessIdentity {
	return (
		isRecord(value) &&
		hasExactKeys(value, ["executableSha256", "host", "pid", "startTokenSha256"]) &&
		HOST_VALUES.has(value.host as Host) &&
		typeof value.pid === "number" &&
		Number.isSafeInteger(value.pid) &&
		value.pid > 0 &&
		typeof value.executableSha256 === "string" &&
		/^[a-f0-9]{64}$/.test(value.executableSha256) &&
		typeof value.startTokenSha256 === "string" &&
		/^[a-f0-9]{64}$/.test(value.startTokenSha256)
	);
}

function validCodeSign(value: unknown): value is CodeSignSummary {
	return (
		isRecord(value) &&
		hasExactKeys(value, ["signing", "verified"]) &&
		value.verified === true &&
		value.signing === "adhoc"
	);
}
function validReceipt(value: unknown): value is Gate0Receipt {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
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
		])
	)
		return false;
	const { cell, artifact, codesign, continuity, timestamps, permissions, ancestry, lifecycle, result } = value;
	return (
		value.schemaVersion === 1 &&
		value.gate === 0 &&
		typeof value.collectionId === "string" &&
		/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(value.collectionId) &&
		isRecord(cell) &&
		hasExactKeys(cell, ["arch", "host", "macos", "topology"]) &&
		TOPOLOGY_VALUES.has(cell.topology as Topology) &&
		MACOS_VALUES.has(cell.macos as Macos) &&
		HOST_VALUES.has(cell.host as Host) &&
		cell.arch === "arm64" &&
		isRecord(artifact) &&
		hasExactKeys(artifact, ["baselineSha256", "identity", "sourceRevision", "updatedSha256"]) &&
		artifact.identity === "packages/coding-agent/dist/gjc" &&
		typeof artifact.sourceRevision === "string" &&
		/^[a-f0-9]{40,64}$/.test(artifact.sourceRevision) &&
		typeof artifact.baselineSha256 === "string" &&
		/^[a-f0-9]{64}$/.test(artifact.baselineSha256) &&
		typeof artifact.updatedSha256 === "string" &&
		/^[a-f0-9]{64}$/.test(artifact.updatedSha256) &&
		artifact.baselineSha256 !== artifact.updatedSha256 &&
		isRecord(codesign) &&
		hasExactKeys(codesign, ["baseline", "compatible", "updated"]) &&
		validCodeSign(codesign.baseline) &&
		validCodeSign(codesign.updated) &&
		codesign.compatible === true &&
		isRecord(continuity) &&
		hasExactKeys(continuity, ["baselineSuccess", "updatedSuccess"]) &&
		continuity.baselineSuccess === true &&
		continuity.updatedSuccess === true &&
		isRecord(timestamps) &&
		hasExactKeys(timestamps, ["completedAt", "startedAt"]) &&
		typeof timestamps.startedAt === "string" &&
		typeof timestamps.completedAt === "string" &&
		!Number.isNaN(Date.parse(timestamps.startedAt)) &&
		!Number.isNaN(Date.parse(timestamps.completedAt)) &&
		isRecord(permissions) &&
		hasExactKeys(permissions, ["accessibilityGranted", "requestAttempted", "screenRecordingGranted"]) &&
		permissions.screenRecordingGranted === true &&
		permissions.accessibilityGranted === true &&
		permissions.requestAttempted === true &&
		isRecord(ancestry) &&
		hasExactKeys(ancestry, ["bounded", "kind"]) &&
		((cell.topology === "A1" && ancestry.kind === "persistent_child") ||
			(cell.topology === "A2" && ancestry.kind === "outer_owner")) &&
		ancestry.bounded === true &&
		isRecord(lifecycle) &&
		hasExactKeys(lifecycle, ["markers"]) &&
		Array.isArray(lifecycle.markers) &&
		lifecycle.markers.join(",") === "preflight,tmux_created,attached,detached,reattached,cleaned" &&
		isRecord(result) &&
		hasExactKeys(result, ["code", "success"]) &&
		result.success === true &&
		result.code === "ok"
	);
}
async function trustedPublicKey(root: string, id: unknown): Promise<ReturnType<typeof createPublicKey>> {
	if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) fail("receipt signer is invalid");
	const trust = path.join(root, TRUSTED_SIGNERS_NAME, `${id}.pem`);
	await secureFile(trust, false);
	let publicKey: ReturnType<typeof createPublicKey>;
	try {
		publicKey = createPublicKey(await fs.readFile(trust));
	} catch {
		fail("trusted signer PEM is malformed");
	}
	if (publicKey.asymmetricKeyType !== "ed25519") fail("trusted signer key must be Ed25519");
	const derived = keyId(publicKey.export({ type: "spki", format: "der" }) as Buffer);
	if (derived !== id) fail("trusted signer key id does not match PEM");
	return publicKey;
}
function canonicalEd25519Signature(value: string): Buffer {
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==)$/.test(value)) fail("receipt signature is invalid");
	const signature = Buffer.from(value, "base64");
	if (signature.byteLength !== 64 || signature.toString("base64") !== value) fail("receipt signature is invalid");
	return signature;
}

async function loadReceipts(root: string): Promise<Gate0Receipt[]> {
	await secureDirectory(path.join(root, "receipts"));
	await secureDirectory(path.join(root, TRUSTED_SIGNERS_NAME));
	const entries = await fs.readdir(path.join(root, "receipts"), { withFileTypes: true });
	const receipts: Gate0Receipt[] = [];
	for (const entry of entries) {
		if (entry.isSymbolicLink()) fail("receipt path is unsafe");
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const receiptPath = path.join(root, "receipts", entry.name);
		await secureFile(receiptPath, true);
		let parsed: unknown;
		try {
			parsed = JSON.parse(await fs.readFile(receiptPath, "utf8"));
		} catch {
			fail("receipt is unreadable");
		}
		if (
			!isRecord(parsed) ||
			!hasExactKeys(parsed, ["receipt", "signature"]) ||
			!validReceipt(parsed.receipt) ||
			!isRecord(parsed.signature) ||
			!hasExactKeys(parsed.signature, ["algorithm", "keyId", "value"]) ||
			parsed.signature.algorithm !== "ed25519" ||
			typeof parsed.signature.value !== "string"
		)
			fail("receipt is malformed");
		const publicKey = await trustedPublicKey(root, parsed.signature.keyId);
		const signature = canonicalEd25519Signature(parsed.signature.value);
		if (!verify(null, receiptPayload(parsed.receipt), publicKey, signature)) fail("receipt signature is invalid");
		receipts.push(parsed.receipt);
	}
	return receipts;
}
function requiredMatrix(topology: Topology, macos: Macos[], hosts: Host[]): Set<string> {
	if (macos.length !== 3 || new Set(macos).size !== 3 || !macos.every(item => MACOS_VALUES.has(item)))
		fail("--macos must declare 14,15,26 exactly");
	if (hosts.length !== 3 || new Set(hosts).size !== 3 || !hosts.every(item => HOST_VALUES.has(item)))
		fail("--hosts must declare terminal,ghostty,cmux exactly");
	return new Set(macos.flatMap(version => hosts.map(host => `${topology}/${version}/${host}/arm64`)));
}
export interface AggregateDependencies {
	sourceRevision?: () => Promise<string>;
	execute?: CommandRunner;
	loadReceipts?: (root: string) => Promise<Gate0Receipt[]>;
	now?: () => number;
}

export async function aggregate(args: string[], dependencies: AggregateDependencies = {}): Promise<void> {
	if (requireFlag(args, "gate") !== "0") fail("only --gate=0 is supported");
	if (!args.includes("--require-all")) fail("--require-all is required");
	const topologyValue = requireFlag(args, "topology");
	if (!TOPOLOGY_VALUES.has(topologyValue as Topology)) fail("--topology must be A1 or A2");
	const topology = topologyValue as Topology;
	const required = requiredMatrix(
		topology,
		requireFlag(args, "macos").split(",") as Macos[],
		requireFlag(args, "hosts").split(",") as Host[],
	);
	const expectedCollection = collectionId();
	const root = evidenceRoot(),
		source = dependencies.sourceRevision ?? (() => readSourceRevision(dependencies.execute)),
		readReceipts = dependencies.loadReceipts ?? loadReceipts,
		now = dependencies.now ?? Date.now;
	await ensureEvidenceRoot(root);
	const currentRevision = await source();
	const receipts = await readReceipts(root);
	const currentTime = now();
	const matching = receipts.filter(receipt => receipt.cell.topology === topology);
	for (const receipt of matching) {
		const started = Date.parse(receipt.timestamps.startedAt);
		const completed = Date.parse(receipt.timestamps.completedAt);
		if (receipt.collectionId !== expectedCollection) fail("receipt collection ID does not match");
		if (receipt.artifact.sourceRevision !== currentRevision)
			fail("receipt source revision does not match current HEAD");
		if (
			started > completed ||
			currentTime - started > COLLECTION_WINDOW_MS ||
			started > currentTime + 60_000 ||
			completed > currentTime + 60_000
		)
			fail("receipt timestamp is outside the collection window");
	}
	const identities = new Set<string>();
	for (const receipt of matching) {
		const identity = `${receipt.cell.topology}/${receipt.cell.macos}/${receipt.cell.host}/${receipt.cell.arch}`;
		if (!required.has(identity)) fail("receipt cell does not belong to the declared matrix");
		if (identities.has(identity)) fail("duplicate receipt cell");
		identities.add(identity);
	}
	if (identities.size !== required.size || [...required].some(identity => !identities.has(identity)))
		fail("required receipt cell is missing");
	if ((await source()) !== currentRevision) fail("source revision changed during aggregation");
	process.stdout.write(
		`${canonicalJson({ gate: 0, topology, cells: identities.size, result: "passed" } as JsonValue)}\n`,
	);
}
async function main(argv: string[]): Promise<void> {
	const [command, ...args] = argv;
	if (command === "request-cell") return requestCell(args);
	if (command === "run-cell") return runCell(args);
	if (command === "aggregate") return aggregate(args);
	fail("expected request-cell, run-cell, or aggregate");
}
if (import.meta.main)
	main(process.argv.slice(2)).catch(error => {
		const message = error instanceof Gate0RunnerError ? error.message : "gate0: internal error";
		process.stderr.write(`${message}\n`);
		process.exitCode = 1;
	});
