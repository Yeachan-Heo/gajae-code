import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import { nativeProcessBindings } from "@gajae-code/utils/native-process";
import { resolveGjcTmuxBinary } from "../../gjc-runtime/psmux-detect";
import { sessionRuntimeDir } from "../../gjc-runtime/session-layout";
import { resolveGjcTmuxProviderContext } from "../../gjc-runtime/tmux-provider-context";
import {
	createManagedGjcTmuxSession,
	forceCloseManagedGjcTmuxSession,
	type ManagedTmuxLaunchProof,
	verifyManagedGjcTmuxSession,
} from "../../gjc-runtime/tmux-sessions";
import { processIncarnation } from "./process-incarnation";
import type { SpawnSubstrateLaunchSpec, SpawnSubstrateProof, SpawnSubstrateProvider } from "./spawn-authority";

export type SpawnMultiplexerSelection = "none" | "tmux" | "psmux" | "proof_failed";

export interface SpawnHeadlessProcess {
	pid: number;
	terminate(): void;
}

export interface SpawnSubstrateProviderDependencies {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	/** @internal Test seam for deterministic provider selection. */
	selectMultiplexer?: () => SpawnMultiplexerSelection;
	/** @internal Test seam for the managed multiplexer command layer. */
	launchManaged?: (
		spec: SpawnSubstrateLaunchSpec,
		env: NodeJS.ProcessEnv,
		platform: NodeJS.Platform,
	) => ManagedTmuxLaunchProof;
	verifyManaged?: (proof: ManagedTmuxLaunchProof, env: NodeJS.ProcessEnv) => "verified" | "mismatch" | "gone";
	closeManaged?: (proof: ManagedTmuxLaunchProof, env: NodeJS.ProcessEnv) => Promise<void>;
	processIncarnation?: (pid: number) => string | undefined;
	startHeadless?: (spec: SpawnSubstrateLaunchSpec, env: NodeJS.ProcessEnv) => SpawnHeadlessProcess;
	signalHeadless?: (
		pid: number,
		incarnation: string,
		platform: NodeJS.Platform,
		signal: "SIGTERM" | "SIGKILL",
	) => boolean;
	isProcessGone?: (pid: number) => boolean;
	/** @internal Test seam for bounded close polling. */
	sleep?: (milliseconds: number) => Promise<void>;
	/** @internal Test seam for non-secret inherited-environment launch diagnostics. */
	onInheritedEnvironmentDrop?: (names: readonly string[]) => void;
}

type HeadlessState = {
	version: 1;
	pid: number;
	processIncarnation: string;
	providerIdentity: string;
	childSessionId: string;
	createdAt: number;
};

const MAX_SUBSTRATE_DIAGNOSTIC_LENGTH = 512;

const HEADLESS_STATE_KEYS = new Set([
	"version",
	"pid",
	"processIncarnation",
	"providerIdentity",
	"childSessionId",
	"createdAt",
]);

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADLESS_CLOSE_GRACE_MS = 2_000;
const HEADLESS_CLOSE_POLL_MS = 50;

function messageFor(code: "substrate_unavailable" | "substrate_proof_failed"): string {
	return code === "substrate_unavailable"
		? "No safe spawn substrate is available."
		: "The selected spawn substrate could not be proven exactly.";
}

function launchFailureMessage(selected: "tmux" | "psmux" | "headless", error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	const bounded = detail
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.trim()
		.slice(0, MAX_SUBSTRATE_DIAGNOSTIC_LENGTH);
	return `${selected} substrate launch failed${bounded ? `: ${bounded}` : ""}`;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: Set<string>): boolean {
	return Object.keys(value).every(key => keys.has(key));
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 4096;
}

