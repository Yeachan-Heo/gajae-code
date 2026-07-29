#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const ACPX_VERSION = "0.13.0";
export const ACPX_GIT_HEAD = "47dc1c56b20da3c248a4a1b5c5106f52e65e6594";
/** `conformance/profiles/acp-core-v1.json#required_cases` at the pinned commit. */
export const ACP_CORE_V1_CASE_IDS = [
	"acp.v1.initialize.handshake",
	"acp.v1.session.new.basic",
	"acp.v1.session.prompt.single_turn",
	"acp.v1.session.update.termination",
	"acp.v1.session.cancel.in_flight",
	"acp.v1.session.cancel.idle",
	"acp.v1.session.prompt.multi_turn",
	"acp.v1.errors.invalid_params",
	"acp.v1.errors.invalid_prompt_session_type",
	"acp.v1.errors.permission_denied",
	"acp.v1.errors.permission_denied.write",
	"acp.v1.errors.unknown_session",
	"acp.v1.session.prompt.echo_empty",
	"acp.v1.session.prompt.unrecognized",
	"acp.v1.errors.invalid_params.cwd_null",
	"acp.v1.session.prompt.structured_blocks",
	"acp.v1.permissions.read.approved",
	"acp.v1.permissions.write.approved",
	"acp.v1.session.prompt.background_completion",
	"acp.v1.session.cancel.followup_prompt",
	"acp.v1.session.prompt.post_success_drain",
] as const;

export type AcpxMetadata = { version: string; gitHead?: string };
export type AcpxCheckout = { root: string; head: string };
export type CaseResult = { id: string; passed: boolean; [key: string]: unknown };
export type UpstreamReport = {
	profileId: string;
	results: CaseResult[];
	totals?: { cases: number; passed: number; failed: number };
	[key: string]: unknown;
};
export type ConformanceReport = {
	command: string[];
	cwd: string;
	gjc: { commit: string; dirty: boolean };
	acpx: { version: string; gitHead: string };
	profile: string;
	agentCommand: string;
	matrix: CaseResult[];
	totals: { cases: number; passed: number; failed: number };
};

export interface RunAcpConformanceOptions {
	agentCommand: string;
	reportPath: string;
	format?: "json";
	cwd?: string;
	profile?: string;
	fetchMetadata?: () => Promise<AcpxMetadata>;
	checkout?: () => Promise<AcpxCheckout>;
	runRunner?: (options: { command: string[]; cwd: string; sessionCwd?: string }) => Promise<void>;
	readReport?: (reportPath: string) => Promise<unknown>;
	writeReport?: (reportPath: string, report: ConformanceReport) => Promise<void>;
}

function assertProvenance(metadata: AcpxMetadata, checkout: AcpxCheckout): void {
	if (metadata.version !== ACPX_VERSION)
		throw new Error(`Expected acpx@${ACPX_VERSION}; received ${metadata.version}.`);
	if (metadata.gitHead !== ACPX_GIT_HEAD)
		throw new Error(`Expected acpx gitHead ${ACPX_GIT_HEAD}; received ${metadata.gitHead ?? "missing"}.`);
	if (checkout.head !== ACPX_GIT_HEAD)
		throw new Error(`Expected source checkout HEAD ${ACPX_GIT_HEAD}; received ${checkout.head}.`);
}

function validateResults(report: unknown, profile: string): CaseResult[] {
	if (!report || typeof report !== "object") throw new Error("Conformance runner report is missing or malformed.");
	const value = report as Partial<UpstreamReport>;
	if (value.profileId !== profile || !Array.isArray(value.results))
		throw new Error("Conformance runner report is missing profileId or results.");
	const expected = new Set<string>(ACP_CORE_V1_CASE_IDS);
	const seen = new Set<string>();
	for (const result of value.results) {
		if (!result || typeof result.id !== "string" || typeof result.passed !== "boolean")
			throw new Error("Conformance runner report contains a malformed case result.");
		if (seen.has(result.id)) throw new Error(`Conformance runner report has duplicate case ID: ${result.id}.`);
		seen.add(result.id);
		if (!expected.has(result.id)) throw new Error(`Conformance runner report has unexpected case ID: ${result.id}.`);
		if (!result.passed) throw new Error(`Conformance case failed: ${result.id}.`);
	}
	for (const id of ACP_CORE_V1_CASE_IDS)
		if (!seen.has(id)) throw new Error(`Conformance runner report is missing required case ID: ${id}.`);
	return value.results;
}

