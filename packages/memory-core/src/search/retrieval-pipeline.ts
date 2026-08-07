import { createHash } from "node:crypto";
import { type ParsedMemoryDocument, parseMemoryDocument } from "../documents/document-parser";
import type { VerificationMetadata } from "../documents/frontmatter";
import { parseMemoryUri } from "../documents/uri";
import { validateMemoryEnvironment } from "../env";
import { invalidInput, type MemoryResult } from "../errors";
import type {
	AuthorityTier,
	ConflictResult,
	MemoryCitation,
	MemoryClaim,
	MemoryEnvironment,
	MemoryIntent,
	MemoryScopeKind,
	RecallInput,
	RecallResult,
	SearchInput,
	SearchResult,
	VolatileClaim,
	Volatility,
} from "../index";
import {
	appendRetrievalLedger,
	type RetrievalLedgerInput,
	type RetrievalLedgerResult,
} from "../ledger/retrieval-ledger";
import { type ParsedMemoryMap, parseMemoryMap } from "../maps/map-parser";
import {
	parseRoutes,
	type RouteConfig,
	type RouteDefinition,
	resolveRoutes,
	type SelectedRoute,
} from "../maps/route-resolver";
import type { MemoryPolicyConfig } from "../policy/config-merge";
import { checkInitializedRoot } from "../policy/initialized";
import { extractClaims } from "../resolution/claim-extractor";
import { resolveConflicts } from "../resolution/conflicts";
import { toVolatileClaim } from "../resolution/volatility";
import { listReadableDirectory } from "../resources/list-readable-directory";
import { readControlResource } from "../resources/read-control-resource";
import { resolveReadableResource } from "../resources/resolve-readable-resource";
import { type ResolvedScopeDescriptor, resolveScopes, type ScopeResolutionResult } from "../scope/scope-resolver";
import { type AliasDefinition, expandAliases } from "./alias-expansion";
import { createSearchBudget, reserveChars, reserveMap, reserveSection, type SearchBudgetState } from "./budget";
import {
	buildCandidateUniverse,
	type CandidateDirectoryEntry,
	type CandidateScopeDescriptor,
	type CandidateUniverseCandidate,
	type CandidateUniverseInput,
} from "./candidate-universe";
import { headingSearch } from "./heading-search";
import { lexicalSearch } from "./lexical-search";
import { metadataSearch } from "./metadata-search";
import { type RankCandidate, type RankRetrievalStage, rankCandidates } from "./ranker";

export interface RetrievalReadableResource {
	readonly content: string;
	readonly digest?: string;
	readonly sha256?: string;
}

export interface RetrievalDependencies {
	readonly scopeResolution?: ScopeResolutionResult;
	readonly list?: CandidateUniverseInput["list"];
	readonly stat?: CandidateUniverseInput["stat"];
	readonly read?: (environment: MemoryEnvironment, uri: string) => Promise<MemoryResult<RetrievalReadableResource>>;
	readonly readMap?: (environment: MemoryEnvironment, uri: string) => Promise<MemoryResult<RetrievalReadableResource>>;
	readonly mapUris?: readonly string[];
	readonly mapContents?: Readonly<Record<string, string>>;
	readonly routesContent?: string;
	readonly readRoutes?: (environment: MemoryEnvironment) => Promise<MemoryResult<{ readonly content: string }>>;
	readonly appendLedger?: (
		environment: MemoryEnvironment,
		input: RetrievalLedgerInput,
	) => Promise<MemoryResult<RetrievalLedgerResult>>;
	readonly policy?: MemoryPolicyConfig;
}

export interface RetrievalPipelineInput {
	readonly environment: MemoryEnvironment;
	readonly query: string;
	readonly intent?: MemoryIntent;
	readonly scopes?: readonly MemoryScopeKind[];
	readonly limit?: number;
	readonly complete?: boolean;
	readonly explain?: boolean;
	readonly dependencies?: RetrievalDependencies;
}

export interface RetrievalSource {
	readonly uri: string;
	readonly scope: MemoryScopeKind;
	readonly relPath: string;
	readonly heading: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly authority: AuthorityTier;
	readonly volatility: Volatility;
	readonly updatedAt: string;
	readonly digest: string;
	readonly score: number;
	readonly stage: RankRetrievalStage;
}

interface MutableStageCounts {
	"map-route": number;
	metadata: number;
	heading: number;
	lexical: number;
	fuzzy: number;
}

export interface RetrievalStageCounts {
	readonly "map-route": number;
	readonly metadata: number;
	readonly heading: number;
	readonly lexical: number;
	readonly fuzzy: number;
}

export interface RetrievalExplain {
	readonly scopes: readonly MemoryScopeKind[];
	readonly intent: MemoryIntent;
	readonly routesConsidered: readonly string[];
	readonly stageCounts: RetrievalStageCounts;
	readonly rankingFactors: readonly {
		readonly uri: string;
		readonly score: number;
		readonly stage: RankRetrievalStage;
	}[];
	readonly exclusionReasons: readonly {
		readonly uri: string | null;
		readonly reason: string;
		readonly stage: RankRetrievalStage | null;
	}[];
	readonly mapsRead: number;
	readonly candidateCount: number;
	readonly selectedCount: number;
	readonly sourcesSelected: readonly RetrievalSource[];
	readonly rejectedCount: number;
	readonly budget: SearchBudgetState;
	readonly conflicts: readonly string[];
	readonly hints: readonly string[];
	readonly truncated: boolean;
	readonly timings?: Readonly<{ readonly totalMs: number }>;
}

export interface RetrievalSelectedDocument {
	readonly document: ParsedMemoryDocument;
	readonly citation: MemoryCitation;
}

