#!/usr/bin/env bun
/**
 * Batch-triage aggregated crash signatures from a Sentry project into GitHub
 * issues.
 *
 * This is a maintainer tool, not part of the shipped CLI. `gjc crash report`
 * deliberately files one signature at a time behind a per-invocation,
 * digest-confirmed consent boundary, because a field host running it in a loop
 * would have filed hundreds of duplicates for a single bug. Once signatures are
 * already aggregated upstream, the opposite is true: triage wants the whole set
 * at once, and the dedup key is the fingerprint rather than a human reading a
 * digest.
 *
 * The two surfaces therefore share exactly one contract — the
 * `gjc-crash-fp.v1:<fp>` marker — and nothing else. An issue this script files
 * is indistinguishable to `checkForDuplicateIssue` from one filed interactively,
 * so the interactive flow keeps recognizing it as a duplicate afterwards.
 *
 * Safety: `--apply` is required to create anything. The default run reports what
 * it would do and exits without touching the repository.
 *
 * Usage:
 *   bun scripts/sentry-crash-issues.ts [--apply] [--limit N] [--org SLUG] [--project SLUG]
 *
 * `--repo` exists only to make the target explicit; it is pinned to the same
 * repository `gjc crash report` searches, because the shared marker is the
 * dedup contract and a marker filed anywhere else is invisible to it.
 *
 * Auth:
 *   SENTRY_AUTH_TOKEN (or SENTRY_DEVNOGARI_AUTH_TOKEN) for the Sentry read side.
 *   `gh` must already be authenticated for the GitHub write side.
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

interface Options {
	apply: boolean;
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
	trustedFingerprint?: boolean;
	existingIssueUrl?: string;
}

export function parseArgs(argv: readonly string[]): Options | { error: string } {
	const options: Options = {
		apply: false,
		limit: 25,
		org: DEFAULT_ORG,
		project: DEFAULT_PROJECT,
		repo: DEFAULT_REPO,
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--apply") {
			options.apply = true;
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

function toSentryIssue(raw: unknown): SentryIssue | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const record = raw as Record<string, unknown>;
	const shortId = asString(record.shortId);
	const id = asString(record.id);
	if (!shortId || !id) return undefined;
	return {
		id,
		shortId,
		title: asString(record.title),
		culprit: asString(record.culprit),
		count: asString(record.count) || "0",
		firstSeen: asString(record.firstSeen).slice(0, 10),
		lastSeen: asString(record.lastSeen).slice(0, 10),
		permalink: asString(record.permalink),
		level: asString(record.level),
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
	trusted: boolean;
}

export async function fingerprintOf(issueId: string, token: string): Promise<FingerprintObservation | undefined> {
	try {
		const fingerprint = fingerprintFromTagPayload(await sentryGet(`/issues/${issueId}/tags/gjc.fingerprint/`, token));
		// Public-DSN tags are never sufficient authority to create a GitHub issue.
		return fingerprint ? { fingerprint, trusted: false } : undefined;
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

/**
 * Reuse the interactive flow's dedup contract verbatim so an issue filed by
 * either surface suppresses the other.
 */
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
	// A marker in an arbitrary issue body is not provenance and cannot suppress
	// a crash class without an explicit operator decision.
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
	return (
		`Filed from aggregated upstream crash data by \`scripts/sentry-crash-issues.ts\`. ` +
		`Every field below passed the \`sanitizeExternalCrashV1\` egress contract before leaving any install, ` +
		`and is re-sanitized locally before rendering.\n\n` +
		`- Signature: \`${CRASH_ISSUE_MARKER_PREFIX}${fingerprint}\` (algorithm v1)\n` +
		`- Upstream events: ${sentry.count}\n` +
		`- First seen: ${sentry.firstSeen} — last seen: ${sentry.lastSeen}\n` +
		`- Level: ${fenceCrashText(sanitizeField(sentry.level, "")) || "unknown"}\n` +
		`- Culprit: \`${culprit}\`\n` +
		`- Upstream group: ${sentry.permalink} (${options.org}/${options.project}, ${fenceCrashText(sentry.shortId)})\n\n` +
		`Grouped crash class: \`${title}\`\n\n` +
		`Grouping is driven by the gjc fingerprint, not Sentry heuristics, so this group is exactly one gjc crash class.\n\n` +
		`Reproduction steps and environment are not captured upstream; see \`docs/crash-reporting.md\` for what the relay ` +
		`does and does not transmit.\n\n` +
		`<!-- ${CRASH_ISSUE_MARKER_PREFIX}${fingerprint} -->\n`
	);
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
 * via the default no-`--apply` run.
 */
export function previewCulprit(culprit: string): string {
	return renderCrashText(culprit, "<unsanitizable culprit>") || "<unknown>";
}

interface MainDependencies {
	sentryGet(pathname: string, token: string): Promise<unknown>;
	fingerprintOf(issueId: string, token: string): Promise<FingerprintObservation | undefined>;
	findExistingIssue(repo: string, fingerprint: string): Promise<ExistingIssueSearch>;
	gh(args: readonly string[]): Promise<{ ok: boolean; stdout: string; stderr: string }>;
	token(): string | undefined;
	writeStdout(message: string): void;
	writeStderr(message: string): void;
}

