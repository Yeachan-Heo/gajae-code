import { type BigIntStats, constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { NativeExactFileIdentity } from "@gajae-code/natives";
import { daemonPaths, telegramDaemonOwnerMarkerPath } from "../../sdk/bus/daemon-paths";
import {
	BROKER_ARTIFACT_PATHS,
	CHAT_DAEMON_DIRECTORY,
	CHAT_DAEMON_FILES,
	DOCTOR_RESTART_CONTROL_FILE,
} from "../../sdk/service-artifact-paths";
import { doctorCheck } from "./checks";
import type { DoctorContext } from "./context";
import { type DoctorFileObservation, doctorErrno, doctorMapping, readDoctorFile } from "./files";
import { artifactTargetId, serviceTargetId } from "./ids";
import type { DoctorCheck } from "./types";

export const DOCTOR_SERVICES = ["broker", "telegram", "discord", "slack"] as const;
export type DoctorServiceKind = (typeof DOCTOR_SERVICES)[number];
export type DoctorArtifactSlot = "discovery" | "owner-lock" | "startup-marker";

export interface DoctorServicePaths {
	readonly state: string;
	readonly owner: string;
	readonly restartIntent: string;
	readonly directoryOwner?: string;
	readonly startupMarker?: string;
}

export interface DoctorDirectoryObservation {
	readonly status: "directory";
	readonly mode: number;
	readonly owner: number;
	readonly exactIdentity: NativeExactFileIdentity;
}
export type DoctorArtifactObservation = DoctorFileObservation | DoctorDirectoryObservation;

export interface DoctorServiceObservation {
	readonly service: DoctorServiceKind;
	readonly paths: DoctorServicePaths;
	readonly state: DoctorFileObservation;
	readonly owner: DoctorFileObservation;
	readonly restartIntent: DoctorFileObservation;
	readonly directoryOwner?: DoctorArtifactObservation;
	readonly startupMarker?: DoctorFileObservation;
	readonly ownerMarker?: { readonly path: string; readonly observation: DoctorFileObservation };
}

/** Only product-defined paths are addressable; record content never supplies a path. */
export function doctorServicePaths(agentDir: string, service: DoctorServiceKind): DoctorServicePaths {
	if (service === "broker")
		return {
			state: path.join(agentDir, BROKER_ARTIFACT_PATHS.discovery),
			owner: path.join(agentDir, BROKER_ARTIFACT_PATHS.ownerRecord),
			restartIntent: path.join(agentDir, BROKER_ARTIFACT_PATHS.restartIntent),
			directoryOwner: path.join(agentDir, BROKER_ARTIFACT_PATHS.ownerLock),
		};
	if (service === "telegram") {
		const paths = daemonPaths(agentDir);
		return {
			state: paths.state,
			owner: paths.lock,
			startupMarker: paths.steal,
			restartIntent: path.join(paths.dir, DOCTOR_RESTART_CONTROL_FILE),
		};
	}
	const directory = path.join(agentDir, CHAT_DAEMON_DIRECTORY, service);
	return {
		state: path.join(directory, CHAT_DAEMON_FILES.state),
		owner: path.join(directory, CHAT_DAEMON_FILES.ownerLock),
		restartIntent: path.join(directory, DOCTOR_RESTART_CONTROL_FILE),
	};
}

async function checkParents(root: string, file: string): Promise<DoctorFileObservation | undefined> {
	const relative = path.relative(root, file);
	if (relative === "" || path.isAbsolute(relative) || relative.split(path.sep).includes(".."))
		return { status: "unreadable", errno: "EINVAL" };
	let current = root;
	try {
		for (const component of ["", ...relative.split(path.sep).slice(0, -1)]) {
			if (component) current = path.join(current, component);
			const stat = await fs.lstat(current);
			if (stat.isSymbolicLink()) return { status: "symlink" };
			if (!stat.isDirectory()) return { status: "unreadable", errno: "ENOTDIR" };
		}
		return undefined;
	} catch (error) {
		const errno = doctorErrno(error);
		return { status: errno === "ENOENT" ? "missing" : "unreadable", errno };
	}
}

async function readServiceFile(root: string, file: string): Promise<DoctorFileObservation> {
	return (await checkParents(root, file)) ?? (await readDoctorFile(file, 128 * 1024));
}

function sameDirectory(left: BigIntStats, right: BigIntStats): boolean {
	return (
		right.isDirectory() &&
		!right.isSymbolicLink() &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mode === right.mode &&
		left.uid === right.uid &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

async function readServiceDirectory(root: string, directory: string): Promise<DoctorArtifactObservation> {
	const failure = await checkParents(root, directory);
	if (failure) return failure;
	let handle: fs.FileHandle | undefined;
	try {
		const before = await fs.lstat(directory, { bigint: true });
		if (before.isSymbolicLink()) return { status: "symlink" };
		if (!before.isDirectory()) return { status: "not_regular" };
		handle = await fs.open(
			directory,
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		const opened = await handle.stat({ bigint: true });
		const parent = await fs.lstat(path.dirname(directory), { bigint: true });
		const after = await handle.stat({ bigint: true });
		const lexical = await fs.lstat(directory, { bigint: true });
		const parentAfter = await fs.lstat(path.dirname(directory), { bigint: true });
		if (
			!sameDirectory(before, opened) ||
			!sameDirectory(opened, after) ||
			!sameDirectory(after, lexical) ||
			parent.isSymbolicLink() ||
			parentAfter.isSymbolicLink() ||
			!parent.isDirectory() ||
			parent.dev !== parentAfter.dev ||
			parent.ino !== parentAfter.ino
		)
			return { status: "changed" };
		return {
			status: "directory",
			mode: Number(after.mode),
			owner: Number(after.uid),
			exactIdentity: {
				dev: after.dev,
				ino: after.ino,
				nlink: after.nlink,
				size: after.size,
				mtimeNs: after.mtimeNs,
				parentDev: parent.dev,
				parentIno: parent.ino,
				directory: true,
				detachOnly: true,
			},
		};
	} catch (error) {
		const errno = doctorErrno(error);
		return { status: errno === "ENOENT" ? "missing" : "unreadable", errno };
	} finally {
		await handle?.close();
	}
}

export function parseServiceRecord(observation: DoctorFileObservation): Record<string, unknown> | undefined {
	if (observation.status !== "read") return undefined;
	try {
		return doctorMapping(JSON.parse(observation.text));
	} catch {
		return undefined;
	}
}

export async function readDoctorService(root: string, service: DoctorServiceKind): Promise<DoctorServiceObservation> {
	const paths = doctorServicePaths(root, service);
	const [state, owner, directoryOwner, startupMarker, restartIntent] = await Promise.all([
		readServiceFile(root, paths.state),
		readServiceFile(root, paths.owner),
		paths.directoryOwner ? readServiceDirectory(root, paths.directoryOwner) : undefined,
		paths.startupMarker ? readServiceFile(root, paths.startupMarker) : undefined,
		readServiceFile(root, paths.restartIntent),
	]);
	let ownerMarker: DoctorServiceObservation["ownerMarker"];
	if (service === "telegram") {
		const record = parseServiceRecord(state) ?? parseServiceRecord(owner);
		const acquisitionId = record?.acquisitionId;
		if (typeof acquisitionId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(acquisitionId)) {
			const marker = telegramDaemonOwnerMarkerPath(root, acquisitionId);
			ownerMarker = { path: marker, observation: await readServiceFile(root, marker) };
		}
	}
	return { service, paths, state, owner, directoryOwner, startupMarker, ownerMarker, restartIntent };
}

export function serviceArtifactObservation(
	service: DoctorServiceObservation,
	slot: DoctorArtifactSlot,
): DoctorArtifactObservation | undefined {
	if (slot === "discovery") return service.state;
	if (slot === "owner-lock") return service.directoryOwner ?? service.owner;
	return service.startupMarker;
}

/** Metadata only: no service import, connection, process probe, or ownership acquisition. */
export async function collectServiceTargets(context: DoctorContext): Promise<DoctorCheck[]> {
	const checks: DoctorCheck[] = [];
	for (const service of DOCTOR_SERVICES) {
		const observation = await readDoctorService(context.agentRoot.locator, service);
		const targetId = serviceTargetId(context.agentRoot.rootId, service);
		context.targets.set(targetId, { kind: "service", targetId, service, root: context.agentRoot, observation });
		for (const slot of ["discovery", "owner-lock", "startup-marker"] as const) {
			const artifactId = artifactTargetId(context.agentRoot.rootId, service, slot);
			context.targets.set(artifactId, {
				kind: "artifact",
				targetId: artifactId,
				service,
				slot,
				root: context.agentRoot,
				observation,
			});
			const artifact = serviceArtifactObservation(observation, slot);
			if (!artifact) continue;
			const present = artifact.status === "read" || artifact.status === "directory";
			const malformed = artifact.status === "read" && !parseServiceRecord(artifact);
			checks.push(
				doctorCheck(`service.${service}.${slot}`, artifactId, {
					execution: present || artifact.status === "missing" ? "completed" : "blocked",
					health: malformed
						? "error"
						: present
							? "ok"
							: artifact.status === "missing"
								? "not_applicable"
								: "unknown",
					evidenceLevel: "observed",
					reasonCode: malformed
						? "service_metadata_invalid"
						: present
							? "service_artifact_present"
							: `service_artifact_${artifact.status}`,
					evidence: {
						present,
						runtimeProbed: false,
						authenticationProbed: false,
						...(artifact.status === "directory" ? { fileKind: "directory", mode: artifact.mode & 0o777 } : {}),
						...("errno" in artifact ? { errno: artifact.errno } : {}),
					},
					remediationIds: present ? ["service.detach-owned-stale-artifact"] : [],
				}),
			);
		}
		checks.push(
			doctorCheck(`service.${service}.owner`, targetId, {
				execution:
					observation.state.status === "read" || observation.state.status === "missing" ? "completed" : "blocked",
				health:
					observation.state.status === "missing"
						? "not_applicable"
						: observation.state.status === "read"
							? "ok"
							: "unknown",
				evidenceLevel: "observed",
				reasonCode: "service_metadata_only",
				evidence: {
					present: observation.state.status === "read",
					runtimeProbed: false,
					authenticationProbed: false,
				},
				remediationIds: observation.state.status === "read" ? ["service.restart-owned"] : [],
			}),
		);
	}
	return checks;
}