export interface RetrievalPipelineResult {
	readonly queryId: string;
	readonly query: string;
	readonly intent: MemoryIntent;
	readonly projectKey: string;
	readonly sources: readonly RetrievalSource[];
	readonly truncated: boolean;
	readonly partial: boolean;
	readonly ledgerId: string | null;
	readonly budget: SearchBudgetState;
	readonly explain?: RetrievalExplain;
	/** Internal: parsed documents behind `sources`, used for M3 claim resolution. */
	readonly selectedDocuments: readonly RetrievalSelectedDocument[];
}

interface ScopeEntry {
	readonly scope: ResolvedScopeDescriptor;
	readonly candidate: CandidateScopeDescriptor;
}

interface MapEntry {
	readonly parsed: ParsedMemoryMap;
}

interface DocumentEntry {
	readonly candidate: CandidateUniverseCandidate;
	readonly document: ParsedMemoryDocument;
}

interface SourceSignal {
	readonly stages: Set<RankRetrievalStage>;
	stageScore: number;
	metadataScore: number;
	headingScore: number;
	lexicalScore: number;
	fuzzyScore: number;
	section: ParsedMemoryDocument["sections"][number] | null;
	sectionScore: number;
}

interface Rejection {
	readonly uri: string | null;
	readonly reason: string;
	readonly stage: RankRetrievalStage | null;
}

interface NormalizedQuery {
	readonly query: string;
	readonly asOf: string;
	readonly queryId: string;
}

const MEMORY_INTENTS: readonly MemoryIntent[] = [
	"user-preference",
	"project-convention",
	"architecture-rationale",
	"decision-history",
	"current-task-status",
	"resume-session",
	"person-identity",
	"environment",
	"debugging-history",
	"workflow-policy",
	"generic-recall",
];
const SCOPES: readonly MemoryScopeKind[] = ["global", "project", "session"];
const STRICT_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const STAGE_ORDER: Readonly<Record<RankRetrievalStage, number>> = Object.freeze({
	"map-route": 0,
	metadata: 1,
	heading: 2,
	lexical: 3,
	fuzzy: 4,
});

function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left.normalize("NFC"), "utf8"), Buffer.from(right.normalize("NFC"), "utf8"));
}

function invalid(detail: string): MemoryResult<never> {
	return invalidInput(`retrieval pipeline: ${detail}`);
}

