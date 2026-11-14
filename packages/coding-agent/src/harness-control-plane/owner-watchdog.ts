import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import { resolveOwner } from "./owner";
import { sessionPaths } from "./storage";

export type OwnerWatchdogExitReason = "owner-lease-read-failed";

export interface OwnerGeneration {
	ownerId: string;
	leaseEpoch: number;
}

interface OwnerWatchdogEvidence extends OwnerGeneration {
	reason: OwnerWatchdogExitReason;
}

const DEFAULT_INTERVAL_MS = 500;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;

function evidencePath(root: string, sessionId: string, generation: OwnerGeneration): string {
	if (
		typeof generation.ownerId !== "string" ||
		generation.ownerId.length === 0 ||
		!Number.isSafeInteger(generation.leaseEpoch) ||
		generation.leaseEpoch < 0
	) {
		throw new TypeError("invalid_owner_generation");
	}
	const generationHash = createHash("sha256")
		.update(JSON.stringify([generation.ownerId, generation.leaseEpoch]))
		.digest("hex");
	return path.join(sessionPaths(root, sessionId).dir, `owner-watchdog-${generationHash}.json`);
}

async function persistExitReason(
	root: string,
	sessionId: string,
	generation: OwnerGeneration,
	reason: OwnerWatchdogExitReason,
): Promise<void> {
	const file = evidencePath(root, sessionId, generation);
	const directory = path.dirname(file);
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });

	const temporary = `${file}.tmp-${randomBytes(12).toString("hex")}`;
	let temporaryExists = true;
	try {
		const evidence: OwnerWatchdogEvidence = { ...generation, reason };
		await Bun.write(temporary, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
		const fileHandle = await fs.open(temporary, "r+");
		try {
			await fileHandle.sync();
		} finally {
			await fileHandle.close();
		}

		await fs.rename(temporary, file);
		temporaryExists = false;

		const directoryHandle = await fs.open(directory, "r");
		try {
			await directoryHandle.sync();
		} finally {
			await directoryHandle.close();
		}
	} finally {
		if (temporaryExists) await fs.rm(temporary, { force: true });
	}
}

/** Read the durable watchdog exit reason for this exact owner generation. */
export async function readOwnerWatchdogExit(
	root: string,
	sessionId: string,
	generation: OwnerGeneration,
): Promise<OwnerWatchdogExitReason | null> {
	const file = evidencePath(root, sessionId, generation);
	let raw: string;
	try {
		raw = await Bun.file(file).text();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}

	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		throw new Error("malformed_owner_watchdog_evidence", { cause: error });
	}
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		(value as Partial<OwnerWatchdogEvidence>).reason !== "owner-lease-read-failed" ||
		(value as Partial<OwnerWatchdogEvidence>).ownerId !== generation.ownerId ||
		(value as Partial<OwnerWatchdogEvidence>).leaseEpoch !== generation.leaseEpoch
	) {
		throw new Error("malformed_owner_watchdog_evidence");
	}
	return "owner-lease-read-failed";
}

/**
 * Poll owner liveness serially until it disappears, a signal arrives, or lease
 * reads fail repeatedly. Lease-read failure evidence is durable before return.
 */
export async function waitForOwnerShutdown(
	root: string,
	sessionId: string,
	generation: OwnerGeneration,
): Promise<OwnerWatchdogExitReason | null> {
	// Validate the generation before adding process-wide listeners.
	evidencePath(root, sessionId, generation);

	const completion = Promise.withResolvers<OwnerWatchdogExitReason | null>();
	let settled = false;
	let publicationStarted = false;
	let consecutiveFailures = 0;
	let timer: NodeJS.Timeout | undefined;

	const cleanup = (): void => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		process.off("SIGTERM", onSigterm);
		process.off("SIGINT", onSigint);
	};
	const finishResolve = (reason: OwnerWatchdogExitReason | null = null): void => {
		if (settled) return;
		settled = true;
		cleanup();
		completion.resolve(reason);
	};
	const finishReject = (error: unknown): void => {
		if (settled) return;
		settled = true;
		cleanup();
		completion.reject(error);
	};
	const onSignal = (): void => {
		if (publicationStarted) return;
		finishResolve();
	};
	const onSigterm = (): void => onSignal();
	const onSigint = (): void => onSignal();

	const schedulePoll = (): void => {
		if (settled) return;
		timer = setTimeout(() => {
			timer = undefined;
			void poll().catch(finishReject);
		}, DEFAULT_INTERVAL_MS);
		timer.unref?.();
	};
	const poll = async (): Promise<void> => {
		if (settled) return;
		try {
			const owner = await resolveOwner(root, sessionId);
			if (settled) return;
			if (!owner.live) {
				finishResolve();
				return;
			}
			consecutiveFailures = 0;
		} catch (error) {
			if (settled) return;
			consecutiveFailures++;
			logger.warn("Owner watchdog lease read failed", {
				error: error instanceof Error ? error.message : String(error),
				sessionId,
				attempt: consecutiveFailures,
				maxAttempts: DEFAULT_MAX_CONSECUTIVE_FAILURES,
			});
			if (consecutiveFailures >= DEFAULT_MAX_CONSECUTIVE_FAILURES) {
				// From this point the watchdog must finish durable evidence or reject;
				// neither signal may resolve it while persistence is in progress.
				publicationStarted = true;
				try {
					await persistExitReason(root, sessionId, generation, "owner-lease-read-failed");
					finishResolve("owner-lease-read-failed");
				} catch (persistError) {
					finishReject(persistError);
				}
				return;
			}
		}
		if (!settled) schedulePoll();
	};

	process.on("SIGTERM", onSigterm);
	process.on("SIGINT", onSigint);
	schedulePoll();
	return completion.promise;
}
