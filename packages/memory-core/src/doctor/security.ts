import type { MemoryEnvironment } from "../env";
import { invalidInput, MEMORY_EXIT_CODES, type MemoryResult } from "../errors";
import { scanSecretContent } from "../policy/secret-scan";
import type { DoctorContext, DoctorFile, DoctorFinding, DoctorMetadata } from "./report";
import { finding, normalizeRelPath, okFindings } from "./report";
import { documentRecords } from "./structural";

const DEFAULT_MAX_BYTES = 1_048_576;
const PRIVATE_PERMISSION_MASK = 0o077n;

function policyDenied(reason: string): MemoryResult<never> {
	return {
		ok: false,
		error: {
			code: "policy-denied",
			exitCode: MEMORY_EXIT_CODES.policyDenied,
			destination: "doctor-report",
			reason,
		},
	};
}

function metadataFor(file: DoctorFile): DoctorMetadata {
	return file.metadata ?? file.parsed?.metadata ?? {};
}

function numeric(value: number | bigint | undefined): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "bigint")
		return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : Number.MAX_SAFE_INTEGER;
	return null;
}

function privateMemory(file: DoctorFile, metadata: DoctorMetadata): boolean {
	if (file.privateMemory === true) return true;
	if (metadata.sensitivity === "private" || metadata.sensitivity === "restricted") return true;
	const relPath = normalizeRelPath(file.relPath) ?? "";
	return relPath.startsWith("projects/") || relPath.startsWith("sessions/");
}

function worldReadable(file: DoctorFile, metadata: DoctorMetadata): boolean {
	if (!privateMemory(file, metadata) || file.mode === undefined) return false;
	const mode = typeof file.mode === "bigint" ? file.mode : BigInt(Math.max(0, Math.trunc(file.mode)));
	return (mode & PRIVATE_PERMISSION_MASK) !== 0n;
}

function unsafeBinary(file: DoctorFile): boolean {
	if (file.binary === true) return true;
	if (typeof file.content !== "string") return false;
	for (const character of file.content) {
		const code = character.codePointAt(0) ?? 0;
		if (code === 0 || (code < 0x09 && code !== 0x00) || (code >= 0x0e && code < 0x20)) return true;
	}
	return file.content.includes("\ufffd");
}

function rawTranscript(file: DoctorFile): boolean {
	const relPath = normalizeRelPath(file.relPath);
	if (relPath === null) return false;
	return relPath.split("/").some(part => {
		const lower = part.toLowerCase();
		return (
			lower.includes("transcript") ||
			lower.includes("tool-dump") ||
			lower.includes("tool_dump") ||
			lower.includes("tool-output")
		);
	});
}

function securityFindings(context: DoctorContext): DoctorFinding[] {
	const findings: DoctorFinding[] = [];
	const files = context.files ?? documentRecords(context).map(document => document as DoctorFile);
	for (const file of files) {
		const relPath = normalizeRelPath(file.relPath);
		if (relPath === null) {
			findings.push(
				finding("security.path-traversal", "error", null, "file path contains traversal or an absolute component"),
			);
			continue;
		}
		if (file.kind === "symlink") {
			findings.push(
				finding("security.symlink-escape", "error", relPath, "symlinked memory entry is outside the admitted root"),
			);
			continue;
		}
		const metadata = metadataFor(file);
		if (worldReadable(file, metadata)) {
			findings.push(
				finding(
					"security.world-readable",
					"error",
					relPath,
					"private memory permissions are wider than the policy allows",
				),
			);
		}
		if (rawTranscript(file)) {
			findings.push(
				finding(
					"security.raw-transcript",
					"error",
					relPath,
					"raw transcript or tool output is present in the memory store",
				),
			);
		}
		const size = numeric(file.size);
		const maxBytes =
			context.maxBytes !== undefined && Number.isSafeInteger(context.maxBytes) && context.maxBytes > 0
				? context.maxBytes
				: DEFAULT_MAX_BYTES;
		if (size !== null && size > maxBytes) {
			findings.push(finding("security.oversized", "error", relPath, "memory file exceeds the admitted size limit"));
		}
		if (unsafeBinary(file)) {
			findings.push(finding("security.binary", "error", relPath, "memory file is not valid text"));
		}
		if (file.secretLines !== undefined) {
			for (const line of file.secretLines) {
				findings.push(finding("security.secret", "error", relPath, `secret pattern detected at line ${line}`));
			}
		} else if (typeof file.content === "string") {
			const scanned = scanSecretContent(file.content);
			if (scanned.ok) {
				for (const secret of scanned.value.findings) {
					findings.push(
						finding("security.secret", "error", relPath, `secret pattern detected at line ${secret.line}`),
					);
				}
			}
		}
	}
	for (const directory of context.directories ?? []) {
		const relPath = normalizeRelPath(directory.relPath);
		if (relPath === null) {
			findings.push(
				finding(
					"security.path-traversal",
					"error",
					null,
					"directory path contains traversal or an absolute component",
				),
			);
			continue;
		}
		if (directory.kind === "symlink") {
			findings.push(
				finding(
					"security.symlink-escape",
					"error",
					relPath,
					"symlinked memory directory is outside the admitted root",
				),
			);
			continue;
		}
		if (directory.mode !== undefined) {
			const mode =
				typeof directory.mode === "bigint" ? directory.mode : BigInt(Math.max(0, Math.trunc(directory.mode)));
			if (
				(mode & PRIVATE_PERMISSION_MASK) !== 0n &&
				(relPath.startsWith("projects/") || relPath.startsWith("sessions/"))
			)
				findings.push(
					finding(
						"security.world-readable",
						"error",
						relPath,
						"private memory directory permissions are wider than the policy allows",
					),
				);
		}
	}
	return findings;
}

/** Run security §28.3 checks over policy-admitted doctor inputs. */
export async function checkSecurity(
	environment: MemoryEnvironment,
	context: DoctorContext,
): Promise<MemoryResult<readonly DoctorFinding[]>> {
	try {
		if (environment === null || typeof environment !== "object") return invalidInput("memory environment is invalid");
		return okFindings(securityFindings(context));
	} catch {
		return policyDenied("security doctor checks failed closed");
	}
}