function normalizedText(value: string): string {
	return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

function normalizeQuery(input: RetrievalPipelineInput): MemoryResult<NormalizedQuery> {
	if (typeof input.query !== "string") return invalid("query must be a string");
	const query = normalizedText(input.query);
	if (query.length === 0) return invalid("query must not be empty");
	const asOf = input.environment.asOf ?? input.environment.now.toISOString();
	if (!STRICT_UTC.test(asOf) || !Number.isFinite(Date.parse(asOf))) return invalid("asOf must be strict UTC ISO-8601");
	const digest = createHash("sha256")
		.update(Buffer.from(`${query}${asOf}`, "utf8"))
		.digest("hex");
	return { ok: true, value: Object.freeze({ query, asOf, queryId: `memq_${digest}` }) };
}

function memoryIntent(value: MemoryIntent | undefined): MemoryIntent {
	return value === undefined ? "generic-recall" : value;
}

function validIntent(value: MemoryIntent): boolean {
	return (MEMORY_INTENTS as readonly string[]).includes(value);
}

function validScope(value: MemoryScopeKind): boolean {
	return (SCOPES as readonly string[]).includes(value);
}

const CONTROL_MAP_URI = "memory://global/MEMORY.md";
const CONTROL_ROUTES_NAME = "routes.yaml" as const;

function memoryUriToPublic(value: string): string | null {
	if (typeof value !== "string") return null;
	const match = /^memory:\/\/(global|project|session)\/(.*)$/u.exec(value.normalize("NFC"));
	if (match === null || match[2].length === 0) return null;
	const scope = match[1] as MemoryScopeKind;
	const remainder = match[2];
	const hash = remainder.indexOf("#");
	const pathPart = hash < 0 ? remainder : remainder.slice(0, hash);
	const fragment = hash < 0 ? "" : remainder.slice(hash);
	if (pathPart.length === 0) return null;
	const publicValue = `${scope}://${pathPart}${fragment}`;
	const parsed = parseMemoryUri(publicValue);
	return parsed.ok ? parsed.value.href : publicValue;
}

function publicUriWithoutFragment(value: string): string {
	const hash = value.indexOf("#");
	return hash < 0 ? value : value.slice(0, hash);
}

function canonicalCandidateUri(value: string): string {
	const parsed = parseMemoryUri(value.normalize("NFC"));
	return parsed.ok ? parsed.value.href : value.normalize("NFC");
}

async function defaultList(
	environment: MemoryEnvironment,
	scope: CandidateScopeDescriptor,
	relPath: string,
): Promise<readonly CandidateDirectoryEntry[]> {
	const listed = listReadableDirectory(
		environment,
		{ kind: scope.kind as MemoryScopeKind, root: scope.root },
		relPath,
	);
	if (!listed.ok) throw new Error(listed.error.code);
	return listed.value;
}

function routeDefinitionFromMap(route: ParsedMemoryMap["routes"][number], index: number): RouteDefinition {
	const id = `map-${route.sourceIndex.toString(10)}-${index.toString(10)}`;
	return Object.freeze({
		id,
		targets: Object.freeze([route.uri]),
		aliases: route.aliases,
		intents: route.intents,
		scopes: Object.freeze([]),
		queryTokens: Object.freeze([]),
		default: false,
		sourceIndex: index,
	});
}

function syntheticRouteConfig(routes: readonly RouteDefinition[]): RouteConfig {
	return Object.freeze({ version: 1, routes: Object.freeze([...routes]), defaults: Object.freeze([]) });
}

function fullSection(document: ParsedMemoryDocument): ParsedMemoryDocument["sections"][number] | null {
	return document.sections[0] ?? null;
}

function sectionForFragment(
	document: ParsedMemoryDocument,
	fragment: string | null,
): ParsedMemoryDocument["sections"][number] | null {
	if (fragment === null || fragment.length === 0) return fullSection(document);
	const normalized = normalizedText(fragment);
	return (
		document.sections.find(
			section => normalizedText(section.slug) === normalized || normalizedText(section.heading) === normalized,
		) ?? null
	);
}

function bodySection(
	document: ParsedMemoryDocument,
	tokens: readonly string[],
): ParsedMemoryDocument["sections"][number] | null {
	if (tokens.length === 0) return fullSection(document);
	for (const section of document.sections) {
		const values = new Set(
			section.body.length === 0
				? []
				: section.body
						.normalize("NFC")
						.toLowerCase()
						.split(/[^\p{L}\p{N}]+/u)
						.filter(token => token.length > 0),
		);
		if (tokens.some(token => values.has(token))) return section;
	}
	return fullSection(document);
}

function stageFromSignals(signals: SourceSignal): RankRetrievalStage {
	let selected: RankRetrievalStage = "fuzzy";
	for (const stage of signals.stages) if (STAGE_ORDER[stage] < STAGE_ORDER[selected]) selected = stage;
	return selected;
}

function sourceText(document: ParsedMemoryDocument, section: ParsedMemoryDocument["sections"][number] | null): string {
	return section === null ? document.normalizedContent : section.content;
}

function sourceCitation(
	document: ParsedMemoryDocument,
	section: ParsedMemoryDocument["sections"][number] | null,
	rankedScore: number,
	stage: RankRetrievalStage,
): RetrievalSource {
	const citation =
		section === null
			? document.citation
			: (document.citations.find(
					value => value.heading === section.heading && value.startLine === section.startLine,
				) ?? document.citation);
	return Object.freeze({
		uri: citation.uri,
		scope: citation.scope,
		relPath: citation.relPath,
		heading: citation.heading,
		startLine: citation.startLine,
		endLine: citation.endLine,
		authority: citation.authority,
		volatility: citation.volatility,
		updatedAt: citation.updatedAt,
		digest: citation.digest,
		score: rankedScore,
		stage,
	});
}

function rejectionForError(error: { readonly code: string }): string {
	return `resource-${error.code}`.replace(/[^A-Za-z0-9._-]/gu, "-");
}

function sourceLimit(value: number | undefined): number {
	if (value === undefined || !Number.isSafeInteger(value) || value <= 0) return 20;
	return Math.min(20, value);
}

function explainRecord(
	counts: RetrievalStageCounts,
	mapsRead: number,
	candidateCount: number,
	selectedCount: number,
	rejectedCount: number,
	budget: SearchBudgetState,
	truncated: boolean,
	input: RetrievalPipelineInput,
	routesConsidered: readonly string[],
	sources: readonly RetrievalSource[],
	rejections: readonly Rejection[],
	elapsedMs: number,
): RetrievalExplain {
	return Object.freeze({
		scopes: Object.freeze([...(input.scopes ?? ["global", "project", "session"])]),
		intent: memoryIntent(input.intent),
		routesConsidered: Object.freeze([...routesConsidered]),
		stageCounts: Object.freeze({ ...counts }),
		rankingFactors: Object.freeze(
			sources.map(source => Object.freeze({ uri: source.uri, score: source.score, stage: source.stage })),
		),
		exclusionReasons: Object.freeze(rejections.map(rejection => Object.freeze({ ...rejection }))),
		mapsRead,
		candidateCount,
		selectedCount,
		sourcesSelected: Object.freeze([...sources]),
		rejectedCount,
		budget,
		conflicts: Object.freeze([]),
		hints: Object.freeze([]),
		truncated,
		...(input.environment.deterministic ? {} : { timings: Object.freeze({ totalMs: elapsedMs }) }),
	});
}

async function readDefault(
	environment: MemoryEnvironment,
	uri: string,
): Promise<MemoryResult<RetrievalReadableResource>> {
	const result = await resolveReadableResource(environment, uri);
	if (!result.ok) return result;
	const value = result.value;
	return {
		ok: true,
		value: Object.freeze({
			content: value.content,
			digest: "digest" in value && typeof value.digest === "string" ? value.digest : undefined,
			sha256: "sha256" in value && typeof value.sha256 === "string" ? value.sha256 : undefined,
		}),
	};
}

async function readMapContent(
	input: RetrievalPipelineInput,
	uri: string,
): Promise<MemoryResult<RetrievalReadableResource>> {
	const dependencies = input.dependencies;
	const mapContents = dependencies?.mapContents;
	const injectedMapControl =
		mapContents !== undefined || dependencies?.mapUris !== undefined || dependencies?.readMap !== undefined;
	if (mapContents !== undefined && Object.hasOwn(mapContents, uri)) {
		const content = mapContents[uri];
		return typeof content === "string"
			? { ok: true, value: Object.freeze({ content }) }
			: invalid("map content must be a string");
	}
	const publicUri = memoryUriToPublic(uri);
	if (mapContents !== undefined && publicUri !== null && Object.hasOwn(mapContents, publicUri)) {
		const content = mapContents[publicUri];
		return typeof content === "string"
			? { ok: true, value: Object.freeze({ content }) }
			: invalid("map content must be a string");
	}
	if (dependencies?.readMap !== undefined) return dependencies.readMap(input.environment, uri);
	if (injectedMapControl && dependencies?.read !== undefined) return dependencies.read(input.environment, uri);
	if (injectedMapControl) return readDefault(input.environment, publicUri ?? uri);
	if (publicUri !== "global://MEMORY.md") return invalid("map URI is not the fixed control resource");
	const control = readControlResource(input.environment, "MEMORY.md");
	if (!control.ok) return control;
	return {
		ok: true,
		value: Object.freeze({
			content: control.value.content,
			digest: control.value.digest,
			sha256: control.value.sha256,
		}),
	};
}

async function resolveScopeEntries(input: RetrievalPipelineInput): Promise<
	MemoryResult<{
		readonly resolution: ScopeResolutionResult;
		readonly entries: readonly ScopeEntry[];
	}>
> {
	const injectedResolution = input.dependencies?.scopeResolution;
	const resolved: MemoryResult<ScopeResolutionResult> =
		injectedResolution === undefined ? resolveScopes(input.environment) : { ok: true, value: injectedResolution };
	if (!resolved.ok) return resolved;
	const requested = input.scopes ?? SCOPES;
	if (!Array.isArray(requested) || requested.length === 0) return invalid("scopes must be a non-empty array");
	const unique: MemoryScopeKind[] = [];
	for (const value of requested) {
		if (!validScope(value)) return invalid(`unknown scope ${String(value)}`);
		if (!unique.includes(value)) unique.push(value);
	}
	const entries: ScopeEntry[] = [];
	for (const scope of resolved.value.scopes) {
		if (!unique.includes(scope.kind) || !scope.available || scope.root === null) continue;
		const uriPrefix =
			scope.kind === "global"
				? "global://"
				: scope.kind === "project"
					? `project://${resolved.value.project.encodedKey}/`
					: `session://${resolved.value.sessionId ?? ""}/`;
		entries.push(
			Object.freeze({
				scope,
				candidate: Object.freeze({ kind: scope.kind, root: scope.root, uriPrefix }),
			}),
		);
	}
	return { ok: true, value: Object.freeze({ resolution: resolved.value, entries: Object.freeze(entries) }) };
}

function createEmptyCounts(): MutableStageCounts {
	return { "map-route": 0, metadata: 0, heading: 0, lexical: 0, fuzzy: 0 };
}

function addSignal(
	signals: Map<string, SourceSignal>,
	uri: string,
	stage: RankRetrievalStage,
	score: number,
	section: ParsedMemoryDocument["sections"][number] | null,
	sectionScore: number,
): void {
	const existing = signals.get(uri) ?? {
		stages: new Set<RankRetrievalStage>(),
		stageScore: 0,
		metadataScore: 0,
		headingScore: 0,
		lexicalScore: 0,
		fuzzyScore: 0,
		section: null,
		sectionScore: 0,
	};
	existing.stages.add(stage);
	switch (stage) {
		case "map-route":
			existing.stageScore = Math.max(existing.stageScore, score);
			break;
		case "metadata":
			existing.metadataScore = Math.max(existing.metadataScore, score);
			break;
		case "heading":
			existing.headingScore = Math.max(existing.headingScore, score);
			break;
		case "lexical":
			existing.lexicalScore = Math.max(existing.lexicalScore, score);
			break;
		case "fuzzy":
			existing.fuzzyScore = Math.max(existing.fuzzyScore, score);
			break;
	}
	if (
		section !== null &&
		(existing.section === null ||
			sectionScore > existing.sectionScore ||
			(sectionScore === existing.sectionScore && section.startLine < existing.section.startLine))
	) {
		existing.section = section;
		existing.sectionScore = sectionScore;
	}
	signals.set(uri, existing);
}

function candidateByUri(entries: readonly DocumentEntry[]): ReadonlyMap<string, DocumentEntry> {
	return new Map(entries.map(entry => [entry.candidate.uri, entry]));
}

function routeReservation(
	route: SelectedRoute,
	resolution: ScopeResolutionResult,
	scopeEntries: readonly ScopeEntry[],
): {
	readonly scope: string;
	readonly relPath: string;
	readonly stage: "map-route";
	readonly uri: string;
} | null {
	const publicTarget = memoryUriToPublic(route.uri);
	if (publicTarget === null) return null;
	const baseTarget = publicUriWithoutFragment(publicTarget);
	const parsed = parseMemoryUri(baseTarget);
	if (!parsed.ok) return null;
	const entry = scopeEntries.find(candidate => candidate.scope.kind === parsed.value.scheme);
	if (entry === undefined) return null;
	const relative = [...parsed.value.path];
	if (parsed.value.scheme === "project") {
		if (relative.shift() !== resolution.project.encodedKey) return null;
	}
	if (parsed.value.scheme === "session") {
		if (relative.shift() !== resolution.sessionId) return null;
	}
	if (relative.length === 0) return null;
	const relPath = relative.join("/");
	if (!relPath.toLowerCase().endsWith(".md")) return null;
	return Object.freeze({
		scope: entry.scope.kind,
		relPath,
		stage: "map-route",
		uri: canonicalCandidateUri(baseTarget),
	});
}

async function runPipeline(input: RetrievalPipelineInput): Promise<MemoryResult<RetrievalPipelineResult>> {
	// Monotonic: a wall-clock adjustment must never produce a negative duration.
	const startedAt = performance.now();
	const validatedEnvironment = validateMemoryEnvironment(input.environment);
	if (!validatedEnvironment.ok) return validatedEnvironment;
	input = { ...input, environment: validatedEnvironment.value };
	const validated = checkInitializedRoot(input.environment.memoryRoot);
	if (!validated.ok) return validated;
	const normalized = normalizeQuery(input);
	if (!normalized.ok) return normalized;
	if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit <= 0))
		return invalid("limit must be a positive integer");
	if (input.complete !== undefined && typeof input.complete !== "boolean") return invalid("complete must be boolean");
	if (input.explain !== undefined && typeof input.explain !== "boolean") return invalid("explain must be boolean");
	const intent = memoryIntent(input.intent);
	if (!validIntent(intent)) return invalid(`unknown intent ${String(intent)}`);
	const scopesResult = await resolveScopeEntries(input);
	if (!scopesResult.ok) return scopesResult;
	const { resolution, entries: scopeEntries } = scopesResult.value;
	const dependencies = input.dependencies;
	const list: CandidateUniverseInput["list"] =
		dependencies?.list ?? ((scope, relPath) => defaultList(input.environment, scope, relPath));
	const stat = dependencies?.stat;
	const scopeDescriptors = scopeEntries.map(entry => entry.candidate);
	const rejections: Rejection[] = [];
	let controlPartial = false;
	const counts = createEmptyCounts();
	let budget = createSearchBudget(input.dependencies?.policy?.retrieval);
	const injectedMapControl =
		dependencies?.mapUris !== undefined ||
		dependencies?.mapContents !== undefined ||
		dependencies?.readMap !== undefined;
	const mapUris = dependencies?.mapUris ?? (injectedMapControl || dependencies === undefined ? [CONTROL_MAP_URI] : []);
	const maps: MapEntry[] = [];
	const mapsRead: Array<{ readonly uri: string; readonly digest: string | null }> = [];
	for (const mapUri of [...new Set(mapUris.map(value => normalizedText(value)))].sort(compareUtf8)) {
		const reservation = reserveMap(budget, 1, mapUri);
		budget = reservation.state;
		if (!reservation.accepted) {
			rejections.push({ uri: memoryUriToPublic(mapUri), reason: "map-limit", stage: "map-route" });
			continue;
		}
		let content: MemoryResult<RetrievalReadableResource>;
		try {
			content = await readMapContent(input, mapUri);
		} catch {
			controlPartial = true;
			rejections.push({ uri: memoryUriToPublic(mapUri), reason: "map-unavailable", stage: "map-route" });
			continue;
		}
		if (!content.ok) {
			controlPartial = true;
			const reason = content.error.code === "malformed-document" ? "malformed-map" : "map-unavailable";
			rejections.push({ uri: memoryUriToPublic(mapUri), reason, stage: "map-route" });
			continue;
		}
		mapsRead.push({
			uri: memoryUriToPublic(mapUri) ?? mapUri,
			digest: content.value.digest ?? content.value.sha256 ?? null,
		});
		const parsed = parseMemoryMap(content.value.content, mapUri);
		if (!parsed.ok) {
			controlPartial = true;
			rejections.push({ uri: memoryUriToPublic(mapUri), reason: "malformed-map", stage: "map-route" });
			continue;
		}
		maps.push(Object.freeze({ parsed: parsed.value }));
	}

	let routesConfig: RouteConfig = syntheticRouteConfig([]);
	const routeDefinitions: RouteDefinition[] = [];
	for (const map of maps) {
		for (const [index, route] of map.parsed.routes.entries())
			routeDefinitions.push(routeDefinitionFromMap(route, routeDefinitions.length + index));
	}
	let routeContent = dependencies?.routesContent ?? null;
	if (routeContent === null && dependencies?.readRoutes !== undefined) {
		try {
			const readRoutes = await dependencies.readRoutes(input.environment);
			routeContent = readRoutes.ok ? readRoutes.value.content : null;
			if (!readRoutes.ok) {
				controlPartial = true;
				rejections.push({ uri: null, reason: "routes-unavailable", stage: "map-route" });
			}
		} catch {
			controlPartial = true;
			rejections.push({ uri: null, reason: "routes-unavailable", stage: "map-route" });
		}
	} else if (routeContent === null && dependencies === undefined) {
		try {
			const readRoutes = readControlResource(input.environment, CONTROL_ROUTES_NAME);
			if (readRoutes.ok) routeContent = readRoutes.value.content;
			else {
				controlPartial = true;
				const reason = readRoutes.error.code === "malformed-document" ? "malformed-routes" : "routes-unavailable";
				rejections.push({ uri: null, reason, stage: "map-route" });
			}
		} catch {
			controlPartial = true;
			rejections.push({ uri: null, reason: "routes-unavailable", stage: "map-route" });
		}
	}
	if (routeContent !== null) {
		const parsedRoutes = parseRoutes(routeContent);
		if (parsedRoutes.ok) {
			routesConfig = Object.freeze({
				version: 1,
				routes: Object.freeze([...parsedRoutes.value.routes, ...routeDefinitions]),
				defaults: parsedRoutes.value.defaults,
			});
		} else {
			controlPartial = true;
			rejections.push({ uri: null, reason: "malformed-routes", stage: "map-route" });
			routesConfig = syntheticRouteConfig(routeDefinitions);
		}
	} else {
		routesConfig = syntheticRouteConfig(routeDefinitions);
	}
	let routeTruncated = false;
	const routeResolution = resolveRoutes(routesConfig, {
		query: normalized.value.query,
		normalizedQuery: normalized.value.query,
		intent,
		enabledScopes: scopeEntries.map(entry => entry.scope.kind),
	});
	if (!routeResolution.ok) {
		controlPartial = true;
		rejections.push({ uri: null, reason: "route-resolution-failed", stage: "map-route" });
	}
	const selectedRoutes = routeResolution.ok ? routeResolution.value : null;
	if (selectedRoutes !== null) {
		counts["map-route"] = selectedRoutes.selectedRoutes.length;
		if (selectedRoutes.truncated) {
			routeTruncated = true;
			rejections.push({ uri: null, reason: "map-limit", stage: "map-route" });
		}
	}

	const routeReservations: Array<{
		readonly scope: string;
		readonly relPath: string;
		readonly stage: "map-route";
		readonly uri: string;
	}> = [];
	for (const route of selectedRoutes?.selectedRoutes ?? []) {
		const reservation = routeReservation(route, resolution, scopeEntries);
		if (reservation === null) {
			const publicTarget = memoryUriToPublic(route.uri);
			rejections.push({ uri: publicTarget, reason: "route-unavailable", stage: "map-route" });
			continue;
		}
		routeReservations.push(reservation);
	}
	const universe = await buildCandidateUniverse({
		scopes: scopeDescriptors,
		list,
		stat,
		reservations: routeReservations,
		budget,
	});
	if (!universe.ok) return universe;
	budget = universe.value.budget;
	const allCandidates = Object.freeze(
		universe.value.candidates.map(candidate =>
			Object.freeze({ ...candidate, uri: canonicalCandidateUri(candidate.uri) }),
		),
	);
	const docs: DocumentEntry[] = [];
	for (const candidate of allCandidates) {
		let read: MemoryResult<RetrievalReadableResource>;
		try {
			read =
				dependencies?.read !== undefined
					? await dependencies.read(input.environment, candidate.uri)
					: await readDefault(input.environment, candidate.uri);
		} catch {
			rejections.push({ uri: candidate.uri, reason: "resource-unavailable", stage: null });
			continue;
		}
		if (!read.ok) {
			rejections.push({ uri: candidate.uri, reason: rejectionForError(read.error), stage: null });
			continue;
		}
		const parsed = parseMemoryDocument({
			content: read.value.content,
			relPath: candidate.relPath,
			uri: candidate.uri,
		});
		if (!parsed.ok) {
			rejections.push({ uri: candidate.uri, reason: "malformed-document", stage: null });
			continue;
		}
		if (!parsed.value.retrievalEligible || parsed.value.metadata.authority === "unverified") {
			rejections.push({
				uri: candidate.uri,
				reason: parsed.value.retrievalEligible ? "unverified" : "inactive",
				stage: null,
			});
			continue;
		}
		docs.push(Object.freeze({ candidate, document: parsed.value }));
	}
	const byUri = candidateByUri(docs);
	const signals = new Map<string, SourceSignal>();
	const routeResolutionValue = selectedRoutes?.selectedRoutes ?? [];
	for (const route of routeResolutionValue) {
		const publicTarget = memoryUriToPublic(route.uri);
		if (publicTarget === null) continue;
		const baseTarget = publicUriWithoutFragment(publicTarget);
		const entry = byUri.get(baseTarget);
		if (entry === undefined) {
			rejections.push({ uri: publicTarget, reason: "route-unavailable", stage: "map-route" });
			continue;
		}
		const parsedTarget = publicTarget.split("#")[1] ?? null;
		const section = sectionForFragment(entry.document, parsedTarget);
		if (parsedTarget !== null && section === null) {
			rejections.push({ uri: publicTarget, reason: "route-stale-fragment", stage: "map-route" });
			continue;
		}
		addSignal(signals, entry.candidate.uri, "map-route", 1_000_000, section, 1_000_000);
	}

	const metadataInput = docs.map(entry => ({
		uri: entry.candidate.uri,
		metadata: { aliases: entry.document.metadata.aliases, type: entry.document.metadata.type },
		aliases: entry.document.metadata.aliases,
		type: entry.document.metadata.type,
	}));
	const metadata = metadataSearch(normalized.value.query, metadataInput, { intent });
	if (!metadata.ok) return metadata;
	counts.metadata = metadata.value.hits.length;
	for (const hit of metadata.value.hits) {
		const entry = byUri.get(hit.uri);
		if (entry !== undefined) addSignal(signals, hit.uri, "metadata", hit.score, null, hit.score);
	}

	const headings = headingSearch(
		normalized.value.query,
		docs.map(entry => ({ uri: entry.candidate.uri, sections: entry.document.sections })),
	);
	if (!headings.ok) return headings;
	counts.heading = headings.value.hits.length;
	for (const hit of headings.value.hits) {
		const entry = byUri.get(hit.uri);
		if (entry === undefined) continue;
		const section =
			entry.document.sections.find(value => value.slug === hit.slug && value.startLine === hit.startLine) ?? null;
		addSignal(signals, hit.uri, "heading", hit.score, section, hit.score);
	}

	const lexical = lexicalSearch(
		normalized.value.query,
		docs.map(entry => ({ uri: entry.candidate.uri, text: entry.document.body })),
	);
	if (!lexical.ok) return lexical;
	counts.lexical = lexical.value.hits.length;
	for (const hit of lexical.value.hits) {
		const entry = byUri.get(hit.uri);
		if (entry === undefined) continue;
		const section = bodySection(entry.document, hit.matchedTokens);
		addSignal(signals, hit.uri, "lexical", hit.score, section, hit.score);
	}

	const aliasDefinitions: AliasDefinition[] = docs.map(entry => ({
		term: entry.document.metadata.type,
		aliases: entry.document.metadata.aliases,
	}));
	const expansions = expandAliases(normalized.value.query, aliasDefinitions, 16);
	const expansionByTerm = new Map<string, number>();
	for (const expansion of expansions) {
		for (const value of [expansion.term, expansion.alias]) {
			const key = normalizedText(value);
			expansionByTerm.set(key, Math.max(expansionByTerm.get(key) ?? 0, expansion.score));
		}
	}
	for (const entry of docs) {
		const values = [entry.document.metadata.type, ...entry.document.metadata.aliases].map(normalizedText);
		let score = 0;
		for (const value of values) score = Math.max(score, expansionByTerm.get(value) ?? 0);
		if (score <= 0) continue;
		addSignal(signals, entry.candidate.uri, "fuzzy", score, null, score);
	}
	counts.fuzzy = expansions.length;

	const rankInputs: RankCandidate[] = [];
	for (const [uri, signal] of signals) {
		const entry = byUri.get(uri);
		if (entry === undefined) continue;
		rankInputs.push({
			uri,
			stages: [...signal.stages].sort((left, right) => STAGE_ORDER[left] - STAGE_ORDER[right]),
			stageScore: signal.stageScore > 0 ? signal.stageScore : undefined,
			metadataScore: signal.metadataScore,
			headingScore: signal.headingScore,
			lexicalScore: signal.lexicalScore,
			fuzzyScore: signal.fuzzyScore,
			authority: entry.document.metadata.authority,
			scope: entry.document.metadata.scope,
			updatedAt: entry.document.metadata.updated,
			volatility: entry.document.metadata.volatility,
		});
	}
	const ranked = rankCandidates(rankInputs, { asOf: normalized.value.asOf });
	if (!ranked.ok) return ranked;
	const limit = sourceLimit(input.limit);
	let contentTruncated = false;
	const sources: RetrievalSource[] = [];
	// Claim resolution must see every ranked match, not only the citations that
	// fit the source limit: a competing claim in a lower-ranked document is
	// exactly the AC-12 conflict case that must never be silently dropped.
	const selectedDocuments: RetrievalSelectedDocument[] = [];
	const claimDocumentUris = new Set<string>();
	for (const rankedCandidate of ranked.value) {
		const entry = byUri.get(rankedCandidate.uri);
		const signal = signals.get(rankedCandidate.uri);
		if (entry === undefined || signal === undefined) continue;
		if (claimDocumentUris.has(rankedCandidate.uri)) continue;
		claimDocumentUris.add(rankedCandidate.uri);
		const citation = sourceCitation(entry.document, signal.section, rankedCandidate.score, stageFromSignals(signal));
		selectedDocuments.push(Object.freeze({ document: entry.document, citation }));
	}
	for (const rankedCandidate of ranked.value) {
		if (sources.length >= limit) break;
		const entry = byUri.get(rankedCandidate.uri);
		const signal = signals.get(rankedCandidate.uri);
		if (entry === undefined || signal === undefined) continue;
		const section = signal.section;
		const sectionReservation = reserveSection(budget, 1, rankedCandidate.uri);
		budget = sectionReservation.state;
		if (!sectionReservation.accepted) continue;
		const text = sourceText(entry.document, section);
		const remainingChars = Math.max(0, budget.limits.maxChars - budget.usage.chars);
		const amount = Math.min([...text].length, remainingChars);
		if ([...text].length > remainingChars) contentTruncated = true;
		const charsReservation = reserveChars(budget, amount, rankedCandidate.uri);
		budget = charsReservation.state;
		if (!charsReservation.accepted) continue;
		const citation = sourceCitation(entry.document, section, rankedCandidate.score, stageFromSignals(signal));
		sources.push(citation);
	}
	const truncated =
		contentTruncated ||
		routeTruncated ||
		budget.truncated ||
		universe.value.truncated ||
		sources.length < Math.min(limit, ranked.value.length);
	const partial = controlPartial || truncated;
	if (input.complete === true && partial)
		return {
			ok: false,
			error: { code: "truncated", exitCode: 10, detail: "retrieval result was partial or budget was exhausted" },
		};
	const selectedSources = sources.map(source => ({
		uri: source.uri,
		digest: source.digest,
		startLine: source.startLine,
		endLine: source.endLine,
		stage: source.stage,
		authority: source.authority,
		volatility: source.volatility,
		heading: source.heading,
	}));
	const ledgerInput: RetrievalLedgerInput = {
		query: normalized.value.query,
		intent,
		scopes: scopeEntries.map(entry => entry.scope.kind),
		mapsRead,
		selectedSources,
		rejections: rejections.map(rejection => ({
			uri: rejection.uri,
			reason: rejection.reason,
			stage: rejection.stage,
		})),
		budget,
		truncated,
	};
	const ledger =
		input.dependencies?.policy?.ledger.enabled === false
			? ({
					ok: true,
					value: Object.freeze({ ledgerId: null, written: false, relPath: null }),
				} as const)
			: input.dependencies?.appendLedger
				? await input.dependencies.appendLedger(input.environment, ledgerInput)
				: await appendRetrievalLedger(input.environment, ledgerInput);
	if (!ledger.ok) return ledger;
	const explain =
		input.explain === true
			? explainRecord(
					counts,
					mapsRead.length,
					allCandidates.length,
					sources.length,
					rejections.length,
					budget,
					truncated,
					input,
					routeResolution.ok ? routeResolution.value.selectedRoutes.map(route => route.uri) : [],
					sources,
					rejections,
					Math.max(0, Math.round(performance.now() - startedAt)),
				)
			: undefined;
	return {
		ok: true,
		value: Object.freeze({
			queryId: normalized.value.queryId,
			query: normalized.value.query,
			intent,
			projectKey: resolution.project.encodedKey.length === 0 ? "global-only" : resolution.project.encodedKey,
			sources: Object.freeze(sources),
			selectedDocuments: Object.freeze(selectedDocuments),
			truncated,
			partial,
			ledgerId: ledger.value.ledgerId,
			budget,
			...(explain === undefined ? {} : { explain }),
		}),
	};
}

