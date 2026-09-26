import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type PerfCorpusFixtureResult,
	type PerfCorpusReport,
	type ProfilerSelfTimeSample,
	validatePerfCorpusReport,
} from "../perf-corpus-schema";

import { loadCorpusManifest, sha256Hex, type CorpusManifest } from "./corpus";

export interface CpuProfileNode {
	id: number;
	callFrame: {
		functionName?: string;
		url?: string;
		lineNumber?: number;
		columnNumber?: number;
	};
}

export interface CpuProfile {
	nodes: CpuProfileNode[];
	samples?: number[];
	timeDeltas?: number[];
	samplingInterval?: number;
	startTime?: number;
	endTime?: number;
}

export interface ProfileFunction {
	symbol: string;
	functionName: string;
	url: string;
	line: number;
	selfTimeMs: number;
	samples: number;
	share: number;
}

export interface HarnessMark {
	scenario: string;
	name: string;
	kind: "scenario" | "session-load" | "session-save" | "token-delta" | "keystroke" | "tool-call" | "compaction" | "startup";
	startMs: number;
	endMs: number;
	sessionId?: string;
	toolName?: string;
	wallStartMs?: number;
	wallEndMs?: number;
}


export interface ReplayFidelity {
	recordedAssistantTurns: number;
	replayedAssistantTurns: number;
	recordedToolCallSeqSha256: string;
	replayedToolCallSeqSha256: string;
	finalFrameNonEmpty: boolean;
}

export interface FixtureMeasurement {
	elapsedMs: number;
	userMicros: number;
	systemMicros: number;
	rssBeforeBytes: number;
	rssAfterBytes: number;
}

export interface ScenarioSummary {
	cpuprofilePath: string;
	totalSelfTimeMs: number;
	topFunctions: ProfileFunction[];
	typescriptFunctionsAtFivePercent: ProfileFunction[];
}

export interface SessionReplayProfileReport {
	schema: "gjc.session-replay-profile/1";
	generatedAt: string;
	harness: {
		gitSha: string;
		bunVersion: string;
		host: { platform: string; arch: string; release: string };
		corpusManifestSha256: string;
		sanitizerVersion: string;
		command: string;
		notes: string[];
	};
	scenarios: Record<string, ScenarioSummary>;
	criticalPaths: {
		startup: WindowSummary[];
		perKeystroke: WindowSummary[];
		perTokenDelta: WindowSummary[];
		phases: WindowSummary[];
	};
	replayFidelity: Record<string, ReplayFidelity>;
	perfCorpusReport: PerfCorpusReport;
}

export interface WindowSummary {
	scenario: string;
	name: string;
	kind: HarnessMark["kind"];
	sessionId?: string;
	toolName?: string;
	startMs: number;
	endMs: number;
	totalSelfTimeMs: number;
	functions: ProfileFunction[];
}

export class CorpusProvenanceInsufficient extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CorpusProvenanceInsufficient";
	}
}