const defaultDependencies: MainDependencies = {
	sentryGet,
	fingerprintOf,
	findExistingIssue,
	gh,
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
	try {
		for (const entry of raw) {
			const sentry = toSentryIssue(entry);
			const fingerprint = sentry ? await dependencies.fingerprintOf(sentry.id, token) : undefined;
			if (!sentry || !fingerprint) {
				skippedNoFingerprint++;
				continue;
			}
			candidates.push({ fingerprint: fingerprint.fingerprint, trustedFingerprint: fingerprint.trusted, sentry });
		}
	} catch (error) {
		dependencies.writeStderr(`Sentry tag read failed: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}

	// The fingerprint is client-stamped and the DSN that stamps it is a public
	// ingestion key, so a collision is not necessarily a benign group merge -- it
	// can be an attacker-controlled group claiming a real crash's identity.
	// Picking whichever arrived first would let that group replace the legitimate
	// one's metadata and suppress it from triage forever, because the marker it
	// files makes the real group look already-filed. There is no authenticated
	// discriminator available here, so a collision fails closed: every colliding
	// group is withheld and reported for manual reconciliation.
	const { rows, collisions } = partitionTriageRows(candidates);

	const unverified = rows.filter(row => !row.trustedFingerprint);
	const trustedRows = rows.filter(row => row.trustedFingerprint);
	const untrustedBodyMarkers: TriageRow[] = [];
	for (const row of trustedRows) {
		let existing: ExistingIssueSearch;
		try {
			existing = await dependencies.findExistingIssue(options.repo, row.fingerprint);
		} catch (error) {
			dependencies.writeStderr(
				`duplicate search failed for ${row.fingerprint}: ${error instanceof Error ? error.message : String(error)}\n`,
			);
			return 1;
		}
		if (existing.kind === "untrusted") {
			row.existingIssueUrl = existing.url;
			untrustedBodyMarkers.push(row);
		}
	}

	const pending = trustedRows.filter(row => row.existingIssueUrl === undefined);
	const already = 0;

	dependencies.writeStdout(
		`${rows.length} gjc signature(s) upstream; ${already} already filed, ${pending.length} pending` +
			(skippedNoFingerprint > 0 ? `; ${skippedNoFingerprint} upstream group(s) skipped (no gjc.fingerprint tag)` : "") +
			(unverified.length > 0 ? `; ${unverified.length} unverified fingerprint(s) withheld` : "") +
			(untrustedBodyMarkers.length > 0 ? `; ${untrustedBodyMarkers.length} untrusted issue marker(s) withheld` : "") +
			(collisions.length > 0 ? `; ${collisions.length} fingerprint collision(s) withheld` : "") +
			"\n\n",
	);

	if (collisions.length > 0) {
		dependencies.writeStderr(`\n${collisions.length} fingerprint collision(s) withheld; reconcile these upstream first:\n`);
		for (const collision of collisions) {
			dependencies.writeStderr(`  ${collision.fingerprint}\n`);
			for (const row of collision.groups)
				dependencies.writeStderr(`    ${row.sentry.shortId}  ${row.sentry.permalink}\n`);
		}
	}
	if (unverified.length > 0)
		dependencies.writeStderr(
			`\n${unverified.length} fingerprint(s) withheld: public-DSN tags are unverified and cannot authorize --apply.\n`,
		);
	if (untrustedBodyMarkers.length > 0)
		dependencies.writeStderr(
			`\n${untrustedBodyMarkers.length} issue-body marker(s) withheld; require explicit operator confirmation.\n`,
		);

	if (pending.length === 0) {
		dependencies.writeStdout("Nothing to file.\n");
		return collisions.length > 0 || unverified.length > 0 || untrustedBodyMarkers.length > 0 ? 1 : 0;
	}

	if (!options.apply) {
		for (const row of pending)
			dependencies.writeStdout(
				`would file  ${row.fingerprint}  ${row.sentry.count}x  ${issueTitle(row)}\n` +
					`    culprit: ${previewCulprit(row.sentry.culprit)}\n` +
					`    ${row.sentry.permalink}\n`,
			);
		dependencies.writeStdout(`\nDry run. Re-run with --apply to create ${pending.length} issue(s) in ${options.repo}.\n`);
		return collisions.length > 0 || unverified.length > 0 || untrustedBodyMarkers.length > 0 ? 1 : 0;
	}

	let created = 0;
	let failed = 0;
	for (const row of pending) {
		const result = await dependencies.gh([
			"issue",
			"create",
			"--repo",
			options.repo,
			"--title",
			issueTitle(row),
			"--body",
			issueBody(row, options),
		]);
		if (result.ok) {
			created++;
			dependencies.writeStdout(`filed  ${row.fingerprint}  ${result.stdout.trim()}\n`);
			continue;
		}
		failed++;
		dependencies.writeStderr(`failed ${row.fingerprint}: ${result.stderr.trim() || "unknown error"}\n`);
	}
	dependencies.writeStdout(`\ncreated ${created}, failed ${failed}\n`);
	return failed > 0 || collisions.length > 0 || unverified.length > 0 || untrustedBodyMarkers.length > 0 ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));

export { issueBody, issueTitle, toSentryIssue };
export type { FingerprintObservation, MainDependencies, Options, SentryIssue, TriageRow };