/**
 * Runs the pinned upstream conformance suite against a real ACP agent command.
 *
 * `--cwd` must be a real path, not one reached through a symlink (macOS `/tmp` is a
 * link to `/private/tmp`): the upstream client enforces its session cwd root against
 * the resolved path, so a symlinked workspace fails the client-authority cases.
 */
export async function runAcpConformance(options: RunAcpConformanceOptions): Promise<ConformanceReport> {
	const profile = options.profile ?? "acp-core-v1";
	const requestedCwd = options.cwd ?? process.cwd();
	const resolvedCwd = await fs.realpath(requestedCwd).catch(() => requestedCwd);
	if (path.resolve(requestedCwd) !== resolvedCwd)
		throw new Error(
			`--cwd must be a real path; ${requestedCwd} resolves to ${resolvedCwd} and the client rejects paths outside its session cwd root.`,
		);
	if (profile !== "acp-core-v1") throw new Error(`Unsupported conformance profile: ${profile}.`);
	// The upstream runner spawns the agent from its own checkout, so any repo-relative
	// path in the command must be resolved against this repository first.
	const agentCommand = options.agentCommand
		.split(" ")
		.map(token => (token.endsWith(".ts") && !path.isAbsolute(token) ? path.resolve(token) : token))
		.join(" ");
	const metadata = await (options.fetchMetadata ?? fetchNpmMetadata)();
	const checkout = await (options.checkout ?? checkoutAcpxSource)();
	assertProvenance(metadata, checkout);
	const upstreamReportPath = path.join(os.tmpdir(), `gjc-acpx-${crypto.randomUUID()}.json`);
	const command = [
		"bun",
		path.join(checkout.root, "conformance", "runner", "run.ts"),
		"--profile",
		path.join(checkout.root, "conformance", "profiles", `${profile}.json`),
		"--cases-dir",
		path.join(checkout.root, "conformance", "cases"),
		"--agent-command",
		agentCommand,
		"--format",
		"json",
		"--report",
		upstreamReportPath,
		"--cwd",
		options.cwd ?? process.cwd(),
	];
	// A failing run still writes its report. Preserve that matrix as CI evidence before
	// surfacing the failure, so the uploaded artifact explains what actually broke.
	let runnerFailure: unknown;
	try {
		await (options.runRunner ?? runRunner)({ command, cwd: checkout.root, sessionCwd: options.cwd ?? process.cwd() });
	} catch (error) {
		runnerFailure = error;
	}
	const upstream = await (options.readReport ?? readReport)(upstreamReportPath).catch(() => undefined);
	if (runnerFailure !== undefined) {
		if (upstream && typeof upstream === "object") {
			const failed = upstream as Partial<UpstreamReport>;
			await (options.writeReport ?? writeReport)(options.reportPath, {
				command,
				cwd: options.cwd ?? process.cwd(),
				gjc: gjcIdentity(),
				acpx: { version: metadata.version, gitHead: metadata.gitHead as string },
				profile,
				agentCommand,
				matrix: Array.isArray(failed.results) ? failed.results : [],
				totals: failed.totals ?? { cases: 0, passed: 0, failed: 0 },
			});
		}
		throw runnerFailure;
	}
	const matrix = validateResults(upstream, profile);
	const report: ConformanceReport = {
		command,
		cwd: options.cwd ?? process.cwd(),
		gjc: gjcIdentity(),
		acpx: { version: metadata.version, gitHead: metadata.gitHead! },
		profile,
		agentCommand,
		matrix,
		totals: { cases: matrix.length, passed: matrix.length, failed: 0 },
	};
	await (options.writeReport ?? writeReport)(options.reportPath, report);
	return report;
}

function gjcIdentity(): { commit: string; dirty: boolean } {
	try {
		const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
		const dirty = Bun.spawnSync(["git", "status", "--porcelain"]).stdout.toString().trim().length > 0;
		return { commit, dirty };
	} catch {
		return { commit: "unknown", dirty: true };
	}
}

