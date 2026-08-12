/**
 * `gjc crash report` — user-driven, preview-first, fail-closed crash reporting.
 *
 * The ordering in `runCrashReportFlow` **is** the consent boundary: nothing
 * touches the network, authentication, the repository or even the `gh` binary
 * until the user has seen the exact bytes and confirmed them against their
 * digest. Automatic issue creation is an explicit non-goal — one field host
 * would have filed hundreds of duplicates for a single bug.
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CRASH_ISSUE_MARKER_PREFIX, normalizeCrashFrames, VERSION } from "@gajae-code/utils";
import type { RunGh } from "../utils/gh";
import {
	type CrashSignatureView,
	type CrashStatePaths,
	compactCrashIndex,
	listCrashSignatures,
	recordCrashStateEvent,
} from "./index-store";
import { findLatestRecord, type LoadedCrashRecord } from "./record-loader";
import { CRASH_BODY_MAX_BYTES, fenceCrashText, type SanitizeVerdict, sanitizeExternalCrashV1 } from "./sanitize";

/** The one repository this command may ever target. */
export const CRASH_REPORT_REPO = "Yeachan-Heo/gajae-code";
export const CRASH_REPORT_ISSUE_PREFIX = `https://github.com/${CRASH_REPORT_REPO}/issues/`;
const GH_TIMEOUT_MS = 15_000;
const NOT_CAPTURED = "_not captured — please fill in_";

export interface CrashReportEnvironment {
	platform: string;
	gjcVersion: string;
	bunVersion: string;
}

export interface CrashReportAnswers {
	steps: string;
	expected: string;
	provider: string;
	area: string;
	additional: string;
}

export function defaultCrashReportEnvironment(): CrashReportEnvironment {
	const platform =
		process.platform === "darwin"
			? "macOS"
			: process.platform === "win32"
				? "Windows (native)"
				: process.env.WSL_DISTRO_NAME
					? "Windows (WSL)"
					: "Linux";
	return { platform, gjcVersion: VERSION, bunVersion: Bun.version };
}

function coarseDate(epochMs: number): string {
	// Exact timestamps are omitted by default; a date is enough to triage.
	return new Date(epochMs).toISOString().slice(0, 10);
}

/** Generic title built from normalized inputs only — never from raw crash text. */
export function buildCrashReportTitle(signature: CrashSignatureView, record: LoadedCrashRecord): string {
	const frame = normalizeCrashFrames(record.body)[0] ?? "<no-app-frame>";
	const framePath = frame.split("#")[0] ?? frame;
	const verdict = sanitizeExternalCrashV1(`crash: ${signature.errorName} in ${framePath}`, 160);
	return verdict.ok ? verdict.value : `crash: ${CRASH_ISSUE_MARKER_PREFIX}${signature.fingerprint}`;
}

function field(label: string, value: string): string {
	return `## ${label}\n\n${value}\n`;
}

function answerOrPrompt(value: string): SanitizeVerdict {
	const trimmed = value.trim();
	if (!trimmed) return { ok: true, value: NOT_CAPTURED };
	return sanitizeExternalCrashV1(trimmed, 4 * 1024);
}

export interface BuildCrashReportBodyInput {
	signature: CrashSignatureView;
	record: LoadedCrashRecord;
	answers: CrashReportAnswers;
	environment: CrashReportEnvironment;
}

/**
 * Render the full issue body. Every `bug_report.yml` required field is present:
 * crash-derived fields prefilled, non-derivable fields carried through from the
 * interactive answers (or an explicit "not captured" prompt).
 *
 * All crash-derived text lives inside fenced blocks with backticks neutralized
 * and `@` de-fanged; the machine marker is emitted outside those blocks so a
 * forged marker inside crash text cannot impersonate one.
 */
