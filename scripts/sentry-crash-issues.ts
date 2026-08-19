#!/usr/bin/env bun
/**
 * Report aggregated crash signatures from a Sentry project for maintainer triage.
 * This is read-only: filing is not implemented yet.
 *
 * This is a maintainer tool, not part of the shipped CLI. `gjc crash report`
 * deliberately files one signature at a time behind a per-invocation consent
 * boundary. This batch script only collects the upstream set and renders the
 * exact issue content that a future filing flow could use.
 *
 * Usage:
 *   bun scripts/sentry-crash-issues.ts [--limit N] [--org SLUG] [--project SLUG]
 *
 * `--repo` exists only to make the target explicit; it is pinned to the same
 * repository `gjc crash report` searches, because the shared marker is the
 * dedup contract and a marker filed anywhere else is invisible to it.
 *
 * Auth:
 *   SENTRY_AUTH_TOKEN (or SENTRY_DEVNOGARI_AUTH_TOKEN) for the Sentry read side.
 *   `gh` must already be authenticated for GitHub's read-only duplicate search.
 */
import { CRASH_ISSUE_MARKER_PREFIX } from "@gajae-code/utils";

import { fenceCrashText, sanitizeExternalCrashV1 } from "../packages/coding-agent/src/crash/sanitize";

const DEFAULT_REPO = "Yeachan-Heo/gajae-code";
const DEFAULT_ORG = "probe";
const DEFAULT_PROJECT = "gajae-code";
const SENTRY_API = "https://sentry.io/api/0";
const GH_TIMEOUT_MS = 20_000;
const FINGERPRINT = /^[0-9a-f]{32}$/;
const CRASH_MARKER_PATTERN = /gjc-crash-fp\.v1:(?:[0-9a-f]{32}|<hex>)(?![a-z0-9_])/gi;
/** Sentry paginates at 100; a triage batch larger than this wants a saved search, not a bigger flag. */
const MAX_LIMIT = 100;
const MAX_PERMALINK_PATH_LENGTH = 2048;
const MAX_ISSUE_BODY_BYTES = 48 * 1024;
const SENTRY_LEVELS = new Set(["fatal", "error", "warning", "info", "debug"]);

interface Options {
	help?: boolean;
	limit: number;
	org: string;
	project: string;
	repo: string;
}

interface SentryIssue {
	id: string;
	shortId: string;
	title: string;
	culprit: string;
	count: string;
	firstSeen: string;
	lastSeen: string;
	permalink: string;
	level: string;
}

interface TriageRow {
	fingerprint: string;
	sentry: SentryIssue;
	existingIssueUrl?: string;
}

export function parseArgs(argv: readonly string[]): Options | { error: string } {
	const options: Options = {
		help: false,
		limit: 25,
		org: DEFAULT_ORG,
		project: DEFAULT_PROJECT,
		repo: DEFAULT_REPO,
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") {
			options.help = true;
			continue;
		}

		const value = argv[index + 1];
		if (value === undefined || value.startsWith("--")) return { error: `Flag ${arg} requires a value.` };
		index++;
		if (arg === "--limit") {
			if (!/^[0-9]+$/.test(value)) return { error: `--limit must be an integer in 1..${MAX_LIMIT}.` };
			const parsed = Number(value);
			if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT)
				return { error: `--limit must be an integer in 1..${MAX_LIMIT}.` };
			options.limit = parsed;
			continue;
		}
		if (arg === "--org") options.org = value;
		else if (arg === "--project") options.project = value;
		else if (arg === "--repo") {
			// The cross-surface dedup contract only holds against one repository:
			// `checkForDuplicateIssue` in report.ts searches CRASH_REPORT_REPO and
			// nothing else, so a marker filed elsewhere is one the interactive flow
			// will never find. Allowing an arbitrary target would silently break the
			// guarantee this script exists to uphold.
			if (value !== DEFAULT_REPO) return { error: `--repo is pinned to ${DEFAULT_REPO}; got ${value}.` };
			options.repo = value;
		}
		else return { error: `Unknown flag ${arg}.` };
	}
	return options;
}

