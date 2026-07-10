#!/usr/bin/env bun
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { ISSUE_1938_EXPECTED_VERDICT_DEADLINE_MS, ISSUE_1938_RECOVERY_VERDICT_DEADLINE_MS } from "./wait-for-issue-1938-verdict";

const rootKeys = ["schema_version", "issue", "phase", "status", "generated_at", "source_revision", "run_nonce", "capabilities", "cases", "cleanup"];
const capabilityKeys = ["linux", "proc", "systemctl_user", "systemd_run_user", "python3", "script", "tmux", "git", "bun", "disposable_unit"];
const caseKeys = ["id", "status", "started_at", "completed_at", "subject", "expected", "observed", "scope", "verdict", "dedupe_key", "artifact"];
const caseIds = new Set(["inherited_baseline_death", "manual_scope_survival_direct_term", "raw_proof_before_exec", "managed_proof_before_exec", "isolated_survival", "expected_close_verdict", "unexpected_incident_recovery"]);
const requiredCases = { "pre-code": ["inherited_baseline_death", "manual_scope_survival_direct_term"], "post-code": ["raw_proof_before_exec", "managed_proof_before_exec", "isolated_survival", "expected_close_verdict", "unexpected_incident_recovery"] } as const;
const privateField = /(?:pane|prompt|payload|content|command|argv|environment|config|worktree|log|output|text|line|token|secret|credential|message)/i;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const revision = /^[0-9a-f]{40}$/;
const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const artifactKeys = ["schema_version", "generation", "session_id", "classification", "dedupe_key", "signal", "result", "observed_at", "file_id", "published_at_ms"];
const artifactFileId = /^\d{1,20}:\d{1,20}:\d{1,20}:\d{1,20}$/;
const MAX_SIGNAL_LENGTH = 64;
const MAX_RESULT_LENGTH = 128;
const MAX_SUBJECT_NAME_LENGTH = 256;
const MAX_CGROUP_LENGTH = 1024;
const MAX_CASE_STRING_LENGTH = 256;
const MAX_VERDICT_LENGTH = 128;
const MAX_LATENCY_MS = 6_999;
/**
 * Passed-evidence semantics shared by the executable validator and the published schema.
 * Conformance tests keep both representations aligned.
 */
export const ISSUE_1938_SCHEMA_CONFORMANCE_REQUIREMENTS = [
	"passed requires non-null source_revision and run_nonce, every capability true, and cleanup.status completed with completed_at",
	"passed pre-code and post-code receipts require exactly their phase-specific passed case IDs with the executable signal/result, scope, dedupe_key, artifact, and strict latency semantics",
	"post-code verdict artifacts require exact public keys schema_version,generation,session_id,classification,dedupe_key,signal,result,observed_at,file_id,published_at_ms; no additional properties; bounded values",
] as const;