export function buildCrashReportBody(input: BuildCrashReportBodyInput): SanitizeVerdict {
	const { signature, record, answers, environment } = input;
	const headline = sanitizeExternalCrashV1(record.headline, 1024);
	if (!headline.ok) return headline;
	const stack = sanitizeExternalCrashV1(record.body, 16 * 1024);
	if (!stack.ok) return stack;
	const messageClass = sanitizeExternalCrashV1(signature.messageClass, 1024);
	if (!messageClass.ok) return messageClass;
	const errorName = sanitizeExternalCrashV1(signature.errorName, 128);
	if (!errorName.ok) return errorName;

	const steps = answerOrPrompt(answers.steps);
	if (!steps.ok) return steps;
	const expected = answerOrPrompt(answers.expected);
	if (!expected.ok) return expected;
	const provider = answerOrPrompt(answers.provider);
	if (!provider.ok) return provider;
	const area = answerOrPrompt(answers.area);
	if (!area.ok) return area;
	const additional = answerOrPrompt(answers.additional);
	if (!additional.ok) return additional;

	const description =
		`Automatic crash report assembled by \`gjc crash report\` from a local crash record. ` +
		`Crash-derived text below is sanitized (paths, URLs, credentials and control characters removed) ` +
		`and carries no pid or exact timestamps.\n\n` +
		`- Signature: \`${CRASH_ISSUE_MARKER_PREFIX}${signature.fingerprint}\` (algorithm v${signature.fpv})\n` +
		`- Occurrences: ${signature.lifetimeCount} lifetime, ${signature.retainedCount} still in the local crash log\n` +
		`- First seen: ${coarseDate(signature.firstSeen)} — last seen: ${coarseDate(signature.lastSeen)}\n` +
		`- Error class: \`${fenceCrashText(errorName.value)}\`\n` +
		`- Normalized message class:\n\n\`\`\`\n${fenceCrashText(messageClass.value)}\n\`\`\``;

	const body =
		field("Description", description) +
		`\n${field("Steps to Reproduce", steps.value)}` +
		`\n${field("Expected Behavior", expected.value)}` +
		`\n${field("Error Output", `\`\`\`\n${fenceCrashText(headline.value)}\n${fenceCrashText(stack.value)}\n\`\`\``)}` +
		`\n${field("Platform", environment.platform)}` +
		`\n${field("gjc version", environment.gjcVersion)}` +
		`\n${field("Bun version", environment.bunVersion)}` +
		`\n${field("Provider", provider.value)}` +
		`\n${field("Area", area.value)}` +
		`\n${field("Additional context", additional.value)}` +
		`\n<!-- ${CRASH_ISSUE_MARKER_PREFIX}${signature.fingerprint} -->\n`;

	if (Buffer.byteLength(body, "utf8") > CRASH_BODY_MAX_BYTES)
		return { ok: false, reason: `report body exceeds ${CRASH_BODY_MAX_BYTES} bytes` };
	return { ok: true, value: body };
}

export interface CrashReportSnapshot {
	path: string;
	digest: string;
	byteLength: number;
	title: string;
	body: string;
}

/**
 * Freeze the exact bytes that may be submitted into a 0600 file.
 *
 * `wx` refuses to follow or clobber an existing path, so a planted symlink
 * cannot redirect the snapshot, and the digest shown to the user is verified
 * again immediately before submission.
 */
export async function writeCrashReportSnapshot(dir: string, title: string, body: string): Promise<CrashReportSnapshot> {
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	const target = path.join(dir, `crash-report-${Date.now()}-${randomUUID()}.md`);
	await fs.writeFile(target, body, { mode: 0o600, flag: "wx" });
	return {
		path: target,
		digest: createHash("sha256").update(body, "utf8").digest("hex"),
		byteLength: Buffer.byteLength(body, "utf8"),
		title,
		body,
	};
}

async function verifySnapshot(snapshot: CrashReportSnapshot): Promise<boolean> {
	try {
		const contents = await fs.readFile(snapshot.path, "utf8");
		return createHash("sha256").update(contents, "utf8").digest("hex") === snapshot.digest;
	} catch {
		return false;
	}
}

const BOUNDED_TITLE = /^[A-Za-z0-9 :._<>#/-]{1,160}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Prefilled issue URL for installs without `gh`.
 *
 * Built with `URL`/`URLSearchParams` against a fixed allowlisted origin and
 * carrying only bounded-grammar fields — never message or stack content. Never
 * auto-opened.
 */
export function buildPrefillUrl(title: string, fingerprint: string, version: string): string | undefined {
	if (!BOUNDED_TITLE.test(title)) return undefined;
	if (!/^[0-9a-f]{32}$/.test(fingerprint)) return undefined;
	if (!SEMVER.test(version)) return undefined;
	const url = new URL(`https://github.com/${CRASH_REPORT_REPO}/issues/new`);
	const params = new URLSearchParams({
		template: "bug_report.yml",
		title,
		description: `Crash signature ${CRASH_ISSUE_MARKER_PREFIX}${fingerprint} (gjc ${version}). Full sanitized report is in the local snapshot file printed by \`gjc crash report\`.`,
		version,
	});
	url.search = params.toString();
	return url.toString();
}

