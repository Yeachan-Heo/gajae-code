#!/usr/bin/env bun
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";

export const ISSUE_1938_EXPECTED_VERDICT_DEADLINE_MS = 2_000;
export const ISSUE_1938_RECOVERY_VERDICT_DEADLINE_MS = 7_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export interface CanonicalVerdictBaseline { generation: string | null; verdictFileId: string | null; incidentFileId: string | null; incidentAliasFileId: string | null; vanishedFileId: string | null; vanishedAliasFileId: string | null; }
export interface CanonicalVerdictWaitInput { stateDir: string; sessionId: string; classification: "expected_operator_shutdown" | "unexpected_owner_loss"; requireIncident: boolean; triggerStartedAtMs: number; deadlineAtMs: number; pollMs: number; baseline?: CanonicalVerdictBaseline; }
export interface CanonicalVerdictWaitResult { dedupeKey: string; signal: string; result: string; latencyMs: number; artifact?: CanonicalArtifact; }
export interface CanonicalArtifact { record: Record<string, unknown>; fileId: string; publishedAtMs: number; }
export interface CanonicalVerdictWaitDependencies { nowMs(): number; sleep(ms: number): Promise<void>; probe(input: CanonicalVerdictWaitInput): Promise<Omit<CanonicalVerdictWaitResult, "latencyMs"> | null>; }