function isRetrievalPipelineInput(value: RetrievalPipelineInput | MemoryEnvironment): value is RetrievalPipelineInput {
	return Object.hasOwn(value, "environment");
}

export function runRetrievalPipeline(input: RetrievalPipelineInput): Promise<MemoryResult<RetrievalPipelineResult>>;
export function runRetrievalPipeline(
	environment: MemoryEnvironment,
	input: SearchInput | RecallInput,
	dependencies?: RetrievalDependencies,
): Promise<MemoryResult<RetrievalPipelineResult>>;
export async function runRetrievalPipeline(
	first: RetrievalPipelineInput | MemoryEnvironment,
	second?: SearchInput | RecallInput,
	third?: RetrievalDependencies,
): Promise<MemoryResult<RetrievalPipelineResult>> {
	if (first === null || typeof first !== "object" || Array.isArray(first)) return invalid("input must be an object");
	if (second !== undefined) {
		if (isRetrievalPipelineInput(first)) return invalid("environment must be supplied separately");
		return runPipeline({ ...second, environment: first, dependencies: third });
	}
	if (!isRetrievalPipelineInput(first)) return invalid("environment is required");
	return runPipeline(first);
}

export async function searchMemory(
	environment: MemoryEnvironment,
	input: SearchInput,
	dependencies?: RetrievalDependencies,
): Promise<MemoryResult<SearchResult>> {
	const result = await runPipeline({ ...input, environment, dependencies });
	if (!result.ok) return result;
	return {
		ok: true,
		value: Object.freeze({
			schemaVersion: "gajae.memory.search-result.v1",
			queryId: result.value.queryId,
			query: result.value.query,
			sources: result.value.sources,
			truncated: result.value.truncated,
			partial: result.value.partial,
			ledgerId: result.value.ledgerId,
			budget: result.value.budget,
			...(result.value.explain === undefined ? {} : { explain: result.value.explain }),
		}),
	};
}