export interface DuplicateCandidate {
	url: string;
	title: string;
	author: string;
}

export type DuplicateCheck =
	| { status: "none" }
	| { status: "candidate"; candidate: DuplicateCandidate }
	| { status: "uncertain"; reason: string };

/** Validate that a `gh`-returned URL really points at the canonical repository. */
export function isCanonicalIssueUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.origin === "https://github.com" &&
			url.pathname.startsWith(`/${CRASH_REPORT_REPO}/issues/`) &&
			/^\d+$/.test(url.pathname.slice(`/${CRASH_REPORT_REPO}/issues/`.length))
		);
	} catch {
		return false;
	}
}

/**
 * Read-only duplicate search, always `--repo` pinned. Any timeout, auth failure
 * or unparseable result is `uncertain`, which refuses creation unless the user
 * explicitly overrides.
 */
export async function checkForDuplicateIssue(runGh: RunGh, fingerprint: string): Promise<DuplicateCheck> {
	const marker = `${CRASH_ISSUE_MARKER_PREFIX}${fingerprint}`;
	const result = await runGh(
		[
			"issue",
			"list",
			"--repo",
			CRASH_REPORT_REPO,
			"--state",
			"all",
			"--search",
			`"${marker}" in:body`,
			"--limit",
			"5",
			"--json",
			"url,title,author",
		],
		{ timeoutMs: GH_TIMEOUT_MS },
	);
	if (result.timedOut) return { status: "uncertain", reason: "duplicate search timed out" };
	if (result.exitCode !== 0)
		return { status: "uncertain", reason: `duplicate search failed: ${result.stderr.trim() || "unknown error"}` };
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout) as unknown;
	} catch {
		return { status: "uncertain", reason: "duplicate search returned unparseable output" };
	}
	if (!Array.isArray(parsed)) return { status: "uncertain", reason: "duplicate search returned unexpected shape" };
	if (parsed.length === 0) return { status: "none" };
	const first = parsed[0] as { url?: unknown; title?: unknown; author?: unknown };
	if (typeof first.url !== "string" || !isCanonicalIssueUrl(first.url))
		return { status: "uncertain", reason: "duplicate search returned a non-canonical URL" };
	const title = typeof first.title === "string" ? first.title : "(untitled)";
	const author =
		first.author &&
		typeof first.author === "object" &&
		typeof (first.author as { login?: unknown }).login === "string"
			? ((first.author as { login: string }).login satisfies string)
			: "unknown";
	// A marker in a body is forgeable, so this is a candidate only: the default
	// action prints the URL and stops.
	return { status: "candidate", candidate: { url: first.url, title, author } };
}

export interface CrashReportIo {
	print(text: string): void;
	/** Returns the chosen index, or undefined when cancelled. */
	select(prompt: string, options: string[]): Promise<number | undefined>;
	input(prompt: string): Promise<string>;
	confirm(prompt: string): Promise<boolean>;
}