function isWithin(parent: string, candidate: string): boolean {
	const relative = path.relative(parent, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function resolveProfileOutputPath(repositoryRoot: string, requestedOut: string | undefined, gitSha: string): string {
	const profilesRoot = path.resolve(repositoryRoot, ".gjc", "profiles");
	const candidate = path.resolve(repositoryRoot, requestedOut ?? path.join(".gjc", "profiles", gitSha));
	if (!isWithin(profilesRoot, candidate)) {
		throw new Error(`Profile output path must stay under ${path.relative(repositoryRoot, profilesRoot)}/`);
	}
	return candidate;
}

export async function ensureProfileOutputDirectory(
	repositoryRoot: string,
	requestedOut: string | undefined,
	gitSha: string,
): Promise<string> {
	const profilesRoot = path.resolve(repositoryRoot, ".gjc", "profiles");
	const outputPath = resolveProfileOutputPath(repositoryRoot, requestedOut, gitSha);
	await fs.mkdir(profilesRoot, { recursive: true });
	const profilesRealPath = await fs.realpath(profilesRoot);
	const repositoryRealPath = await fs.realpath(repositoryRoot);
	if (!isWithin(repositoryRealPath, profilesRealPath)) {
		throw new Error("Profile output root resolves outside the repository");
	}
	await fs.mkdir(outputPath, { recursive: true });
	const outputRealPath = await fs.realpath(outputPath);
	if (!isWithin(profilesRealPath, outputRealPath)) {
		throw new Error("Profile output directory resolves outside .gjc/profiles");
	}
	return outputRealPath;
}

function profileFunctionSymbol(node: CpuProfileNode): { symbol: string; functionName: string; url: string; line: number } {
	const functionName = node.callFrame.functionName?.trim() || "(anonymous)";
	const url = node.callFrame.url ?? "";
	const zeroBasedLine = node.callFrame.lineNumber ?? -1;
	const line = zeroBasedLine >= 0 ? zeroBasedLine + 1 : 0;
	return { symbol: `${functionName}@${url}:${line}`, functionName, url, line };
}

function indexedSelfTime(
	profile: CpuProfile,
	startMs: number,
	endMs: number,
	intervalMicros: number,
): Map<string, { symbol: string; functionName: string; url: string; line: number; selfTimeMs: number; samples: number }> {
	const nodes = new Map(profile.nodes.map(node => [node.id, node]));
	const totals = new Map<string, { symbol: string; functionName: string; url: string; line: number; selfTimeMs: number; samples: number }>();
	const samples = profile.samples ?? [];
	const timeDeltas = profile.timeDeltas ?? [];
	let elapsedMs = 0;
	for (let index = 0; index < samples.length; index += 1) {
		const durationMicros = Number.isFinite(timeDeltas[index]) && (timeDeltas[index] ?? 0) > 0
			? (timeDeltas[index] ?? intervalMicros)
			: intervalMicros;
		const sampleStart = elapsedMs;
		const sampleEnd = sampleStart + durationMicros / 1_000;
		elapsedMs = sampleEnd;
		const overlapMs = Math.max(0, Math.min(endMs, sampleEnd) - Math.max(startMs, sampleStart));
		if (overlapMs <= 0) continue;
		const node = nodes.get(samples[index] ?? -1);
		if (!node) continue;
		const identity = profileFunctionSymbol(node);
		const current = totals.get(identity.symbol) ?? { ...identity, selfTimeMs: 0, samples: 0 };
		current.selfTimeMs += overlapMs;
		current.samples += 1;
		totals.set(identity.symbol, current);
	}
	return totals;
}

function sortedFunctions(
	values: Iterable<{ symbol: string; functionName: string; url: string; line: number; selfTimeMs: number; samples: number }>,
): ProfileFunction[] {
	const items = [...values].filter(item => item.selfTimeMs > 0).sort((left, right) => right.selfTimeMs - left.selfTimeMs || left.symbol.localeCompare(right.symbol));
	const total = items.reduce((sum, item) => sum + item.selfTimeMs, 0);
	return items.map(item => ({ ...item, share: total > 0 ? item.selfTimeMs / total : 0 }));
}

export function aggregateSelfTime(profile: CpuProfile, samplingIntervalMicros = profile.samplingInterval ?? 100): ProfileFunction[] {
	return sortedFunctions(indexedSelfTime(profile, 0, Number.POSITIVE_INFINITY, samplingIntervalMicros).values());
}

export function selectFunctionsAtOrAboveShare(functions: ProfileFunction[], minimumShare = 0.05): ProfileFunction[] {
	return functions.filter(item => item.share >= minimumShare);
}

export function sliceProfileByWindows(
	profile: CpuProfile,
	marks: HarnessMark[],
	intervalMicros = profile.samplingInterval ?? 100,
): WindowSummary[] {
	return marks.map(mark => {
		const functions = sortedFunctions(indexedSelfTime(profile, Math.max(0, mark.startMs), Math.max(mark.startMs, mark.endMs), intervalMicros).values());
		return {
			scenario: mark.scenario,
			name: mark.name,
			kind: mark.kind,
			...(mark.sessionId === undefined ? {} : { sessionId: mark.sessionId }),
			...(mark.toolName === undefined ? {} : { toolName: mark.toolName }),
			startMs: mark.startMs,
			endMs: mark.endMs,
			totalSelfTimeMs: functions.reduce((sum, item) => sum + item.selfTimeMs, 0),
			functions,
		};
	});
}

function isTypeScriptFunction(item: ProfileFunction): boolean {
	return /\.(?:[cm]?tsx?|mts|cts)(?:[?#:]|$)/i.test(item.url);
}

function packageForUrl(url: string): string | undefined {
	const normalized = url.replaceAll("\\", "/");
	const packageIndex = normalized.lastIndexOf("/packages/");
	if (packageIndex < 0) return undefined;
	const rest = normalized.slice(packageIndex + "/packages/".length);
	return rest.split("/")[0] || undefined;
}

function toProfilerSamples(functions: ProfileFunction[]): ProfilerSelfTimeSample[] {
	return functions.map(item => ({
		symbol: item.symbol,
		selfTimeMs: item.selfTimeMs,
		...(packageForUrl(item.url) ? { package: packageForUrl(item.url) } : {}),
	}));
}

function cpuProfileFilePath(repositoryRoot: string, outputDirectory: string, name: string): string {
	return path.relative(repositoryRoot, path.join(outputDirectory, `${name}.cpuprofile`)).split(path.sep).join("/");
}

function getGitProvenance(repositoryRoot: string): { sha: string; dirty: boolean; fingerprint: string } {
	const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repositoryRoot });
	const sha = new TextDecoder().decode(revision.stdout).trim();
	if (revision.exitCode !== 0 || !/^[0-9a-f]{40}$/i.test(sha)) throw new Error("Could not resolve full git HEAD SHA");
	const status = Bun.spawnSync(["git", "status", "--porcelain=v1", "-z"], { cwd: repositoryRoot });
	if (status.exitCode !== 0) throw new Error("Could not resolve git worktree provenance");
	const statusBytes = new Uint8Array(status.stdout);
	return { sha, dirty: statusBytes.length > 0, fingerprint: sha256Hex(statusBytes) };
}

function createPerfCorpusReport(options: {
	baseReport: PerfCorpusReport;
	repositoryRoot: string;
	outputDirectory: string;
	manifest: CorpusManifest;
	profiles: Record<string, CpuProfile>;
	marks: HarnessMark[];
	measurements: Record<string, FixtureMeasurement>;
}): PerfCorpusReport {

	const replayProfile = options.profiles.replay;
	if (!replayProfile) return options.baseReport;
	const sessionMarks = options.marks.filter(mark => mark.scenario === "replay" && mark.kind === "scenario" && mark.sessionId !== undefined);
	const replayFixtures: PerfCorpusFixtureResult[] = options.manifest.entries.map(entry => {
		const measurement = options.measurements[entry.id];
		if (!measurement) throw new Error(`Replay metrics missing for corpus session ${entry.id}`);
		const mark = sessionMarks.find(candidate => candidate.sessionId === entry.id);
		const sliced = mark ? sliceProfileByWindows(replayProfile, [mark])[0]?.functions ?? [] : [];
		const artifactPath = cpuProfileFilePath(options.repositoryRoot, options.outputDirectory, "replay");
		const wallClockPhase: PerfCorpusFixtureResult["wallClockPhase"] = {};
		if (mark) {
			wallClockPhase.replay = {
				elapsedMs: Math.max(0, mark.endMs - mark.startMs),
				startMs: mark.startMs,
				advisoryOnly: true,
			};
		}

		return {
			fixtureId: `replay-${entry.id}`,
			fixtureClass: "streaming-ttft",
			sourceClass: entry.sourceClass,
			workloadTags: ["session-replay", "agent-session", "tui"],
			privacy: { rawPrivateTranscriptCommitted: false, redactionNotes: entry.redactionNotes },
			wallClockPhase,

			processCpuUsage: {
				replay: {
					userMicros: Math.max(0, measurement.userMicros),
					systemMicros: Math.max(0, measurement.systemMicros),
					elapsedMs: Math.max(0, measurement.elapsedMs),
				},
			},
			profilerSelfTime: { profiler: "bun", artifactPath, samples: toProfilerSamples(sliced) },
			rssMemory: {
				baselineBytes: measurement.rssBeforeBytes,
				growthBytes: measurement.rssAfterBytes - measurement.rssBeforeBytes,
				returnBytes: measurement.rssAfterBytes,
			},
			byteParity: {},
		};
	});
	const report: PerfCorpusReport = {
		...options.baseReport,
		fixtures: [...options.baseReport.fixtures, ...replayFixtures],
	};
	const validation = validatePerfCorpusReport(report);
	if (!validation.ok) {
		throw new Error(`perf-corpus-compatible fixture block failed validation:\n${validation.errors.join("\n")}`);
	}
	return report;
}



export function assertCorpusProvenance(manifest: CorpusManifest, replayFidelity: Record<string, ReplayFidelity>): void {
	const realEntries = manifest.entries.filter(entry => entry.sourceClass === "sanitized-real" || entry.sourceClass === "dogfood-redacted");
	const fail = (reason: string): never => {
		throw new CorpusProvenanceInsufficient(reason);
	};
	if (realEntries.length < 3) fail(`Need at least three sanitized-real or dogfood-redacted sessions; found ${realEntries.length}`);
	if (!realEntries.some(entry => entry.assistantTurns >= 50)) fail("No real session has at least 50 assistant turns");
	if (!realEntries.some(entry => {
		const kinds = new Set(entry.toolKinds.map(kind => kind.toLowerCase()));
		return entry.toolCalls >= 20 && kinds.has("read") && kinds.has("edit") && kinds.has("bash") && (kinds.has("grep") || kinds.has("search"));
	})) fail("No real session has at least 20 tool calls covering read, edit, bash, and grep/search");
	if (!realEntries.some(entry => entry.hasCompaction)) fail("No real session contains a compaction");
	const sampledEntries = manifest.entries.filter(entry => Object.hasOwn(replayFidelity, entry.id));
	if (sampledEntries.length === 0) fail("Replay produced no session samples");
	const realSampleCount = sampledEntries.filter(entry => entry.sourceClass === "sanitized-real" || entry.sourceClass === "dogfood-redacted").length;
	if (realSampleCount / sampledEntries.length < 0.6) {
		fail(`Only ${Math.round((realSampleCount / sampledEntries.length) * 100)}% of replay samples are from real sessions; need at least 60%`);
	}
	for (const entry of realEntries) {
		const fidelity = replayFidelity[entry.id];
		if (!fidelity) fail(`Real session ${entry.id} has no replay fidelity record`);
		if (
			fidelity.recordedAssistantTurns !== fidelity.replayedAssistantTurns ||
			fidelity.recordedToolCallSeqSha256 !== fidelity.replayedToolCallSeqSha256 ||
			!fidelity.finalFrameNonEmpty
		) {
			fail(
				`Replay fidelity mismatch for real session ${entry.id}: turns ${fidelity.replayedAssistantTurns}/${fidelity.recordedAssistantTurns}, tools ${fidelity.replayedToolCallSeqSha256 === fidelity.recordedToolCallSeqSha256 ? "match" : "mismatch"}, frame ${fidelity.finalFrameNonEmpty ? "non-empty" : "empty"}`,
			);
		}
	}
}

function formatFunctionTable(functions: ProfileFunction[], limit: number): string[] {
	return functions.slice(0, limit).map(item => `| \`${item.symbol}\` | ${item.selfTimeMs.toFixed(2)} | ${(item.share * 100).toFixed(1)}% |`);
}

export async function buildSessionReplayProfileReport(options: {

	repositoryRoot: string;
	outputDirectory: string;
	manifest: CorpusManifest;
	manifestSha256: string;
	profiles: Record<string, CpuProfile>;
	marks: HarnessMark[];
	replayFidelity: Record<string, ReplayFidelity>;
	measurements: Record<string, FixtureMeasurement>;
	perfCorpusReport: PerfCorpusReport;
	notes?: string[];
	command?: string;
}): Promise<SessionReplayProfileReport> {

	if (options.profiles.replay) assertCorpusProvenance(options.manifest, options.replayFidelity);
	const scenarios: Record<string, ScenarioSummary> = {};
	for (const [name, profile] of Object.entries(options.profiles)) {
		const functions = aggregateSelfTime(profile);
		const totalSelfTimeMs = functions.reduce((sum, item) => sum + item.selfTimeMs, 0);
		scenarios[name] = {
			cpuprofilePath: cpuProfileFilePath(options.repositoryRoot, options.outputDirectory, name),
			totalSelfTimeMs,
			topFunctions: functions.slice(0, 20),
			typescriptFunctionsAtFivePercent: functions.filter(item => isTypeScriptFunction(item) && item.share >= 0.05),
		};
	}
	const windowSummaries = Object.entries(options.profiles).flatMap(([scenario, profile]) =>
		sliceProfileByWindows(profile, options.marks.filter(mark => mark.scenario === scenario)),
	);
	const criticalPaths = {
		startup: windowSummaries.filter(window => window.kind === "startup" || window.kind === "scenario" && window.scenario === "startup"),
		perKeystroke: windowSummaries.filter(window => window.kind === "keystroke"),
		perTokenDelta: windowSummaries.filter(window => window.kind === "token-delta"),
		phases: windowSummaries.filter(window => ["session-load", "session-save", "tool-call", "compaction"].includes(window.kind)),
	};
	const perfCorpusReport = createPerfCorpusReport({
		baseReport: options.perfCorpusReport,
		repositoryRoot: options.repositoryRoot,
		outputDirectory: options.outputDirectory,
		manifest: options.manifest,
		profiles: options.profiles,
		marks: options.marks,
		measurements: options.measurements,
	});

	return {
		schema: "gjc.session-replay-profile/1",
		generatedAt: new Date().toISOString(),
		harness: {
			gitSha: perfCorpusReport.gitSha,
			bunVersion: perfCorpusReport.runner.bunVersion,

			host: { platform: process.platform, arch: process.arch, release: os.release() },
			corpusManifestSha256: options.manifestSha256,
			sanitizerVersion: options.manifest.sanitizerVersion,
			command: options.command ?? "bun run bench:profile -- --scenario all",
			notes: options.notes ?? [],
		},
		scenarios,
		criticalPaths,
		replayFidelity: options.replayFidelity,
		perfCorpusReport,
	};
}


export function renderProfileReportMarkdown(report: SessionReplayProfileReport): string {
	const lines = [
		"# Session replay CPU profile",
		"",
		`- Git SHA: \`${report.harness.gitSha}\``,
		`- Bun: \`${report.harness.bunVersion}\``,
		`- Host: \`${report.harness.host.platform}/${report.harness.host.arch}\` (${report.harness.host.release})`,
		`- Corpus manifest SHA-256: \`${report.harness.corpusManifestSha256}\``,
		`- Sanitizer: \`${report.harness.sanitizerVersion}\``,
		`- Command: \`${report.harness.command}\``,
		"",
	];
	for (const [scenario, result] of Object.entries(report.scenarios)) {
		lines.push(`## ${scenario}`, "", `Profile: \`${result.cpuprofilePath}\``, "", "| Function | Self ms | Share |", "|---|---:|---:|", ...formatFunctionTable(result.topFunctions, 5), "");
		lines.push("TypeScript functions at or above 5% self time:", "");
		if (result.typescriptFunctionsAtFivePercent.length === 0) lines.push("- None sampled.", "");
		else lines.push(...result.typescriptFunctionsAtFivePercent.map(item => `- \`${item.symbol}\`: ${item.selfTimeMs.toFixed(2)} ms (${(item.share * 100).toFixed(1)}%)`), "");
	}
	lines.push("## Critical paths", "");
	for (const [title, windows] of [
		["Startup", report.criticalPaths.startup],
		["Per keystroke", report.criticalPaths.perKeystroke],
		["Per token delta", report.criticalPaths.perTokenDelta],
	] as const) {
		lines.push(`### ${title}`, "");
		if (windows.length === 0) lines.push("- No matching mark windows were recorded.", "");
		for (const window of windows) {
			lines.push(`- \`${window.name}\` (${window.totalSelfTimeMs.toFixed(2)} ms sampled self time)`);
			for (const fn of window.functions.slice(0, 5)) lines.push(`  - \`${fn.symbol}\`: ${fn.selfTimeMs.toFixed(2)} ms (${(fn.share * 100).toFixed(1)}%)`);
		}
		lines.push("");
	}
	lines.push("## Replay fidelity", "", "| Session | Recorded turns | Replayed turns | Tool sequence hash match | Final frame |", "|---|---:|---:|---|---|");
	for (const [id, fidelity] of Object.entries(report.replayFidelity)) {
		lines.push(`| ${id} | ${fidelity.recordedAssistantTurns} | ${fidelity.replayedAssistantTurns} | ${fidelity.recordedToolCallSeqSha256 === fidelity.replayedToolCallSeqSha256 ? "yes" : "no"} | ${fidelity.finalFrameNonEmpty ? "non-empty" : "empty"} |`);
	}
	lines.push("");
	if (report.harness.notes.length > 0) {
		lines.push("## Harness notes", "", ...report.harness.notes.map(note => `- ${note}`), "");
	}
	return `${lines.join("\n")}\n`;
}

function readScenarioFunctions(report: SessionReplayProfileReport): Record<string, ProfileFunction[]> {
	return Object.fromEntries(Object.entries(report.scenarios).map(([name, scenario]) => [name, scenario.topFunctions]));
}

function isSessionReplayProfileReport(value: unknown): value is SessionReplayProfileReport {
	return typeof value === "object" && value !== null && "schema" in value && value.schema === "gjc.session-replay-profile/1";
}

export function compareTopFunctions(
	a: Record<string, Array<{ symbol: string }>> | SessionReplayProfileReport,
	b: Record<string, Array<{ symbol: string }>> | SessionReplayProfileReport,
	n = 10,
): Record<string, number> {

	const left = isSessionReplayProfileReport(a) ? readScenarioFunctions(a) : a;
	const right = isSessionReplayProfileReport(b) ? readScenarioFunctions(b) : b;
	const names = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
	return Object.fromEntries(names.map(name => {
		const leftTop = new Set((left[name] ?? []).slice(0, n).map(item => item.symbol));
		const rightTop = new Set((right[name] ?? []).slice(0, n).map(item => item.symbol));
		return [name, [...leftTop].filter(symbol => rightTop.has(symbol)).length];
	}));
}

function parseCliOptions(argv: string[]): { out?: string; compare?: string; corpus?: string } {
	const options: { out?: string; compare?: string; corpus?: string } = {};
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (flag === "--out" || flag === "--compare" || flag === "--corpus") {
			if (!value) throw new Error(`${flag} requires a value`);
			if (flag === "--out") options.out = value;
			else if (flag === "--compare") options.compare = value;
			else options.corpus = value;
			index += 1;
		} else {
			throw new Error(`Unknown profile-report option: ${flag}`);
		}
	}
	return options;
}

function parseJson<T>(text: string): T {
	return JSON.parse(text) as T;
}

async function compareReports(currentPath: string, otherPath: string): Promise<void> {
	const current = parseJson<SessionReplayProfileReport>(await Bun.file(currentPath).text());
	const other = parseJson<SessionReplayProfileReport>(await Bun.file(otherPath).text());
	const overlaps = compareTopFunctions(current, other);
	let failed = false;
	for (const [scenario, overlap] of Object.entries(overlaps)) {
		process.stdout.write(`${scenario}: ${overlap}/10 top-function overlap\n`);
		if (overlap < 8) failed = true;
	}
	if (failed) process.exitCode = 1;
}

export async function runProfileReportCli(argv = process.argv.slice(2)): Promise<void> {
	const options = parseCliOptions(argv);
	if (options.compare) {
		if (!options.out) throw new Error("--compare requires --out to identify the current report directory");
		await compareReports(path.join(options.out, "report.json"), options.compare);
		return;
	}
	const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
	const git = getGitProvenance(repositoryRoot);
	const outputDirectory = await ensureProfileOutputDirectory(repositoryRoot, options.out, git.sha);
	const baseCorpusDirectory = path.resolve(repositoryRoot, "packages", "coding-agent", "bench", "session-replay", "corpus");
	await loadCorpusManifest(baseCorpusDirectory);
	const manifestPath = path.join(outputDirectory, "corpus-manifest.json");
	const manifest = parseJson<CorpusManifest>(await Bun.file(manifestPath).text());
	const manifestSha256 = (await Bun.file(path.join(outputDirectory, "corpus-manifest.sha256")).text()).trim();
	const perfCorpusReport = parseJson<PerfCorpusReport>(await Bun.file(path.join(outputDirectory, "perf-corpus-report.json")).text());
	const marks = parseJson<HarnessMark[]>(await Bun.file(path.join(outputDirectory, "marks.json")).text());
	const replayFidelity = parseJson<Record<string, ReplayFidelity>>(await Bun.file(path.join(outputDirectory, "replay-fidelity.json")).text());
	const measurements = parseJson<Record<string, FixtureMeasurement>>(await Bun.file(path.join(outputDirectory, "fixture-measurements.json")).text());
	const scenarioNames = [...new Set(marks.map(mark => mark.scenario))];
	const profiles: Record<string, CpuProfile> = {};
	for (const scenario of scenarioNames) {
		profiles[scenario] = parseJson<CpuProfile>(await Bun.file(path.join(outputDirectory, `${scenario}.cpuprofile`)).text());
	}
	const report = await buildSessionReplayProfileReport({ repositoryRoot, outputDirectory, manifest, manifestSha256, profiles, marks, replayFidelity, measurements, perfCorpusReport });
	await Bun.write(path.join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
	await Bun.write(path.join(outputDirectory, "report.md"), renderProfileReportMarkdown(report));
}

if (import.meta.main) {
	runProfileReportCli().catch(error => {
		const name = error instanceof Error ? error.name : "Error";
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`${name}: ${message}\n`);
		process.exitCode = 1;
	});
}