/**
 * Resolve claims for the documents behind the selected sources (M3). Claim
 * extraction and conflict resolution are deterministic and read no bytes of
 * their own; they consume the already policy-verified parsed documents.
 */
function verificationOf(document: ParsedMemoryDocument): VerificationMetadata | null {
	return document.metadata.verification ?? null;
}

interface ResolvedRecallClaims {
	readonly resolutions: readonly ConflictResult[];
	readonly conflicts: readonly ConflictResult[];
	readonly volatileClaims: readonly VolatileClaim[];
	/** Claim keys only, for the explain receipt: never claim text. */
	readonly volatileClaimKeys: readonly string[];
}

function resolveRecallClaims(
	selected: readonly RetrievalSelectedDocument[],
	asOf: string,
): MemoryResult<ResolvedRecallClaims> {
	const claims: MemoryClaim[] = [];
	// Verification metadata belongs to the claim's own document. Two selected
	// documents can produce the same claim key, so the hint travels with each
	// extracted claim instead of being keyed by claim key alone.
	const verified: Array<{ readonly claim: MemoryClaim; readonly verification: VerificationMetadata | null }> = [];
	for (const entry of selected) {
		const extracted = extractClaims(entry.document, { source: entry.citation });
		if (!extracted.ok) return extracted;
		const verification = verificationOf(entry.document);
		for (const claim of extracted.value) {
			claims.push(claim);
			verified.push({ claim, verification });
		}
	}
	const resolved = resolveConflicts(claims, { asOf });
	if (!resolved.ok) return resolved;
	const resolutions: ConflictResult[] = [];
	const conflicts: ConflictResult[] = [];
	for (const result of resolved.value) {
		if (result.requiresUserConfirmation || result.resolution === null) conflicts.push(result);
		else if (result.conflict) resolutions.push(result);
	}
	const volatileClaims: VolatileClaim[] = [];
	const seenVolatile = new Set<string>();
	const volatileClaimKeys: string[] = [];
	for (const pair of verified) {
		if (pair.claim.volatility !== "volatile") continue;
		const volatile = toVolatileClaim(pair.claim, pair.verification);
		if (!volatile.ok) return volatile;
		const key = JSON.stringify(volatile.value);
		if (seenVolatile.has(key)) continue;
		seenVolatile.add(key);
		volatileClaims.push(volatile.value);
		if (volatile.value.verificationRequired && !volatileClaimKeys.includes(pair.claim.claimKey)) {
			volatileClaimKeys.push(pair.claim.claimKey);
		}
	}
	return {
		ok: true,
		value: Object.freeze({
			resolutions: Object.freeze(resolutions),
			conflicts: Object.freeze(conflicts),
			volatileClaims: Object.freeze(volatileClaims),
			volatileClaimKeys: Object.freeze(volatileClaimKeys),
		}),
	};
}