/** An environment VALUE may be empty but is still length-bounded. */
function isBoundedString(value: unknown): value is string {
	return typeof value === "string" && value.length <= 4096;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validLaunchSpec(spec: SpawnSubstrateLaunchSpec, platform: NodeJS.Platform): boolean {
	const pathModule = platform === "win32" ? path.win32 : path;
	return (
		isNonEmptyString(spec.childSessionId) &&
		!spec.childSessionId.includes("\0") &&
		isNonEmptyString(spec.cwd) &&
		!spec.cwd.includes("\0") &&
		pathModule.isAbsolute(spec.cwd) &&
		Array.isArray(spec.argv) &&
		spec.argv.length > 0 &&
		spec.argv.every(value => isNonEmptyString(value) && !value.includes("\0")) &&
		(spec.env === undefined ||
			Object.entries(spec.env).every(
				([name, value]) => ENVIRONMENT_NAME.test(name) && isBoundedString(value) && !value.includes("\0"),
			))
	);
}

function filterInheritedEnvironment(environment: NodeJS.ProcessEnv | Readonly<Record<string, string>>): {
	environment: NodeJS.ProcessEnv;
	dropped: string[];
} {
	const filtered: NodeJS.ProcessEnv = {};
	const dropped: string[] = [];
	for (const [name, value] of Object.entries(environment).sort(([left], [right]) =>
		left < right ? -1 : left > right ? 1 : 0,
	)) {
		if (ENVIRONMENT_NAME.test(name) && isBoundedString(value) && !value.includes("\0")) filtered[name] = value;
		else dropped.push(name);
	}
	return { environment: filtered, dropped };
}

function isHeadlessState(value: unknown): value is HeadlessState {
	return (
		typeof value === "object" &&
		value !== null &&
		hasOnlyKeys(value as Record<string, unknown>, HEADLESS_STATE_KEYS) &&
		(value as { version?: unknown }).version === 1 &&
		isPositiveInteger((value as { pid?: unknown }).pid) &&
		isNonEmptyString((value as { processIncarnation?: unknown }).processIncarnation) &&
		isNonEmptyString((value as { providerIdentity?: unknown }).providerIdentity) &&
		isNonEmptyString((value as { childSessionId?: unknown }).childSessionId) &&
		isTimestamp((value as { createdAt?: unknown }).createdAt)
	);
}

function stateFileFor(spec: SpawnSubstrateLaunchSpec, providerIdentity: string): string {
	return path.join(sessionRuntimeDir(spec.cwd, spec.childSessionId), "spawn-substrates", `${providerIdentity}.json`);
}

async function writeHeadlessState(file: string, value: HeadlessState): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const handle = await fs.open(file, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(value)}\n`);
		await handle.sync();
	} finally {
		await handle.close();
	}
	const directory = await fs.open(path.dirname(file), "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

async function readHeadlessState(file: string): Promise<HeadlessState | null> {
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
		return isHeadlessState(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function commandAvailable(command: string): boolean {
	return Bun.which(command) !== null;
}

function defaultMultiplexerSelection(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): SpawnMultiplexerSelection {
	try {
		if (platform === "darwin" || platform === "linux") {
			const binary = resolveGjcTmuxBinary({ env, platform });
			if (!commandAvailable(binary.command)) return "none";
			if (binary.isPsmux) return "proof_failed";
			const provider = resolveGjcTmuxProviderContext({ env, platform, binary });
			return provider.kind === "native-tmux" ? "tmux" : "proof_failed";
		}
		if (platform !== "win32") return "none";
		const binary = resolveGjcTmuxBinary({ env, platform });
		if (!commandAvailable(binary.command)) return "none";
		if (!binary.isPsmux) return env.GJC_TMUX_COMMAND?.trim() ? "proof_failed" : "none";
		const provider = resolveGjcTmuxProviderContext({ env, platform, binary });
		return provider.kind === "windows-psmux" ? "psmux" : "proof_failed";
	} catch {
		return "proof_failed";
	}
}

function startHeadless(spec: SpawnSubstrateLaunchSpec, env: NodeJS.ProcessEnv): SpawnHeadlessProcess {
	const child = Bun.spawn({
		cmd: [...spec.argv],
		cwd: spec.cwd,
		env,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	return { pid: child.pid, terminate: () => child.kill() };
}

function defaultIsProcessGone(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
	}
}

function signalExactHeadless(
	pid: number,
	expectedIncarnation: string,
	platform: NodeJS.Platform,
	signal: "SIGTERM" | "SIGKILL",
): boolean {
	try {
		const reference = nativeProcessBindings().Process.fromPid(pid);
		if (!reference || reference.incarnation !== expectedIncarnation) return false;
		if (platform === "darwin") {
			const current = nativeProcessBindings().Process.fromPid(pid);
			if (!current || current.incarnation !== expectedIncarnation) return false;
			process.kill(pid, signal);
			return true;
		}
		const rootProcess = reference as typeof reference & { signalRoot(signal: number): boolean };
		const signalNumber = signal === "SIGTERM" ? os.constants.signals.SIGTERM : os.constants.signals.SIGKILL;
		return signalNumber !== undefined && rootProcess.signalRoot(signalNumber);
	} catch {
		return false;
	}
}

function readStateProof(proof: SpawnSubstrateProof): { stateFile: string; childSessionId: string } | null {
	const stateFile = proof.stateFileProof?.stateFile;
	const childSessionId = proof.stateFileProof?.childSessionId;
	return isNonEmptyString(stateFile) && isNonEmptyString(childSessionId) ? { stateFile, childSessionId } : null;
}

function managedProofFrom(proof: SpawnSubstrateProof): ManagedTmuxLaunchProof | null {
	if (proof.substrateKind !== "tmux" && proof.substrateKind !== "psmux") return null;
	const stateProof = proof.stateFileProof;
	const name = stateProof?.sessionName;
	const sessionId = stateProof?.sessionId;
	const sessionStateFile = stateProof?.sessionStateFile;
	const ownerGeneration = stateProof?.ownerGeneration;
	const serverPid = stateProof?.serverPid;
	const serverStartTime = stateProof?.serverStartTime;
	const psmuxIncarnation = stateProof?.psmuxIncarnation;
	const validatedPsmuxIncarnation = isNonEmptyString(psmuxIncarnation) ? psmuxIncarnation : undefined;
	if (
		!isNonEmptyString(proof.nativeSessionId) ||
		!isPositiveInteger(proof.pid) ||
		!isNonEmptyString(name) ||
		!isNonEmptyString(sessionId) ||
		!isNonEmptyString(sessionStateFile) ||
		!isNonEmptyString(ownerGeneration) ||
		!isPositiveInteger(serverPid) ||
		!isNonEmptyString(serverStartTime) ||
		(proof.substrateKind === "psmux" && validatedPsmuxIncarnation === undefined) ||
		(proof.substrateKind === "tmux" && psmuxIncarnation !== undefined)
	)
		return null;
	return {
		name,
		nativeSessionId: proof.nativeSessionId,
		serverPid,
		serverStartTime,
		ownerGeneration,
		sessionId,
		sessionStateFile,
		pid: proof.pid,
		providerIdentity: proof.providerIdentity,
		...(validatedPsmuxIncarnation === undefined ? {} : { psmuxIncarnation: validatedPsmuxIncarnation }),
	};
}

function headlessProofMatches(proof: SpawnSubstrateProof, state: HeadlessState): boolean {
	const stateProof = readStateProof(proof);
	return (
		proof.substrateKind === "headless" &&
		isPositiveInteger(proof.pid) &&
		isNonEmptyString(proof.processIncarnation) &&
		stateProof !== null &&
		proof.pid === state.pid &&
		proof.processIncarnation === state.processIncarnation &&
		proof.providerIdentity === state.providerIdentity &&
		stateProof.childSessionId === state.childSessionId
	);
}

async function waitForHeadlessExit(
	proof: SpawnSubstrateProof,
	verify: (proof: SpawnSubstrateProof) => Promise<"verified" | "mismatch" | "gone">,
	sleep: (milliseconds: number) => Promise<void>,
): Promise<"verified" | "mismatch" | "gone"> {
	let verdict = await verify(proof);
	if (verdict !== "verified") return verdict;
	const polls = Math.ceil(HEADLESS_CLOSE_GRACE_MS / HEADLESS_CLOSE_POLL_MS);
	for (let attempt = 0; attempt < polls; attempt++) {
		await sleep(HEADLESS_CLOSE_POLL_MS);
		verdict = await verify(proof);
		if (verdict !== "verified") return verdict;
	}
	return verdict;
}

function managedStateProof(proof: ManagedTmuxLaunchProof): Readonly<Record<string, string | number>> {
	return {
		sessionName: proof.name,
		sessionId: proof.sessionId,
		sessionStateFile: proof.sessionStateFile,
		ownerGeneration: proof.ownerGeneration,
		serverPid: proof.serverPid,
		serverStartTime: proof.serverStartTime,
		...(proof.psmuxIncarnation === undefined ? {} : { psmuxIncarnation: proof.psmuxIncarnation }),
	};
}

/**
 * Provides the Broker's only substrate authority. Every close and replay starts
 * from its durable opaque proof; no PID/name-only operation is exposed.
 */
export function createSpawnSubstrateProvider(
	dependencies: SpawnSubstrateProviderDependencies = {},
): SpawnSubstrateProvider {
	const platform = dependencies.platform ?? process.platform;
	const env = dependencies.env ?? process.env;
	const selectMultiplexer = dependencies.selectMultiplexer ?? (() => defaultMultiplexerSelection(platform, env));
	const launchManaged =
		dependencies.launchManaged ??
		((spec, launchEnv, launchPlatform) => createManagedGjcTmuxSession(spec, launchEnv, { platform: launchPlatform }));
	const verifyManaged = dependencies.verifyManaged ?? verifyManagedGjcTmuxSession;
	const closeManaged =
		dependencies.closeManaged ??
		(async (proof, closeEnv) => {
			await forceCloseManagedGjcTmuxSession(proof, closeEnv);
		});
	const readIncarnation = dependencies.processIncarnation ?? processIncarnation;
	const launchHeadless = dependencies.startHeadless ?? startHeadless;
	const signalHeadless = dependencies.signalHeadless ?? signalExactHeadless;
	const isGone = dependencies.isProcessGone ?? defaultIsProcessGone;
	const sleep = dependencies.sleep ?? (milliseconds => Bun.sleep(milliseconds));
	const launchHeadlessSubstrate = async (spec: SpawnSubstrateLaunchSpec, launchEnv: NodeJS.ProcessEnv) => {
		let child: SpawnHeadlessProcess;
		try {
			child = launchHeadless(spec, launchEnv);
		} catch {
			return {
				ok: false as const,
				code: "substrate_unavailable" as const,
				message: messageFor("substrate_unavailable"),
			};
		}
		const incarnation = readIncarnation(child.pid);
		if (!incarnation) {
			child.terminate();
			return {
				ok: false as const,
				code: "substrate_proof_failed" as const,
				message: messageFor("substrate_proof_failed"),
			};
		}
		const providerIdentity = crypto.randomUUID();
		const state: HeadlessState = {
			version: 1,
			pid: child.pid,
			processIncarnation: incarnation,
			providerIdentity,
			childSessionId: spec.childSessionId,
			createdAt: Date.now(),
		};
		const stateFile = stateFileFor(spec, providerIdentity);
		try {
			await writeHeadlessState(stateFile, state);
		} catch {
			child.terminate();
			return {
				ok: false as const,
				code: "substrate_proof_failed" as const,
				message: messageFor("substrate_proof_failed"),
			};
		}
		return {
			ok: true as const,
			proof: {
				substrateKind: "headless" as const,
				providerIdentity,
				pid: child.pid,
				processIncarnation: incarnation,
				stateFileProof: { stateFile, childSessionId: spec.childSessionId },
			},
		};
	};

	const provider: SpawnSubstrateProvider = {
		async launch(spec) {
			if (!validLaunchSpec(spec, platform))
				return { ok: false, code: "substrate_proof_failed", message: messageFor("substrate_proof_failed") };
			const inherited = filterInheritedEnvironment(spec.inheritedEnv ?? env);
			if (inherited.dropped.length > 0) {
				if (dependencies.onInheritedEnvironmentDrop) dependencies.onInheritedEnvironmentDrop(inherited.dropped);
				else
					logger.warn("sdk broker dropped unsupported inherited child environment entries", {
						names: inherited.dropped,
					});
			}
			const launchEnv: NodeJS.ProcessEnv = { ...inherited.environment, ...(spec.env ?? {}) };
			const selected = selectMultiplexer();
			if (selected === "proof_failed")
				return { ok: false, code: "substrate_proof_failed", message: messageFor("substrate_proof_failed") };
			if (selected === "tmux" || selected === "psmux") {
				let managed: ManagedTmuxLaunchProof;
				try {
					managed = launchManaged(spec, launchEnv, platform);
				} catch (error) {
					const failure = launchFailureMessage(selected, error);
					try {
						const fallback = await launchHeadlessSubstrate(spec, launchEnv);
						if (fallback.ok) return fallback;
						return {
							ok: false,
							code: fallback.code,
							message: `${failure}; headless substrate failed: ${fallback.message}`,
						};
					} catch (fallbackError) {
						return {
							ok: false,
							code: "substrate_unavailable",
							message: `${failure}; headless substrate failed: ${launchFailureMessage("headless", fallbackError)}`,
						};
					}
				}
				const incarnation = readIncarnation(managed.pid);
				if (!incarnation || verifyManaged(managed, launchEnv) !== "verified") {
					try {
						await closeManaged(managed, launchEnv);
					} catch {
						// The managed close primitive is already exact-proof fenced. Retain its result only in authority state.
					}
					const failure = launchFailureMessage(selected, new Error("exact substrate proof failed"));
					const fallback = await launchHeadlessSubstrate(spec, launchEnv);
					if (fallback.ok) return fallback;
					return {
						ok: false,
						code: fallback.code,
						message: `${failure}; headless substrate failed: ${fallback.message}`,
					};
				}
				return {
					ok: true,
					proof: {
						substrateKind: selected,
						providerIdentity: managed.providerIdentity,
						nativeSessionId: managed.nativeSessionId,
						pid: managed.pid,
						processIncarnation: incarnation,
						stateFileProof: managedStateProof(managed),
					},
				};
			}
			return launchHeadlessSubstrate(spec, launchEnv);
		},
		async verify(proof) {
			const managed = managedProofFrom(proof);
			if (managed) {
				const verdict = verifyManaged(managed, env);
				if (verdict !== "verified") return verdict;
				const incarnation = proof.pid === undefined ? undefined : readIncarnation(proof.pid);
				if (!incarnation) return proof.pid !== undefined && isGone(proof.pid) ? "gone" : "mismatch";
				return incarnation === proof.processIncarnation ? "verified" : "mismatch";
			}
			if (proof.substrateKind !== "headless") return "mismatch";
			const stateProof = readStateProof(proof);
			if (!stateProof) return "mismatch";
			const state = await readHeadlessState(stateProof.stateFile);
			if (!state || !headlessProofMatches(proof, state)) return "mismatch";
			const incarnation = proof.pid === undefined ? undefined : readIncarnation(proof.pid);
			if (!incarnation) return proof.pid !== undefined && isGone(proof.pid) ? "gone" : "mismatch";
			return incarnation === proof.processIncarnation ? "verified" : "mismatch";
		},
		async close(proof) {
			const verification = await provider.verify(proof);
			if (verification !== "verified") return { ok: false, code: `substrate_${verification}` };
			const managed = managedProofFrom(proof);
			if (managed) {
				try {
					await closeManaged(managed, env);
					return { ok: true };
				} catch {
					return { ok: false, code: "substrate_close_failed" };
				}
			}
			if (!isPositiveInteger(proof.pid) || !isNonEmptyString(proof.processIncarnation))
				return { ok: false, code: "substrate_mismatch" };
			const pid = proof.pid;
			const closeFailure = (verdict: "verified" | "mismatch" | "gone") => ({
				ok: false,
				code: verdict === "verified" ? "substrate_close_pending" : `substrate_${verdict}`,
			});
			const verifyAfterSignal = async (): Promise<"verified" | "mismatch" | "gone"> => {
				const verdict = await provider.verify(proof);
				if (verdict === "mismatch" && readIncarnation(pid) === undefined && isGone(pid)) return "gone";
				return verdict;
			};
			// Delivery starts shutdown; only a later exact proof of absence completes it.
			if (!signalHeadless(proof.pid, proof.processIncarnation, platform, "SIGTERM")) {
				const afterSignalFailure = await verifyAfterSignal();
				return afterSignalFailure === "gone" ? { ok: true } : closeFailure(afterSignalFailure);
			}
			const afterTerm = await waitForHeadlessExit(proof, provider.verify, sleep);
			if (afterTerm === "gone") return { ok: true };
			if (afterTerm !== "verified") return closeFailure(afterTerm);
			if (!signalHeadless(proof.pid, proof.processIncarnation, platform, "SIGKILL")) {
				const afterSignalFailure = await verifyAfterSignal();
				return afterSignalFailure === "gone" ? { ok: true } : closeFailure(afterSignalFailure);
			}
			const afterKill = await waitForHeadlessExit(proof, provider.verify, sleep);
			return afterKill === "gone" ? { ok: true } : closeFailure(afterKill);
		},
	};
	return provider;
}