function validDedupeKey(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const match = /^owner-loss:[A-Za-z0-9_.-]{1,128}:(.+)$/.exec(value);
	return match !== null && uuid.test(match[1]);
}
export interface EvidenceValidationContext { phase: "pre-code" | "post-code"; sourceRevision: string; runNonce: string; receiptPath?: string; nowMs?: number; maxAgeMs?: number; }
function fail(message: string): never { throw new Error(`Invalid issue #1938 evidence: ${message}`); }
function object(value: unknown, label: string): Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`); return value as Record<string, unknown>; }
function keys(value: Record<string, unknown>, allowed: readonly string[], label: string, required = allowed): void { for (const key of Object.keys(value)) { if (!allowed.includes(key)) fail(`${label}.${key} is not allowlisted`); if (privateField.test(key)) fail(`${label}.${key} is a forbidden private-payload field`); } for (const key of required) if (!(key in value)) fail(`${label}.${key} is required`); }
function publicArtifactValue(value: unknown, label: string, depth = 0): void {
	if (depth > 4) fail(`${label} is too deeply nested`);
	if (typeof value === "string") { if (value.length > 256) fail(`${label} exceeds the public value limit`); return; }
	if (value === null || typeof value === "boolean") return;
	if (typeof value === "number") { if (!Number.isSafeInteger(value) || Math.abs(value) > 9_999_999_999_999) fail(`${label} is not a bounded public number`); return; }
	if (Array.isArray(value)) { if (value.length > 16) fail(`${label} has too many values`); value.forEach((entry, index) => publicArtifactValue(entry, `${label}[${index}]`, depth + 1)); return; }
	const record = object(value, label);
	for (const [key, entry] of Object.entries(record)) { if (privateField.test(key)) fail(`${label}.${key} is a forbidden private-payload field`); publicArtifactValue(entry, `${label}.${key}`, depth + 1); }
}

function time(value: unknown, label: string, nullable = false): number | null { if (nullable && value === null) return null; if (typeof value !== "string" || !rfc3339.test(value) || Number.isNaN(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== (value.includes(".") ? value : value.replace("Z", ".000Z"))) fail(`${label} must be a strict RFC3339 timestamp`); return Date.parse(value); }
function result(value: unknown, label: string, latency: boolean): Record<string, unknown> {
	const r = object(value, label);
	keys(r, latency ? ["signal", "result", "latency_ms"] : ["signal", "result"], label, ["signal", "result"]);
	if (
		!(typeof r.signal === "string" || r.signal === null) ||
		(typeof r.signal === "string" && r.signal.length > MAX_SIGNAL_LENGTH) ||
		typeof r.result !== "string" ||
		r.result.length > MAX_RESULT_LENGTH
	)
		fail(`${label} is invalid`);
	if (
		"latency_ms" in r &&
		(!latency || !Number.isSafeInteger(r.latency_ms) || (r.latency_ms as number) < 0 || (r.latency_ms as number) > MAX_LATENCY_MS)
	)
		fail(`${label}.latency_ms is invalid`);
	return r;
}
function validateCase(value: unknown, index: number): void {
	const label = `cases[${index}]`;
	const r = object(value, label);
	keys(r, caseKeys, label, caseKeys.slice(0, 7));
	if (typeof r.id !== "string" || !caseIds.has(r.id) || !["passed", "failed", "skipped"].includes(String(r.status)))
		fail(`${label} is invalid`);
	const started = time(r.started_at, `${label}.started_at`)!;
	const completed = time(r.completed_at, `${label}.completed_at`)!;
	if (completed < started) fail(`${label} timestamps are unordered`);
	const s = object(r.subject, `${label}.subject`);
	keys(s, ["pid", "name", "cgroup"], `${label}.subject`);
	if (!(Number.isInteger(s.pid) && (s.pid as number) > 0) && s.pid !== null) fail(`${label}.subject.pid is invalid`);
	if (
		typeof s.name !== "string" ||
		s.name.length > MAX_SUBJECT_NAME_LENGTH ||
		!(typeof s.cgroup === "string" || s.cgroup === null) ||
		(typeof s.cgroup === "string" && s.cgroup.length > MAX_CGROUP_LENGTH)
	)
		fail(`${label}.subject is invalid`);
	result(r.expected, `${label}.expected`, false);
	result(r.observed, `${label}.observed`, true);
	for (const field of ["scope", "verdict", "dedupe_key"] as const) {
		if (!(field in r)) continue;
		if (typeof r[field] !== "string") fail(`${label}.${field} must be a string`);
		const limit = field === "verdict" ? MAX_VERDICT_LENGTH : MAX_CASE_STRING_LENGTH;
		if ((r[field] as string).length > limit) fail(`${label}.${field} exceeds the public value limit`);
	}
	if ("artifact" in r) {
		const artifact = object(r.artifact, `${label}.artifact`);
		keys(artifact, ["path", "sha256"], `${label}.artifact`);
		if (
			typeof artifact.path !== "string" ||
			!/^artifacts\/(?:expected_close_verdict|unexpected_incident_recovery)\.canonical\.json$/.test(artifact.path) ||
			typeof artifact.sha256 !== "string" ||
			!/^[0-9a-f]{64}$/.test(artifact.sha256)
		)
			fail(`${label}.artifact is invalid`);
	}
}
function semantic(record: Record<string, unknown>): void { const id = record.id as string, expected = result(record.expected, `${id}.expected`, false), observed = result(record.observed, `${id}.observed`, true); const contract: Record<string, readonly [string | null, string, string | null, string]> = { inherited_baseline_death: ["SIGTERM", "restart", "SIGTERM", "exited"], manual_scope_survival_direct_term: ["SIGTERM", "survives_then_exits", "SIGTERM", "survives_then_exits"], raw_proof_before_exec: [null, "proven", null, "proven"], managed_proof_before_exec: [null, "proven", null, "proven"], isolated_survival: ["SIGTERM", "survives", null, "survives"], expected_close_verdict: ["SIGTERM", "expected_operator_shutdown", "SIGTERM", "owner_term_then_session_cleanup"], unexpected_incident_recovery: ["SIGTERM", "unexpected_owner_loss", null, "unknown_terminal"] }; const [es, er, os, or] = contract[id]; const observedSignalValid = id === "unexpected_incident_recovery" ? ["SIGTERM", "SIGINT", "SIGHUP", "UNKNOWN"].includes(String(observed.signal)) : observed.signal === os; if (expected.signal !== es || expected.result !== er || !observedSignalValid || observed.result !== or) fail(`${id} has contradictory signal/result semantics`); if (["raw_proof_before_exec", "managed_proof_before_exec", "isolated_survival"].includes(id) && (typeof record.scope !== "string" || !/^gjc-owner-[A-Za-z0-9-]+\.scope$/.test(record.scope))) fail(`${id} must record its owner scope`); if (["expected_close_verdict", "unexpected_incident_recovery"].includes(id) && (record.verdict !== er || !("artifact" in record))) fail(`${id} must record its matching verdict and artifact`); }
function passedCases(root: Record<string, unknown>): Map<string, Record<string, unknown>> {
	const phase = root.phase as keyof typeof requiredCases;
	const required = requiredCases[phase];
	const cases = root.cases as Record<string, unknown>[];
	if (cases.length !== required.length) fail(`${phase} passed evidence must contain exactly the required cases`);
	const records = new Map<string, Record<string, unknown>>();
	for (const record of cases) {
		const id = record.id as string;
		if (!required.includes(id as never) || records.has(id)) fail(`${phase} passed evidence has invalid case identity`);
		if (record.status !== "passed") fail(`${phase} ${id} must pass`);
		const verdictCase = id === "expected_close_verdict" || id === "unexpected_incident_recovery";
		if (verdictCase ? !validDedupeKey(record.dedupe_key) : "dedupe_key" in record) {
			fail(`${phase} ${id}.dedupe_key is invalid`);
		}
		semantic(record);
		records.set(id, record);
	}
	return records;
}
async function validateArtifact(receiptPath: string, record: Record<string, unknown>): Promise<void> { const artifact = object(record.artifact, `${record.id}.artifact`), relative = artifact.path as string, receiptDir = path.dirname(receiptPath), target = path.resolve(receiptDir, relative); if (!target.startsWith(`${path.resolve(receiptDir, "artifacts")}${path.sep}`)) fail(`${record.id} artifact escapes receipt directory`); let bytes: Buffer; try { bytes = await fs.readFile(target); } catch (error) { const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : "UNKNOWN"; if (code === "ENOENT") fail(`${record.id} artifact is missing`); fail(`${record.id} artifact read failed (${code})`); } if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) fail(`${record.id} artifact digest mismatch`); let body: string; try { body = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail(`${record.id} artifact is not valid UTF-8`); } let saved: Record<string, unknown>; try { saved = object(JSON.parse(body), `${record.id} artifact`); } catch { fail(`${record.id} artifact is not valid JSON`); } keys(saved, artifactKeys, `${record.id} artifact`); publicArtifactValue(saved, `${record.id} artifact`); const observed = result(record.observed, `${record.id}.observed`, true), subject = object(record.subject, `${record.id}.subject`), generation = typeof record.dedupe_key === "string" ? record.dedupe_key.split(":").at(-1) : null, observedAt = time(saved.observed_at, `${record.id} artifact.observed_at`)!, startedAt = time(record.started_at, `${record.id}.started_at`)!, completedAt = time(record.completed_at, `${record.id}.completed_at`)!; if (saved.schema_version !== 1 || !uuid.test(String(saved.generation)) || saved.session_id !== subject.name || saved.generation !== generation || !["expected_operator_shutdown", "unexpected_owner_loss"].includes(String(saved.classification)) || saved.classification !== record.verdict || !validDedupeKey(saved.dedupe_key) || saved.dedupe_key !== record.dedupe_key || typeof saved.signal !== "string" || saved.signal !== observed.signal || typeof saved.result !== "string" || saved.result !== observed.result || observedAt < startedAt || observedAt > completedAt || typeof saved.file_id !== "string" || !artifactFileId.test(saved.file_id) || !Number.isSafeInteger(saved.published_at_ms) || (saved.published_at_ms as number) < 0 || (saved.published_at_ms as number) > 9_999_999_999_999) fail(`${record.id} artifact does not bind the case`); }
export async function validateEvidence(value: unknown, suppliedContext?: EvidenceValidationContext | "pre-code" | "post-code"): Promise<void> { const input = object(value, "root"), explicitContext = typeof suppliedContext === "object"; const context: EvidenceValidationContext = explicitContext ? suppliedContext : { phase: suppliedContext ?? input.phase as "pre-code" | "post-code", sourceRevision: "", runNonce: "", nowMs: Date.parse(String(input.generated_at)) }; const root = input; keys(root, rootKeys, "root"); if (root.schema_version !== 1 || root.issue !== "1938" || root.phase !== context.phase) fail("schema_version, issue, or file name phase is invalid"); if (!["passed", "failed", "unsupported"].includes(String(root.status))) fail("status is invalid"); const generated = time(root.generated_at, "generated_at")!; if (!(typeof root.source_revision === "string" || root.source_revision === null) || !(typeof root.run_nonce === "string" || root.run_nonce === null) || (root.source_revision !== null && !revision.test(root.source_revision)) || (root.run_nonce !== null && !uuid.test(root.run_nonce))) fail("source revision or run nonce is invalid"); if (explicitContext && (!revision.test(context.sourceRevision) || !uuid.test(context.runNonce))) fail("expected source revision or run nonce is invalid"); const caps = object(root.capabilities, "capabilities"); keys(caps, capabilityKeys, "capabilities"); for (const key of capabilityKeys) if (typeof caps[key] !== "boolean") fail(`capabilities.${key} must be boolean`); if (!Array.isArray(root.cases)) fail("cases must be an array"); root.cases.forEach(validateCase); const cleanup = object(root.cleanup, "cleanup"); keys(cleanup, ["status", "unit", "scope", "completed_at"], "cleanup"); if (!["not_started", "completed", "failed"].includes(String(cleanup.status))) fail("cleanup.status is invalid"); const cleaned = time(cleanup.completed_at, "cleanup.completed_at", true); if (!(cleanup.unit === null || typeof cleanup.unit === "string" && /^gjc-issue1938-[A-Za-z0-9_.-]+\.service$/.test(cleanup.unit)) || !(cleanup.scope === null || typeof cleanup.scope === "string" && /^gjc-(?:issue1938|owner)-[A-Za-z0-9_.-]+\.scope$/.test(cleanup.scope))) fail("cleanup unit/scope is invalid"); const prerequisiteCapabilities = capabilityKeys.filter(key => key !== "disposable_unit"); if (root.status === "unsupported" && (root.cases.length || cleanup.status !== "not_started" || caps.disposable_unit !== false || prerequisiteCapabilities.every(key => caps[key] === true) || root.source_revision !== null || root.run_nonce !== null)) fail("unsupported evidence must have no cases, disabled disposable capability, and a missing capability"); if (root.status !== "passed") return; if (!explicitContext) fail("passed evidence requires explicit expected source revision and run nonce context"); if (root.source_revision !== context.sourceRevision || root.run_nonce !== context.runNonce) fail("passed evidence does not bind the expected source revision and run nonce"); if (cleanup.status !== "completed" || cleaned === null) fail("passed cleanup must be completed"); const now = context.nowMs ?? Date.now(), maxAge = context.maxAgeMs ?? 15 * 60_000; if (generated > now || now - generated > maxAge) fail("generated_at is not fresh"); for (const record of root.cases as Record<string, unknown>[]) if (time(record.completed_at, "case.completed_at")! > cleaned || cleaned > generated) fail("case, cleanup, and generated timestamps are unordered"); if (!prerequisiteCapabilities.every(key => caps[key] === true) || caps.disposable_unit !== true) fail("passed evidence requires every prerequisite capability"); const passed = passedCases(root); if (root.phase === "post-code") { if (!context.receiptPath) fail("passed post-code evidence requires a receipt path"); for (const [id, deadline] of [["expected_close_verdict", ISSUE_1938_EXPECTED_VERDICT_DEADLINE_MS], ["unexpected_incident_recovery", ISSUE_1938_RECOVERY_VERDICT_DEADLINE_MS]] as const) { const record = passed.get(id)!, latency = result(record.observed, `${id}.observed`, true).latency_ms; if (!Number.isSafeInteger(latency) || (latency as number) >= deadline) fail(`${id} must record strictly bounded latency_ms`); await validateArtifact(context.receiptPath, record); } } }
if (import.meta.main) { const [file, sourceRevision, runNonce] = Bun.argv.slice(2); if (!file || !sourceRevision || !runNonce || Bun.argv.length !== 5) { console.error("Usage: bun scripts/gjc-session/validate-issue-1938-evidence.ts <evidence.json> <source-revision> <run-nonce>"); process.exit(2); } const phase = path.basename(file, ".json"); try { if (phase !== "pre-code" && phase !== "post-code" || !path.resolve(file).endsWith(path.join("runtime", "evidence", "issue-1938", `${phase}.json`))) fail("file must be a phase receipt in runtime/evidence/issue-1938"); await validateEvidence(JSON.parse(await Bun.file(file).text()), { phase, sourceRevision, runNonce, receiptPath: file }); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); } }