function sentryToken(): string | undefined {
	return Bun.env.SENTRY_AUTH_TOKEN ?? Bun.env.SENTRY_DEVNOGARI_AUTH_TOKEN;
}

/** Thrown for a Sentry response that was reached but refused. */
class SentryHttpError extends Error {
	readonly status: number;

	constructor(pathname: string, status: number) {
		super(`Sentry ${pathname} responded ${status}`);
		this.name = "SentryHttpError";
		this.status = status;
	}
}

async function sentryGet(pathname: string, token: string): Promise<unknown> {
	const response = await fetch(`${SENTRY_API}${pathname}`, {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
		signal: AbortSignal.timeout(GH_TIMEOUT_MS),
	});
	if (!response.ok) throw new SentryHttpError(pathname, response.status);
	return response.json();
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/**
 * Sanitize one crash-derived field for local rendering. The upstream relay
 * sanitized these fields on egress, but the `gjc.fingerprint` tag that gates
 * provenance here is stamped client-side with the public DSN key and is
 * therefore forgeable, so the egress contract is re-applied before anything
 * reaches a GitHub issue rather than assumed. A field the scanner cannot vouch
 * for is dropped to a fixed placeholder, never passed through.
 */
function sanitizeField(value: string, fallback: string): string {
	const verdict = sanitizeExternalCrashV1(value, 2048);
	return verdict.ok ? verdict.value : fallback;
}

/**
 * Render crash-derived text that will be interpolated into Markdown or a
 * terminal. Sanitizing secrets and controls alone is insufficient here:
 * Markdown delimiters and mentions can alter the surrounding document, and a
 * literal dedup marker must only be emitted by this script at its fixed sites.
 */
function renderCrashText(value: string, fallback: string): string {
	return fenceCrashText(sanitizeField(value, fallback).replace(CRASH_MARKER_PATTERN, "<marker removed>"));
}

const COARSE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHORT_ID = /^[\w.-]{1,32}$/;

/**
 * Ingestion-time validation of every Sentry field that reaches maintainer
 * output. Hostile upstream metadata must not be able to smuggle Markdown,
 * markers, mentions, terminal controls, URL userinfo, or unbounded content
 * into an issue body or terminal line via fields the crash-text renderer
 * never covered (count, dates, shortId, permalink). A row failing any bound
 * is dropped entirely (undefined), never partially repaired.
 */
export function toSentryIssue(raw: unknown): SentryIssue | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const record = raw as Record<string, unknown>;
	const shortId = asString(record.shortId);
	const id = asString(record.id);
	if (!shortId || !id || !SHORT_ID.test(shortId) || !/^\d{1,20}$/.test(id)) return undefined;
	const count = asString(record.count);
	if (count !== "" && !/^\d{1,12}$/.test(count)) return undefined;
	const firstSeen = asString(record.firstSeen).slice(0, 10);
	const lastSeen = asString(record.lastSeen).slice(0, 10);
	if ((firstSeen && !COARSE_DATE.test(firstSeen)) || (lastSeen && !COARSE_DATE.test(lastSeen))) return undefined;
	const permalinkRaw = asString(record.permalink);
	let permalink = "";
	if (permalinkRaw) {
		try {
			const url = new URL(permalinkRaw);
			if (url.protocol !== "https:" || !/^[\w.-]+\.sentry\.io$/i.test(url.hostname)) return undefined;
			url.search = "";
			url.hash = "";
			permalink = `${url.origin}${url.pathname}`;
			if (url.pathname.length > MAX_PERMALINK_PATH_LENGTH) return undefined;
		} catch {
			return undefined;
		}
	}
	return {
		id,
		shortId,
		title: asString(record.title),
		culprit: asString(record.culprit),
		count: count || "0",
		firstSeen,
		lastSeen,
		permalink,
		level: SENTRY_LEVELS.has(asString(record.level)) ? asString(record.level) : "",
	};
}