export interface CrashReportDeps {
	io: CrashReportIo;
	paths: CrashStatePaths;
	snapshotDir: string;
	runGh: RunGh;
	interactive: boolean;
	environment?: CrashReportEnvironment;
	now?: () => Date;
}

export type CrashReportOutcome =
	| { status: "no-signatures" }
	| { status: "non-interactive"; snapshotPath?: string }
	| { status: "cancelled" }
	| { status: "acknowledged"; fingerprint: string }
	| { status: "refused"; reason: string }
	| { status: "unmatchable"; fingerprint: string }
	| { status: "manual"; snapshotPath: string; prefillUrl?: string }
	| { status: "duplicate"; url: string }
	| { status: "commented"; url: string }
	| { status: "created"; url: string };

function describeSignature(signature: CrashSignatureView): string {
	const reported = signature.reportedAt !== undefined ? "reported" : "unreported";
	const acknowledged = signature.acknowledgedAt !== undefined ? ", dismissed" : "";
	return (
		`${signature.fingerprint}  ${signature.errorName}: ${signature.messageClass.slice(0, 80)}\n` +
		`    ${signature.lifetimeCount}x (${signature.retainedCount} retained), ` +
		`${coarseDate(signature.firstSeen)} → ${coarseDate(signature.lastSeen)}, fpv:${signature.fpv}, ${reported}${acknowledged}`
	);
}

async function readCrashLog(crashLogPath: string): Promise<string> {
	try {
		return await fs.readFile(crashLogPath, "utf8");
	} catch {
		return "";
	}
}

/**
 * The whole flow. Steps 1–4 are strictly local; `deps.runGh` is first reachable
 * at step 5, after the digest-confirmed consent gate.
 */