export class CanonicalStateError extends Error { constructor() { super("canonical state invalid"); } }
type ReadJson = { kind: "missing" } | { kind: "value"; value: Record<string, unknown> };
function stateError(): never { throw new CanonicalStateError(); }
function strictTimestamp(value: unknown): boolean {
	if (typeof value !== "string" || !RFC3339.test(value)) return false;
	const parsed = Date.parse(value);
	if (Number.isNaN(parsed)) return false;
	return new Date(parsed).toISOString() === (value.includes(".") ? value : value.replace("Z", ".000Z"));
}
async function readJson(file: string): Promise<ReadJson> {
	let body: string;
	try { body = await fs.readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" }; return stateError(); }
	try { const value: unknown = JSON.parse(body); return value !== null && typeof value === "object" && !Array.isArray(value) ? { kind: "value", value: value as Record<string, unknown> } : stateError(); } catch { return stateError(); }
}
async function fileIdentity(file: string): Promise<{ id: string; mtimeMs: number } | null> {
	try { const stat = await fs.stat(file); return { id: `${stat.dev}:${stat.ino}:${stat.size}:${Math.floor(stat.mtimeMs)}`, mtimeMs: Math.floor(stat.mtimeMs) }; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; return stateError(); }
}
function same(a: Record<string, unknown>, b: Record<string, unknown>, fields: string[]): boolean { return fields.every(field => a[field] === b[field]); }
function validGeneration(value: Record<string, unknown>, sessionId: string): string | null { const generation = value.generation; return value.schema_version === 1 && value.session_id === sessionId && typeof generation === "string" && UUID.test(generation) ? generation : null; }
function safeRecord(verdict: Record<string, unknown>): Record<string, unknown> { const fields = ["schema_version", "generation", "session_id", "classification", "dedupe_key", "signal", "result", "observed_at"]; return Object.fromEntries(fields.map(field => [field, verdict[field]])); }
function fresh(identity: { id: string; mtimeMs: number }, baselineId: string | null, baselineGeneration: string | null, generation: string, triggerStartedAtMs: number): boolean { return identity.mtimeMs > triggerStartedAtMs || (baselineGeneration === generation && baselineId !== null && baselineId !== identity.id); }
async function canonicalGeneration(root: string, sessionId: string): Promise<string | null> { const generation = await readJson(path.join(root, "generation.json")); if (generation.kind === "missing") return null; return validGeneration(generation.value, sessionId) ?? stateError(); }

export async function captureCanonicalVerdictBaseline(stateDir: string, sessionId: string): Promise<CanonicalVerdictBaseline> {
	const root = path.join(stateDir, sessionId, "owner-lifecycle"), generation = await canonicalGeneration(root, sessionId);
	if (!generation) return { generation: null, verdictFileId: null, incidentFileId: null, incidentAliasFileId: null, vanishedFileId: null, vanishedAliasFileId: null };
	const [verdict, incident, incidentAlias, vanished, vanishedAlias] = await Promise.all([fileIdentity(path.join(root, `verdict-${generation}.json`)), fileIdentity(path.join(root, `incident-${generation}.json`)), fileIdentity(path.join(stateDir, "incident.json")), fileIdentity(path.join(root, `vanished-${generation}.json`)), fileIdentity(path.join(stateDir, "vanished.json"))]);
	return { generation, verdictFileId: verdict?.id ?? null, incidentFileId: incident?.id ?? null, incidentAliasFileId: incidentAlias?.id ?? null, vanishedFileId: vanished?.id ?? null, vanishedAliasFileId: vanishedAlias?.id ?? null };
}

export async function probeCanonicalVerdict(input: CanonicalVerdictWaitInput): Promise<Omit<CanonicalVerdictWaitResult, "latencyMs"> | null> {
	const root = path.join(input.stateDir, input.sessionId, "owner-lifecycle"), generation = await canonicalGeneration(root, input.sessionId);
	if (!generation) return null;
	const baseline = input.baseline ?? { generation: null, verdictFileId: null, incidentFileId: null, incidentAliasFileId: null, vanishedFileId: null, vanishedAliasFileId: null };
	const verdictPath = path.join(root, `verdict-${generation}.json`), canonicalRead = await readJson(verdictPath), identity = await fileIdentity(verdictPath), aliasRead = await readJson(path.join(input.stateDir, "verdict.json"));
	if (canonicalRead.kind === "missing" || !identity || aliasRead.kind === "missing") return null;
	const canonical = canonicalRead.value, alias = aliasRead.value, dedupeKey = `owner-loss:${input.sessionId}:${generation}`, verdictFields = ["schema_version", "session_id", "classification", "dedupe_key", "signal", "result"];
	if (!fresh(identity, baseline.verdictFileId, baseline.generation, generation, input.triggerStartedAtMs)) return null;
	if (canonical.schema_version !== 1 || canonical.generation !== generation || canonical.session_id !== input.sessionId || canonical.classification !== input.classification || canonical.dedupe_key !== dedupeKey || typeof canonical.signal !== "string" || typeof canonical.result !== "string" || !strictTimestamp(canonical.observed_at) || alias.owner_generation !== generation || !same(canonical, alias, verdictFields)) return stateError();
	if (
		input.classification === "expected_operator_shutdown" &&
		(canonical.signal !== "SIGTERM" || canonical.result !== "owner_term_then_session_cleanup")
	)
		return stateError();
	const verified = { dedupeKey, signal: canonical.signal, result: canonical.result, artifact: { record: safeRecord(canonical), fileId: identity.id, publishedAtMs: identity.mtimeMs } };
	if (!input.requireIncident) return verified;
	const incidentPath = path.join(root, `incident-${generation}.json`), incidentAliasPath = path.join(input.stateDir, "incident.json"), vanishedPath = path.join(root, `vanished-${generation}.json`), vanishedAliasPath = path.join(input.stateDir, "vanished.json");
	const [incidentRead, incidentAliasRead, vanishedRead, vanishedAliasRead, incidentIdentity, incidentAliasIdentity, vanishedIdentity, vanishedAliasIdentity] = await Promise.all([readJson(incidentPath), readJson(incidentAliasPath), readJson(vanishedPath), readJson(vanishedAliasPath), fileIdentity(incidentPath), fileIdentity(incidentAliasPath), fileIdentity(vanishedPath), fileIdentity(vanishedAliasPath)]);
	if (incidentRead.kind === "missing" || incidentAliasRead.kind === "missing" || vanishedRead.kind === "missing" || vanishedAliasRead.kind === "missing" || !incidentIdentity || !incidentAliasIdentity || !vanishedIdentity || !vanishedAliasIdentity) return null;
	const incident = incidentRead.value, incidentAlias = incidentAliasRead.value, vanished = vanishedRead.value, vanishedAlias = vanishedAliasRead.value, fields = ["schema_version", "session_id", "classification", "dedupe_key"];
	if (!fresh(incidentIdentity, baseline.incidentFileId, baseline.generation, generation, input.triggerStartedAtMs) || !fresh(incidentAliasIdentity, baseline.incidentAliasFileId, baseline.generation, generation, input.triggerStartedAtMs) || !fresh(vanishedIdentity, baseline.vanishedFileId, baseline.generation, generation, input.triggerStartedAtMs) || !fresh(vanishedAliasIdentity, baseline.vanishedAliasFileId, baseline.generation, generation, input.triggerStartedAtMs)) return null;
	if (incident.schema_version !== 1 || incident.generation !== generation || incident.session_id !== input.sessionId || incident.classification !== "unexpected_owner_loss" || incident.dedupe_key !== dedupeKey || incidentAlias.owner_generation !== generation || !same(incident, incidentAlias, fields) || vanished.schema_version !== 1 || vanished.generation !== generation || vanished.session_id !== input.sessionId || vanished.dedupe_key !== dedupeKey || vanishedAlias.owner_generation !== generation || !same(vanished, vanishedAlias, ["schema_version", "session_id", "dedupe_key"])) return stateError();
	let names: string[];
	try { names = await fs.readdir(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; return stateError(); }
	const incidents = names.filter(name => /^incident-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/.test(name));
	return incidents.length === 1 && incidents[0] === `incident-${generation}.json` ? verified : stateError();
}
const defaultDependencies: CanonicalVerdictWaitDependencies = { nowMs: () => Date.now(), sleep: ms => Bun.sleep(ms), probe: probeCanonicalVerdict };
export async function waitForCanonicalVerdict(input: CanonicalVerdictWaitInput, dependencies: CanonicalVerdictWaitDependencies = defaultDependencies): Promise<CanonicalVerdictWaitResult | null> { while (true) { const verified = await dependencies.probe(input), now = dependencies.nowMs(); if (verified && now >= input.triggerStartedAtMs && now < input.deadlineAtMs) return { ...verified, latencyMs: now - input.triggerStartedAtMs }; if (now >= input.deadlineAtMs) return null; await dependencies.sleep(Math.min(input.pollMs, input.deadlineAtMs - now)); } }
async function publishArtifact(dir: string, name: string, result: CanonicalVerdictWaitResult): Promise<{ file: string; sha256: string }> { if (!result.artifact || !/^(expected_close_verdict|unexpected_incident_recovery)$/.test(name)) throw new Error("missing canonical artifact"); await fs.mkdir(dir, { recursive: true }); const file = `${name}.canonical.json`, output = path.join(dir, file), payload = JSON.stringify({ ...result.artifact.record, file_id: result.artifact.fileId, published_at_ms: result.artifact.publishedAtMs }) + "\n"; await fs.writeFile(output, payload, { mode: 0o600 }); return { file: `artifacts/${file}`, sha256: createHash("sha256").update(payload).digest("hex") }; }
function usage(): never { process.exit(2); }
async function main(argv: string[]): Promise<void> {
	const allowed = new Set(["--state-dir", "--session", "--classification", "--require-incident", "--trigger-start-ms", "--deadline-at-ms", "--poll-ms", "--artifact-dir", "--artifact-name", "--baseline-generation", "--baseline-verdict-id", "--baseline-incident-id", "--baseline-incident-alias-id", "--baseline-vanished-id", "--baseline-vanished-alias-id"]), values = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 2) { const key = argv[i], value = argv[i + 1]; if (!key?.startsWith("--") || !allowed.has(key) || value === undefined || values.has(key)) usage(); values.set(key, value); }
	const stateDir = values.get("--state-dir"), sessionId = values.get("--session"), classification = values.get("--classification"), requireIncident = values.get("--require-incident"), triggerStartedAtMs = Number(values.get("--trigger-start-ms")), deadlineAtMs = Number(values.get("--deadline-at-ms")), pollMs = Number(values.get("--poll-ms")), artifactDir = values.get("--artifact-dir"), artifactName = values.get("--artifact-name"), baselineGeneration = values.get("--baseline-generation"), baselineValue = (name: string): string | null | undefined => { const value = values.get(name); return value === "_" ? null : value; }, baseline: CanonicalVerdictBaseline = { generation: baselineGeneration === "_" ? null : baselineGeneration ?? null, verdictFileId: baselineValue("--baseline-verdict-id") ?? null, incidentFileId: baselineValue("--baseline-incident-id") ?? null, incidentAliasFileId: baselineValue("--baseline-incident-alias-id") ?? null, vanishedFileId: baselineValue("--baseline-vanished-id") ?? null, vanishedAliasFileId: baselineValue("--baseline-vanished-alias-id") ?? null }, baselineFlags = ["--baseline-verdict-id", "--baseline-incident-id", "--baseline-incident-alias-id", "--baseline-vanished-id", "--baseline-vanished-alias-id"];
	if (!stateDir || !sessionId || !/^[A-Za-z0-9_.-]{1,128}$/.test(sessionId) || (classification !== "expected_operator_shutdown" && classification !== "unexpected_owner_loss") || (requireIncident !== "true" && requireIncident !== "false") || !Number.isSafeInteger(triggerStartedAtMs) || !Number.isSafeInteger(deadlineAtMs) || deadlineAtMs - triggerStartedAtMs < 100 || deadlineAtMs - triggerStartedAtMs > 30_000 || !Number.isSafeInteger(pollMs) || pollMs < 10 || pollMs > 1000 || !artifactDir || !artifactName || baselineGeneration === undefined || baselineFlags.some(flag => values.get(flag) === undefined) || (baseline.generation !== null && !UUID.test(baseline.generation))) usage();
	try { const result = await waitForCanonicalVerdict({ stateDir, sessionId, classification, requireIncident: requireIncident === "true", triggerStartedAtMs, deadlineAtMs, pollMs, baseline }); if (!result) process.exit(1); const artifact = await publishArtifact(artifactDir, artifactName, result); process.stdout.write(`${JSON.stringify({ dedupe_key: result.dedupeKey, signal: result.signal, result: result.result, latency_ms: result.latencyMs, artifact })}\n`); } catch (error) { if (error instanceof CanonicalStateError) { console.error("canonical state invalid"); process.exit(1); } throw error; }
}
if (import.meta.main) await main(Bun.argv.slice(2));