/**
 * Recover the gjc fingerprint from the `gjc.fingerprint` tag the relay stamps.
 *
 * The issue-list payload carries no tags, so this is a per-issue lookup. A
 * group without the tag did not come from the gjc relay and is skipped rather
 * than guessed at — filing an issue against a fingerprint we inferred would
 * poison the dedup key the interactive flow depends on.
 */
export function fingerprintFromTagPayload(raw: unknown): string | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const record = raw as Record<string, unknown>;
	if (asString(record.key) !== "gjc.fingerprint") return undefined;
	const top = record.topValues;
	if (!Array.isArray(top) || top.length !== 1) return undefined;
	const value = asString((top[0] as { value?: unknown }).value);
	return FINGERPRINT.test(value) ? value : undefined;
}

interface FingerprintObservation {
	fingerprint: string;
}

export async function fingerprintOf(issueId: string, token: string): Promise<FingerprintObservation | undefined> {
	try {
		const fingerprint = fingerprintFromTagPayload(await sentryGet(`/issues/${issueId}/tags/gjc.fingerprint/`, token));
		return fingerprint ? { fingerprint } : undefined;
	} catch (error) {
		// Only "the tag is absent" means "not a gjc group". Auth failures, rate
		// limits, timeouts and 5xx must not be laundered into that answer: doing so
		// silently drops triage coverage and lets the run exit successfully with
		// "Nothing to file." while it in fact saw nothing.
		if (error instanceof SentryHttpError && error.status === 404) return undefined;
		throw error;
	}
}

async function gh(args: readonly string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	const child = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => child.kill(), GH_TIMEOUT_MS);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { ok: exitCode === 0, stdout, stderr };
	} finally {
		clearTimeout(timer);
	}
}

interface ExistingIssueSearch {
	kind: "none" | "untrusted";
	url?: string;
}

async function findExistingIssue(repo: string, fingerprint: string): Promise<ExistingIssueSearch> {
	const marker = `${CRASH_ISSUE_MARKER_PREFIX}${fingerprint}`;
	const result = await gh([
		"issue",
		"list",
		"--repo",
		repo,
		"--state",
		"all",
		"--search",
		`"${marker}" in:body`,
		"--limit",
		"5",
		"--json",
		"url",
	]);
	if (!result.ok) throw new Error(`gh issue list failed: ${result.stderr.trim() || "unknown error"}`);
	const parsed: unknown = JSON.parse(result.stdout);
	if (!Array.isArray(parsed)) throw new Error("gh issue list returned a non-array JSON payload");
	if (parsed.length === 0) return { kind: "none" };
	if (parsed.length !== 1) throw new Error("gh issue list returned multiple marker candidates");
	const url = (parsed[0] as { url?: unknown }).url;
	const expectedUrl = new RegExp(`^https://github\\.com/${repo.replace("/", "\\/")}/issues/[0-9]+$`);
	if (typeof url !== "string" || !expectedUrl.test(url))
		throw new Error("gh issue list returned a malformed or non-canonical issue URL");
	// This report never files or suppresses anything, so a marker is only
	// informational and cannot affect triage.
	return { kind: "untrusted", url };
}

function issueTitle(row: TriageRow): string {
	return `crash: ${renderCrashText(row.sentry.title, "<unsanitizable title>")}`.slice(0, 200);
}

/**
 * Every field here survived the relay's outbound sanitizer before it reached
 * Sentry, and crash-derived fields are re-sanitized locally anyway: the
 * `gjc.fingerprint` tag that identifies the crash class is stamped client-side with the
 * public DSN key, so trusting it blindly would let a forged group smuggle raw
 * text into an issue. The marker sits outside any fenced block, matching
 * `report.ts`, so a forged marker inside crash text cannot impersonate one.
 */