export async function runCrashReportFlow(deps: CrashReportDeps): Promise<CrashReportOutcome> {
	const now = deps.now ?? (() => new Date());
	const environment = deps.environment ?? defaultCrashReportEnvironment();
	const index = await compactCrashIndex({ paths: deps.paths, now: now().getTime() });
	const signatures = listCrashSignatures(index);

	if (index.overflow)
		deps.io.print(
			"warning: the crash index is full and stopped recording new signatures; report or dismiss existing ones to make room.\n",
		);
	if (signatures.length === 0) {
		deps.io.print("No crash signatures recorded.\n");
		return { status: "no-signatures" };
	}

	const contents = await readCrashLog(deps.paths.crashLog);

	if (!deps.interactive) {
		deps.io.print(`${signatures.length} crash signature(s):\n`);
		for (const signature of signatures) deps.io.print(`  ${describeSignature(signature)}\n`);
		// Headless callers still get the artifact, never the transmission: the
		// newest reportable signature is rendered to a snapshot file they can read,
		// edit and submit by hand.
		const newest = signatures.find(candidate => findLatestRecord(contents, candidate.fingerprint) !== undefined);
		const record = newest ? findLatestRecord(contents, newest.fingerprint) : undefined;
		let snapshotPath: string | undefined;
		if (newest && record) {
			const built = buildCrashReportBody({
				signature: newest,
				record,
				answers: { steps: "", expected: "", provider: "", area: "", additional: "" },
				environment,
			});
			if (built.ok) {
				const snapshot = await writeCrashReportSnapshot(
					deps.snapshotDir,
					buildCrashReportTitle(newest, record),
					built.value,
				);
				snapshotPath = snapshot.path;
				deps.io.print(`\nReport draft for ${newest.fingerprint}: ${snapshot.path}\n`);
			}
		}
		deps.io.print(
			"\nSubmission requires an interactive terminal; nothing was transmitted. Re-run in a TTY to review and submit a report.\n",
		);
		return { status: "non-interactive", snapshotPath };
	}

	const options = signatures.map(describeSignature);
	options.push("Cancel");
	const chosen = await deps.io.select("Select a crash signature", options);
	if (chosen === undefined || chosen >= signatures.length) return { status: "cancelled" };
	const signature = signatures[chosen] as CrashSignatureView;

	const action = await deps.io.select(`Signature ${signature.fingerprint}`, [
		"Prepare a report for review",
		"Dismiss this signature (stops the startup nudge)",
		"Cancel",
	]);
	if (action === undefined || action === 2) return { status: "cancelled" };
	if (action === 1) {
		await recordCrashStateEvent(
			{ kind: "acknowledged", fingerprint: signature.fingerprint, at: now().getTime() },
			{ paths: deps.paths },
		);
		deps.io.print(`Dismissed ${signature.fingerprint}.\n`);
		return { status: "acknowledged", fingerprint: signature.fingerprint };
	}

	const record = findLatestRecord(contents, signature.fingerprint);
	if (!record) {
		deps.io.print(
			"No identity-bearing crash record is available for this signature. Records written before crash fingerprinting are unmatchable and cannot be reported through this flow.\n",
		);
		return { status: "unmatchable", fingerprint: signature.fingerprint };
	}

	deps.io.print(
		"\nThe following fields are not derivable from a crash record. Leave blank to submit an explicit " +
			'"not captured" prompt instead.\n',
	);
	const answers: CrashReportAnswers = {
		steps: await deps.io.input("Steps to reproduce"),
		expected: await deps.io.input("Expected behavior"),
		provider: await deps.io.input("Provider (blank if not provider-specific)"),
		area: await deps.io.input("Area (TUI, Tool execution, CLI commands, …)"),
		additional: await deps.io.input("Additional context"),
	};

	const title = buildCrashReportTitle(signature, record);
	const built = buildCrashReportBody({ signature, record, answers, environment });
	if (!built.ok) {
		deps.io.print(`Refusing to submit: ${built.reason}\n`);
		return { status: "refused", reason: built.reason };
	}

	const snapshot = await writeCrashReportSnapshot(deps.snapshotDir, title, built.value);
	deps.io.print(
		`\n--- exact bytes to be submitted (sha256 ${snapshot.digest}, ${snapshot.byteLength} bytes) ---\n` +
			`Title: ${snapshot.title}\n\n${snapshot.body}\n--- end of snapshot ---\n` +
			`Snapshot file: ${snapshot.path}\n` +
			`Target repository: ${CRASH_REPORT_REPO} (fixed)\n` +
			"The signature is a public, pseudonymous correlation token: it is deterministic over normalized crash text, " +
			"dictionary-testable, and links the same crash class across installs. It is not a confidentiality control.\n",
	);

	if (!(await deps.io.confirm(`Submit exactly these ${snapshot.byteLength} bytes to ${CRASH_REPORT_REPO}?`))) {
		deps.io.print(`Nothing was transmitted. The report stays at ${snapshot.path}.\n`);
		return { status: "cancelled" };
	}

	// ---- consent boundary: `gh` may run from here on, and not one step earlier.
	if (!(await verifySnapshot(snapshot))) {
		deps.io.print("Refusing to submit: the snapshot file changed after it was confirmed.\n");
		return { status: "refused", reason: "snapshot digest mismatch" };
	}

	const identity = await deps.runGh(["api", "user", "--jq", ".login"], { timeoutMs: GH_TIMEOUT_MS });
	if (identity.exitCode !== 0) {
		const prefillUrl = buildPrefillUrl(snapshot.title, signature.fingerprint, environment.gjcVersion);
		deps.io.print(
			`GitHub CLI is unavailable or unauthenticated (${identity.stderr.trim() || "no gh"}).\n` +
				`Nothing was transmitted. Submit manually with the snapshot at ${snapshot.path}.\n` +
				(prefillUrl ? `Prefilled issue form (not opened automatically): ${prefillUrl}\n` : ""),
		);
		return { status: "manual", snapshotPath: snapshot.path, prefillUrl };
	}
	deps.io.print(`Active gh identity: ${identity.stdout.trim() || "unknown"}\n`);

	const duplicate = await checkForDuplicateIssue(deps.runGh, signature.fingerprint);
	if (duplicate.status === "uncertain") {
		deps.io.print(`Duplicate check inconclusive: ${duplicate.reason}\n`);
		if (!(await deps.io.confirm("Skip the duplicate check and create a new issue anyway?"))) {
			deps.io.print(`Nothing was transmitted. The report stays at ${snapshot.path}.\n`);
			return { status: "refused", reason: duplicate.reason };
		}
	} else if (duplicate.status === "candidate") {
		const { candidate } = duplicate;
		deps.io.print(
			`\nA possible existing report carries this signature (markers are forgeable, so this is a candidate only):\n` +
				`  ${candidate.url}\n  "${candidate.title}" by ${candidate.author}\n`,
		);
		const already = index.signatures[signature.fingerprint]?.commentedIssues?.includes(candidate.url) === true;
		const choice = await deps.io.select("What would you like to do?", [
			"Stop here (recommended) — the existing issue already tracks this",
			already ? 'Add a "+1" comment (already commented from this install)' : 'Add a "+1" comment to that issue',
		]);
		if (choice !== 1) {
			deps.io.print(`Nothing was transmitted. Existing issue: ${candidate.url}\n`);
			return { status: "duplicate", url: candidate.url };
		}
		if (already) {
			deps.io.print(`This install already commented on ${candidate.url}; not commenting again.\n`);
			return { status: "duplicate", url: candidate.url };
		}
		if (
			!(await deps.io.confirm(
				`Post a public "+1" comment as ${identity.stdout.trim() || "your gh identity"} on ${candidate.url}?`,
			))
		) {
			deps.io.print(`Nothing was transmitted. Existing issue: ${candidate.url}\n`);
			return { status: "duplicate", url: candidate.url };
		}
		const comment = await deps.runGh(
			[
				"issue",
				"comment",
				candidate.url,
				"--repo",
				CRASH_REPORT_REPO,
				"--body",
				`Also hit here: \`${CRASH_ISSUE_MARKER_PREFIX}${signature.fingerprint}\` (gjc ${environment.gjcVersion}, ${environment.platform}).`,
			],
			{ timeoutMs: GH_TIMEOUT_MS },
		);
		if (comment.exitCode !== 0) {
			deps.io.print(`Comment failed: ${comment.stderr.trim() || "unknown error"}\n`);
			return { status: "refused", reason: "comment failed" };
		}
		await recordCrashStateEvent(
			{
				kind: "reported",
				fingerprint: signature.fingerprint,
				at: now().getTime(),
				issueUrl: candidate.url,
				commented: true,
			},
			{ paths: deps.paths },
		);
		deps.io.print(`Commented on ${candidate.url}\n`);
		return { status: "commented", url: candidate.url };
	}

	const created = await deps.runGh(
		["issue", "create", "--repo", CRASH_REPORT_REPO, "--title", snapshot.title, "--body-file", snapshot.path],
		{ timeoutMs: GH_TIMEOUT_MS },
	);
	if (created.exitCode !== 0) {
		deps.io.print(`Issue creation failed: ${created.stderr.trim() || "unknown error"}\n`);
		return { status: "refused", reason: "issue creation failed" };
	}
	const url = created.stdout.trim().split("\n").at(-1) ?? "";
	if (!isCanonicalIssueUrl(url)) {
		deps.io.print(`Issue creation returned an unexpected URL; not recording it: ${url}\n`);
		return { status: "refused", reason: "non-canonical issue URL" };
	}
	await recordCrashStateEvent(
		{ kind: "reported", fingerprint: signature.fingerprint, at: now().getTime(), issueUrl: url },
		{ paths: deps.paths },
	);
	deps.io.print(`Created ${url}\n`);
	return { status: "created", url };
}