export async function recallMemory(
	environment: MemoryEnvironment,
	input: RecallInput,
	dependencies?: RetrievalDependencies,
): Promise<MemoryResult<RecallResult>> {
	const result = await runPipeline({ ...input, environment, dependencies });
	if (!result.ok) return result;
	const asOf = environment.asOf ?? environment.now.toISOString();
	const resolved = resolveRecallClaims(result.value.selectedDocuments, asOf);
	if (!resolved.ok) return resolved;
	const status =
		resolved.value.conflicts.length > 0 ? "conflict" : result.value.sources.length === 0 ? "no-match" : "matched";
	// The pipeline cannot see claim resolution, so the explain receipt learns the
	// conflict and volatile-verification keys here. Only claim keys travel, never
	// claim values, so no private or restricted body text is duplicated.
	const explain =
		result.value.explain === undefined
			? undefined
			: Object.freeze({
					...result.value.explain,
					conflicts: Object.freeze(resolved.value.conflicts.map(conflict => conflict.claimKey)),
					hints: Object.freeze([...resolved.value.volatileClaimKeys]),
				});
	return {
		ok: true,
		value: Object.freeze({
			schemaVersion: "gajae.memory.recall.v1",
			queryId: result.value.queryId,
			query: result.value.query,
			intent: result.value.intent,
			projectKey: result.value.projectKey,
			status,
			sources: result.value.sources,
			resolutions: resolved.value.resolutions,
			conflicts: resolved.value.conflicts,
			volatileClaims: resolved.value.volatileClaims,
			truncated: result.value.truncated,
			partial: result.value.partial,
			ledgerId: result.value.ledgerId,
			budget: result.value.budget,
			...(explain === undefined ? {} : { explain }),
		}),
	};
}

export const retrieve = runRetrievalPipeline;
export const search = searchMemory;
export const recall = recallMemory;