function issueBody(row: TriageRow, options: Options): string {
	const { sentry, fingerprint } = row;
	const title = renderCrashText(sentry.title, "<unsanitizable title>");
	const culprit = renderCrashText(sentry.culprit, "<unsanitizable culprit>") || "<unknown>";
	const level = SENTRY_LEVELS.has(sentry.level) ? sentry.level : "unknown";
	const body =
		`Filed from aggregated upstream crash data by \`scripts/sentry-crash-issues.ts\`. ` +
		`Every field below passed the \`sanitizeExternalCrashV1\` egress contract before leaving any install, ` +
		`and is re-sanitized locally before rendering.\n\n` +
		`- Signature: \`${CRASH_ISSUE_MARKER_PREFIX}${fingerprint}\` (algorithm v1)\n` +
		`- Upstream events: ${sentry.count}\n` +
		`- First seen: ${sentry.firstSeen} — last seen: ${sentry.lastSeen}\n` +
		`- Level: ${level}\n` +
		`- Culprit: \`${culprit}\`\n` +
		`- Upstream group: ${sentry.permalink} (${options.org}/${options.project}, ${fenceCrashText(sentry.shortId)})\n\n` +
		`Grouped crash class: \`${title}\`\n\n` +
		`Grouping is driven by the gjc fingerprint, not Sentry heuristics, so this group is exactly one gjc crash class.\n\n` +
		`Reproduction steps and environment are not captured upstream; see \`docs/crash-reporting.md\` for what the relay ` +
		`does and does not transmit.\n\n` +
		`<!-- ${CRASH_ISSUE_MARKER_PREFIX}${fingerprint} -->\n`;
	if (Buffer.byteLength(body, "utf8") > MAX_ISSUE_BODY_BYTES) throw new Error("issue body exceeds the GitHub size limit");
	return body;
}

export function partitionTriageRows(candidates: readonly TriageRow[]): {
	rows: TriageRow[];
	collisions: { fingerprint: string; groups: TriageRow[] }[];
} {
	const byFingerprint = new Map<string, TriageRow[]>();
	for (const row of candidates) {
		const bucket = byFingerprint.get(row.fingerprint);
		if (bucket) bucket.push(row);
		else byFingerprint.set(row.fingerprint, [row]);
	}
	const rows: TriageRow[] = [];
	const collisions: { fingerprint: string; groups: TriageRow[] }[] = [];
	for (const [fingerprint, bucket] of byFingerprint) {
		if (bucket.length === 1 && bucket[0]) rows.push(bucket[0]);
		else collisions.push({ fingerprint, groups: bucket });
	}
	return { rows, collisions };
}

/**
 * The culprit rendered for the dry-run preview, through the same renderer the
 * issue body uses. A maintainer terminal (and any redirected log) is as much an
 * output channel as the issue itself, so a forged upstream group must not be
 * able to push control sequences, secrets, mentions, or a dedup marker there
 * via this read-only report.
 */
export function previewCulprit(culprit: string): string {
	return renderCrashText(culprit, "<unsanitizable culprit>") || "<unknown>";
}

function usage(): string {
	return "Usage: bun scripts/sentry-crash-issues.ts [--limit N] [--org SLUG] [--project SLUG]\n";
}

interface MainDependencies {
	sentryGet(pathname: string, token: string): Promise<unknown>;
	fingerprintOf(issueId: string, token: string): Promise<FingerprintObservation | undefined>;
	findExistingIssue(repo: string, fingerprint: string): Promise<ExistingIssueSearch>;
	token(): string | undefined;
	writeStdout(message: string): void;
	writeStderr(message: string): void;
}

const defaultDependencies: MainDependencies = {
	sentryGet,
	fingerprintOf,
	findExistingIssue,
	token: sentryToken,
	writeStdout: message => process.stdout.write(message),
	writeStderr: message => process.stderr.write(message),
};