async function fetchNpmMetadata(): Promise<AcpxMetadata> {
	const response = await fetch(`https://registry.npmjs.org/acpx/${ACPX_VERSION}`);
	if (!response.ok)
		throw new Error(`Unable to resolve acpx@${ACPX_VERSION}: ${response.status} ${response.statusText}.`);
	return (await response.json()) as AcpxMetadata;
}

async function commandOutput(command: string[], cwd?: string, env?: Record<string, string>): Promise<string> {
	const child = Bun.spawn(command, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		...(env ? { env: { ...process.env, ...env } } : {}),
	});
	const [code, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (code !== 0)
		throw new Error(`${command.join(" ")} failed (exit ${code}).\nstdout:\n${stdout}\nstderr:\n${stderr}`);
	return stdout.trim();
}

async function checkoutAcpxSource(): Promise<AcpxCheckout> {
	const root = path.join(os.homedir(), ".cache", "gjc", "acpx", ACPX_GIT_HEAD);
	try {
		await fs.access(path.join(root, ".git"));
	} catch {
		await fs.mkdir(path.dirname(root), { recursive: true });
		await commandOutput(["git", "clone", "https://github.com/openclaw/acpx.git", root]);
	}
	await commandOutput(["git", "fetch", "--depth", "1", "origin", ACPX_GIT_HEAD], root);
	await commandOutput(["git", "checkout", "--detach", ACPX_GIT_HEAD], root);
	// A reused cache must match the pin exactly; local edits would invalidate the
	// provenance the report claims.
	await commandOutput(["git", "reset", "--hard", ACPX_GIT_HEAD], root);
	await commandOutput(["git", "clean", "-fdx", "--exclude=node_modules"], root);
	const status = await commandOutput(["git", "status", "--porcelain"], root);
	if (status.length > 0) throw new Error(`acpx source checkout is not clean at ${ACPX_GIT_HEAD}.`);
	// The upstream runner resolves its own imports (`@agentclientprotocol/sdk`, `zod`)
	// from this checkout, not from the gjc workspace, so the pin has to be installed
	// before it can run. `git clean` deliberately preserves node_modules so a warm
	// cache skips the reinstall.
	await commandOutput(["bun", "install", "--no-save", "--ignore-scripts"], root);
	return { root, head: await commandOutput(["git", "rev-parse", "HEAD"], root) };
}

async function runRunner(options: { command: string[]; cwd: string; sessionCwd?: string }): Promise<void> {
	// The fixture seeds the corpus scratch workspace; the runner only creates it.
	await commandOutput(
		options.command,
		options.cwd,
		options.sessionCwd ? { GJC_ACP_CONFORMANCE_CWD: options.sessionCwd } : undefined,
	);
}
async function readReport(reportPath: string): Promise<unknown> {
	return await Bun.file(reportPath).json();
}
async function writeReport(reportPath: string, report: ConformanceReport): Promise<void> {
	await fs.mkdir(path.dirname(reportPath), { recursive: true });
	await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

function parseCli(argv: string[]): RunAcpConformanceOptions {
	const values: Partial<RunAcpConformanceOptions> = { format: "json", profile: "acp-core-v1" };
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		if (flag === "--format") {
			if (argv[++index] !== "json") throw new Error("--format must be json.");
			continue;
		}
		if (flag === "--agent-command") {
			values.agentCommand = argv[++index];
			continue;
		}
		if (flag === "--report") {
			values.reportPath = argv[++index];
			continue;
		}
		if (flag === "--cwd") {
			values.cwd = argv[++index];
			continue;
		}
		if (flag === "--profile") {
			values.profile = argv[++index];
			continue;
		}
		throw new Error(`Unknown argument: ${flag}.`);
	}
	if (!values.agentCommand || !values.reportPath)
		throw new Error(
			"Usage: conformance:run --agent-command <command> --format json --report <path> [--cwd <path>] [--profile acp-core-v1]",
		);
	return values as RunAcpConformanceOptions;
}

if (import.meta.main) {
	runAcpConformance(parseCli(process.argv.slice(2))).catch(error => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