export async function main(argv: readonly string[], dependencies: MainDependencies = defaultDependencies): Promise<number> {
	const parsed = parseArgs(argv);
	if ("error" in parsed) {
		dependencies.writeStderr(`${parsed.error}\n`);
		return 2;
	}
	const options = parsed;
	if (options.help) {
		dependencies.writeStdout(usage());
		return 0;
	}
	const token = dependencies.token();
	if (!token) {
		dependencies.writeStderr("Set SENTRY_AUTH_TOKEN (or SENTRY_DEVNOGARI_AUTH_TOKEN) to read the upstream project.\n");
		return 2;
	}

	let raw: unknown;
	try {
		raw = await dependencies.sentryGet(
			`/projects/${options.org}/${options.project}/issues/?query=is:unresolved&limit=${options.limit}`,
			token,
		);
	} catch (error) {
		dependencies.writeStderr(`Sentry read failed: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
	if (!Array.isArray(raw)) {
		dependencies.writeStderr("Sentry returned an unexpected issue list shape.\n");
		return 1;
	}

	const candidates: TriageRow[] = [];
	let skippedNoFingerprint = 0;
	let skippedMalformed = 0;
	try {
		for (const entry of raw) {
			const sentry = toSentryIssue(entry);
			if (!sentry) {
				skippedMalformed++;
				continue;
			}
			const fingerprint = await dependencies.fingerprintOf(sentry.id, token);
			if (!fingerprint) {
				skippedNoFingerprint++;
				continue;
			}
			candidates.push({ fingerprint: fingerprint.fingerprint, sentry });
		}
	} catch (error) {
		dependencies.writeStderr(`Sentry tag read failed: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}

	// The client-stamped fingerprint can collide across upstream groups. Withhold
	// every collision rather than choosing attacker-controlled metadata.
	const { rows, collisions } = partitionTriageRows(candidates);
	for (const row of rows) {
		try {
			const existing = await dependencies.findExistingIssue(options.repo, row.fingerprint);
			if (existing.kind === "untrusted") row.existingIssueUrl = existing.url;
		} catch (error) {
			dependencies.writeStderr(
				`duplicate search failed for ${row.fingerprint}: ${error instanceof Error ? error.message : String(error)}\n`,
			);
			return 1;
		}
	}

	const marked = rows.filter(row => row.existingIssueUrl !== undefined);
	dependencies.writeStdout(
		`${rows.length} gjc signature(s) upstream; ${marked.length} existing marker(s) reported informationally` +
			(skippedNoFingerprint > 0 ? `; ${skippedNoFingerprint} upstream group(s) skipped (no gjc.fingerprint tag)` : "") +
			(skippedMalformed > 0 ? `; ${skippedMalformed} malformed upstream group(s) skipped` : "") +
			(collisions.length > 0 ? `; ${collisions.length} fingerprint collision(s) withheld` : "") +
			"\n\n",
	);
	for (const row of rows) {
		dependencies.writeStdout(
			`would file  ${row.fingerprint}  ${row.sentry.count}x  ${issueTitle(row)}\n` +
				`    culprit: ${previewCulprit(row.sentry.culprit)}\n` +
				(row.existingIssueUrl ? `    existing marker (informational): ${row.existingIssueUrl}\n` : "") +
				`    issue body:\n${issueBody(row, options)}\n`,
		);
	}
	if (collisions.length > 0) {
		dependencies.writeStderr(`\n${collisions.length} fingerprint collision(s) withheld; reconcile these upstream first:\n`);
		for (const collision of collisions) {
			dependencies.writeStderr(`  ${collision.fingerprint}\n`);
			for (const row of collision.groups)
				dependencies.writeStderr(`    ${row.sentry.shortId}  ${row.sentry.permalink}\n`);
		}
	}
	dependencies.writeStdout("\nDry run only. Filing is not implemented yet.\n");
	return collisions.length > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));

export { issueBody, issueTitle };
export type { FingerprintObservation, MainDependencies, Options, SentryIssue, TriageRow };
