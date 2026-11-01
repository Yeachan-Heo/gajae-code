/**
 * Time Traveling Stream Rules (TTSR) Manager
 *
 * Manages rules that get injected mid-stream when their condition pattern matches
 * the agent's output. When a match occurs, the stream is aborted, the rule is
 * injected as a system reminder, and the request is retried.
 *
 * Rules may also carry `astCondition` ast-grep patterns, which are evaluated
 * against the source a write/edit tool call introduces, before it executes.
 */
import * as path from "node:path";
import { AstMatchStrictness, astMatch } from "@gajae-code/natives";
import { logger } from "@gajae-code/utils";
import type { Rule } from "../capability/rule";
import type { TtsrSettings } from "../config/settings";

export type TtsrMatchSource = "text" | "thinking" | "tool";

/** Context about the stream content currently being checked against TTSR rules. */
export interface TtsrMatchContext {
	source: TtsrMatchSource;
	/** Tool name for tool argument deltas, e.g. "edit" or "write". */
	toolName?: string;
	/** Candidate file paths associated with the current stream chunk. */
	filePaths?: string[];
	/** Stable key to isolate buffering (for example a tool call ID). */
	streamKey?: string;
}

/** An astCondition pattern parse issue observed while checking a target language. */
export interface TtsrAstConditionDiagnostic {
	ruleName: string;
	lang: string;
	patterns: string[];
	parseErrors: string[];
}

interface ToolScope {
	toolName?: string;
	pathGlob?: Bun.Glob;
	pathPattern?: string;
}

interface TtsrScope {
	allowText: boolean;
	allowThinking: boolean;
	allowAnyTool: boolean;
	toolScopes: ToolScope[];
}

interface TtsrEntry {
	rule: Rule;
	conditions: RegExp[];
	conditionWindows: Array<number | undefined>;
	astConditions?: string[];

	scope: TtsrScope;
	globalPathGlobs?: Bun.Glob[];
}

/** Tracks when a rule was last injected (for repeat gating). */
export interface TtsrInjectionRecord {
	name: string;
	lastInjectedAt: number;
	repeatMode?: "once" | "after-gap";
	repeatGap?: number;
}

interface InjectionRecord {
	/** Message count (turn index) when the rule was last injected. */
	lastInjectedAt: number;
	repeatMode?: "once" | "after-gap";
	repeatGap?: number;
}

const DEFAULT_SETTINGS: Required<TtsrSettings> = {
	enabled: true,
	contextMode: "discard",
	interruptMode: "always",
	repeatMode: "once",
	repeatGap: 10,
};

const SAFE_REGEX_WINDOW_CAP = 4096;
const SAFE_REGEX_WINDOW_MULTIPLIER = 4;
const SOURCE_SYNTAX_PARSE_ERROR = "parse error (syntax tree contains error nodes)";

const DEFAULT_SCOPE: TtsrScope = {
	allowText: true,
	allowThinking: false,
	allowAnyTool: true,
	toolScopes: [],
};

export class TtsrManager {
	readonly #settings: Required<TtsrSettings>;
	readonly #rules = new Map<string, TtsrEntry>();
	readonly #injectionRecords = new Map<string, InjectionRecord>();
	readonly #astConditionDiagnostics = new Map<string, TtsrAstConditionDiagnostic>();
	readonly #buffers = new Map<string, string>();
	readonly #lastAstSnapshots = new Map<string, string>();
	#messageCount = 0;

	constructor(settings?: Partial<TtsrSettings>) {
		this.#settings = { ...DEFAULT_SETTINGS, ...settings };
	}

	/** Check if a rule can be triggered based on repeat settings. */
	#canTrigger(ruleName: string): boolean {
		const record = this.#injectionRecords.get(ruleName);
		if (!record) {
			return true;
		}

		const entry = this.#rules.get(ruleName);
		const repeatMode = entry?.rule.repeatMode ?? record.repeatMode ?? this.#settings.repeatMode;
		if (repeatMode === "once") {
			return false;
		}

		const repeatGap = entry?.rule.repeatGap ?? record.repeatGap ?? this.#settings.repeatGap;
		const gap = this.#messageCount - record.lastInjectedAt;
		return gap >= repeatGap;
	}

	#compileConditions(rule: Rule): RegExp[] {
		const compiled: RegExp[] = [];
		for (const pattern of rule.condition ?? []) {
			try {
				compiled.push(new RegExp(pattern));
			} catch (error) {
				logger.warn("TTSR condition has invalid regex pattern, skipping condition", {
					ruleName: rule.name,
					pattern,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		return compiled;
	}

	#conditionWindow(condition: RegExp): number | undefined {
		const source = condition.source;
		if (source.length === 0 || source.length > SAFE_REGEX_WINDOW_CAP) {
			return undefined;
		}
		// Quantifiers (*, +, {n,}) and anchors/lookaround/backrefs can make a match's
		// witness exceed a bounded window, so fall back to full-buffer scanning (always
		// correct) for those patterns rather than risk silently missing a match.
		if (/[$^*+{]|\\[bBAZz]|\\[1-9]|\(\?/.test(source)) {
			return undefined;
		}
		return Math.min(SAFE_REGEX_WINDOW_CAP, Math.max(1, source.length * SAFE_REGEX_WINDOW_MULTIPLIER));
	}

	#compileGlobalPathGlobs(globs: Rule["globs"]): Bun.Glob[] | undefined {
		if (!globs || globs.length === 0) {
			return undefined;
		}

		const compiled = globs
			.map(glob => glob.trim())
			.filter(glob => glob.length > 0)
			.map(glob => new Bun.Glob(glob));
		return compiled.length > 0 ? compiled : undefined;
	}

	#parseToolScopeToken(token: string): ToolScope | undefined {
		const match = /^(?:(?<prefix>tool)(?::(?<tool>[a-z0-9_-]+))?|(?<bare>[a-z0-9_-]+))(?:\((?<path>[^)]+)\))?$/i.exec(
			token,
		);
		if (!match) {
			return undefined;
		}

		const groups = match.groups;
		const hasToolPrefix = groups?.prefix !== undefined;
		const toolName = (groups?.tool ?? (hasToolPrefix ? undefined : groups?.bare))?.trim().toLowerCase();
		const pathPattern = groups?.path?.trim();

		if (!pathPattern) {
			return { toolName };
		}

		return {
			toolName,
			pathPattern,
			pathGlob: new Bun.Glob(pathPattern),
		};
	}

	#buildScope(rule: Rule): TtsrScope {
		if (!rule.scope || rule.scope.length === 0) {
			return {
				allowText: DEFAULT_SCOPE.allowText,
				allowThinking: DEFAULT_SCOPE.allowThinking,
				allowAnyTool: DEFAULT_SCOPE.allowAnyTool,
				toolScopes: [...DEFAULT_SCOPE.toolScopes],
			};
		}

		const scope: TtsrScope = {
			allowText: false,
			allowThinking: false,
			allowAnyTool: false,
			toolScopes: [],
		};

		for (const rawToken of rule.scope) {
			const token = rawToken.trim();
			const normalizedToken = token.toLowerCase();
			if (token.length === 0) {
				continue;
			}

			if (normalizedToken === "text") {
				scope.allowText = true;
				continue;
			}

			if (normalizedToken === "thinking") {
				scope.allowThinking = true;
				continue;
			}

			if (normalizedToken === "tool" || normalizedToken === "toolcall") {
				scope.allowAnyTool = true;
				continue;
			}

			const toolScope = this.#parseToolScopeToken(token);
			if (!toolScope) {
				logger.warn("TTSR scope token is invalid, skipping token", {
					ruleName: rule.name,
					token: rawToken,
				});
				continue;
			}

			if (!toolScope.toolName && !toolScope.pathGlob) {
				scope.allowAnyTool = true;
				continue;
			}

			scope.toolScopes.push(toolScope);
		}

		return scope;
	}

	#hasReachableScope(scope: TtsrScope): boolean {
		return scope.allowText || scope.allowThinking || scope.allowAnyTool || scope.toolScopes.length > 0;
	}

	#bufferKey(context: TtsrMatchContext): string {
		if (context.streamKey && context.streamKey.trim().length > 0) {
			return context.streamKey;
		}
		if (context.source !== "tool") {
			return context.source;
		}
		const toolName = context.toolName?.trim().toLowerCase();
		return toolName ? `tool:${toolName}` : "tool";
	}

	#normalizePath(pathValue: string): string {
		return pathValue.replaceAll("\\", "/");
	}

	#matchesGlob(glob: Bun.Glob, filePaths: string[] | undefined): boolean {
		if (!filePaths || filePaths.length === 0) {
			return false;
		}
		for (const filePath of filePaths) {
			const normalized = this.#normalizePath(filePath);
			if (glob.match(normalized)) {
				return true;
			}
			const slashIndex = normalized.lastIndexOf("/");
			const basename = slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
			if (basename !== normalized && glob.match(basename)) {
				return true;
			}
		}

		return false;
	}

	#matchesGlobalPaths(entry: TtsrEntry, context: TtsrMatchContext): boolean {
		if (!entry.globalPathGlobs || entry.globalPathGlobs.length === 0) {
			return true;
		}

		for (const glob of entry.globalPathGlobs) {
			if (this.#matchesGlob(glob, context.filePaths)) {
				return true;
			}
		}

		return false;
	}

	#matchesScope(entry: TtsrEntry, context: TtsrMatchContext): boolean {
		if (context.source === "text") {
			return entry.scope.allowText;
		}

		if (context.source === "thinking") {
			return entry.scope.allowThinking;
		}

		if (entry.scope.allowAnyTool) {
			return true;
		}

		const toolName = context.toolName?.trim().toLowerCase();
		for (const toolScope of entry.scope.toolScopes) {
			if (toolScope.toolName && toolScope.toolName !== toolName) {
				continue;
			}
			if (toolScope.pathGlob && !this.#matchesGlob(toolScope.pathGlob, context.filePaths)) {
				continue;
			}
			return true;
		}

		return false;
	}

	#matchesCondition(entry: TtsrEntry, streamBuffer: string): boolean {
		for (let i = 0; i < entry.conditions.length; i++) {
			const condition = entry.conditions[i];
			const window = entry.conditionWindows[i];
			const target = window === undefined ? streamBuffer : streamBuffer.slice(-window);
			condition.lastIndex = 0;
			if (condition.test(target)) {
				return true;
			}
		}
		return false;
	}

	/** Check if TTSR is disabled for this manager. */
	#isDisabled(): boolean {
		return this.#settings.enabled === false;
	}

	/** Add a TTSR rule to be monitored. */
	addRule(rule: Rule): boolean {
		if (this.#isDisabled()) {
			return false;
		}
		if (this.#rules.has(rule.name)) {
			return false;
		}

		const conditions = this.#compileConditions(rule);
		const astConditions = rule.astCondition ?? [];

		// Rule must have either regex or AST conditions
		if (conditions.length === 0 && astConditions.length === 0) {
			return false;
		}

		const scope = this.#buildScope(rule);
		if (!this.#hasReachableScope(scope)) {
			logger.warn("TTSR scope excludes all streams, skipping rule", {
				ruleName: rule.name,
				scope: rule.scope,
			});
			return false;
		}
		const globalPathGlobs = this.#compileGlobalPathGlobs(rule.globs);
		const conditionWindows = conditions.map(condition => this.#conditionWindow(condition));
		this.#rules.set(rule.name, {
			rule,
			conditions,
			conditionWindows,
			astConditions: astConditions.length > 0 ? astConditions : undefined,
			scope,
			globalPathGlobs,
		});

		logger.debug("TTSR rule registered", {
			ruleName: rule.name,
			conditions: rule.condition,
			astConditions: rule.astCondition,
			scope: rule.scope,
			globs: rule.globs,
		});

		return true;
	}

	/**
	 * Add a stream chunk to its scoped buffer and return matching rules.
	 *
	 * Buffers are isolated by source/tool key so matches don't bleed across
	 * assistant prose, thinking text, and unrelated tool argument streams.
	 */
	checkDelta(delta: string, context: TtsrMatchContext): Rule[] {
		if (this.#isDisabled()) {
			return [];
		}
		const bufferKey = this.#bufferKey(context);
		const nextBuffer = `${this.#buffers.get(bufferKey) ?? ""}${delta}`;
		this.#buffers.set(bufferKey, nextBuffer);

		const matches: Rule[] = [];
		for (const [name, entry] of this.#rules) {
			if (!this.#canTrigger(name)) {
				continue;
			}
			if (!this.#matchesScope(entry, context)) {
				continue;
			}
			if (!this.#matchesGlobalPaths(entry, context)) {
				continue;
			}
			if (!this.#matchesCondition(entry, nextBuffer)) {
				continue;
			}

			matches.push(entry.rule);
			logger.debug("TTSR condition matched", {
				ruleName: name,
				conditions: entry.rule.condition,
				source: context.source,
				toolName: context.toolName,
				filePaths: context.filePaths,
			});
		}

		return matches;
	}

	/** Mark rules as injected (won't trigger again until conditions allow). */
	markInjected(rulesToMark: Rule[]): void {
		this.markInjectedByNames(rulesToMark.map(rule => rule.name));
	}

	/** Mark rule names as injected (won't trigger again until conditions allow). */
	markInjectedByNames(ruleNames: string[]): void {
		for (const rawName of ruleNames) {
			const ruleName = rawName.trim();
			if (ruleName.length === 0) {
				continue;
			}
			const entry = this.#rules.get(ruleName);
			const nextRecord: InjectionRecord = {
				lastInjectedAt: this.#messageCount,
				repeatMode: entry?.rule.repeatMode ?? this.#settings.repeatMode,
				repeatGap: entry?.rule.repeatGap ?? this.#settings.repeatGap,
			};
			this.#injectionRecords.set(ruleName, nextRecord);

			logger.debug("TTSR rule marked as injected", {
				ruleName,
				messageCount: this.#messageCount,
				repeatMode: nextRecord.repeatMode,
			});
		}
	}

	/** Get names of all injected rules (for persistence). */
	getInjectedRuleNames(): string[] {
		return Array.from(this.#injectionRecords.keys());
	}

	/**
	 * Undo a provisional claim whose reminder was never delivered: restore the
	 * record the rule had before the claim, or forget it when it had none, so the
	 * rule is eligible again exactly as before.
	 */
	releaseInjected(ruleName: string, previous: TtsrInjectionRecord | undefined): void {
		const name = ruleName.trim();
		if (name.length === 0) return;
		if (!previous) {
			this.#injectionRecords.delete(name);
			return;
		}
		this.#injectionRecords.set(name, {
			lastInjectedAt: previous.lastInjectedAt,
			repeatMode: previous.repeatMode,
			repeatGap: previous.repeatGap,
		});
	}

	/** Get full injected rule records (for persistence). */
	getInjectedRecords(): TtsrInjectionRecord[] {
		return Array.from(this.#injectionRecords, ([name, record]) => ({ name, ...record }));
	}

	/** Restore injected state from legacy rule names or persisted records. */
	restoreInjected(records: string[] | TtsrInjectionRecord[]): void {
		if (this.#isDisabled()) {
			return;
		}
		for (const record of records) {
			if (typeof record === "string") {
				this.#injectionRecords.set(record, { lastInjectedAt: 0 });
				continue;
			}
			const name = record.name.trim();
			if (name.length === 0) continue;
			this.#injectionRecords.set(name, {
				lastInjectedAt: Number.isFinite(record.lastInjectedAt) ? record.lastInjectedAt : 0,
				repeatMode: record.repeatMode,
				repeatGap: record.repeatGap,
			});
		}
		if (records.length > 0) {
			logger.debug("TTSR injected state restored", { records });
		}
	}

	/** Reset stream buffers (called on new turn). */
	resetBuffer(): void {
		this.#buffers.clear();
		this.#lastAstSnapshots.clear();
	}

	/** Check if any TTSR rules are registered. */
	hasRules(): boolean {
		if (this.#isDisabled()) {
			return false;
		}
		return this.#rules.size > 0;
	}

	/** Increment message counter (call after each turn). */
	incrementMessageCount(): void {
		this.#messageCount++;
	}

	/** Get current message count. */
	getMessageCount(): number {
		return this.#messageCount;
	}

	/** Restore message counter after session resume. */
	restoreMessageCount(messageCount: number): void {
		if (this.#isDisabled()) {
			return;
		}
		this.#messageCount = Math.max(0, Math.floor(messageCount));
	}

	/** Get settings. */
	getSettings(): Required<TtsrSettings> {
		return this.#settings;
	}

	/** Check if any registered rule carries an `astCondition`. */
	hasAstRules(): boolean {
		if (this.#isDisabled()) {
			return false;
		}
		for (const entry of this.#rules.values()) {
			if (entry.astConditions) {
				return true;
			}
		}
		return false;
	}

	/** Get observed astCondition pattern parse issues for rule diagnostics. */
	getAstConditionDiagnostics(): TtsrAstConditionDiagnostic[] {
		return Array.from(this.#astConditionDiagnostics.values(), diagnostic => ({
			...diagnostic,
			patterns: [...diagnostic.patterns],
			parseErrors: [...diagnostic.parseErrors],
		}));
	}

	/** Derive an ast-grep language alias from the candidate file extensions. */
	#deriveLang(filePaths: string[] | undefined): string | undefined {
		for (const filePath of filePaths ?? []) {
			const ext = path.extname(this.#normalizePath(filePath));
			if (ext.length > 1) return ext.slice(1).toLowerCase();
		}
		return undefined;
	}

	/** Match the source introduced by finalized tool arguments, before execution. */
	async checkAstSnapshot(snapshot: string, context: TtsrMatchContext, signal?: AbortSignal): Promise<Rule[]> {
		if (this.#isDisabled() || context.source !== "tool" || signal?.aborted) {
			return [];
		}
		const lang = this.#deriveLang(context.filePaths);
		if (!lang) return [];

		const candidates: TtsrEntry[] = [];
		for (const [name, entry] of this.#rules) {
			if (!entry.astConditions?.length) continue;
			if (
				!this.#canTrigger(name) ||
				!this.#matchesScope(entry, context) ||
				!this.#matchesGlobalPaths(entry, context)
			) {
				continue;
			}
			candidates.push(entry);
		}
		if (candidates.length === 0) return [];

		const bufferKey = this.#bufferKey(context);
		if (this.#lastAstSnapshots.get(bufferKey) === snapshot) return [];
		this.#lastAstSnapshots.set(bufferKey, snapshot);

		const matches: Rule[] = [];
		for (const entry of candidates) {
			if (!entry.astConditions) continue;
			const matched = await this.#astConditionsMatch(entry.rule.name, entry.astConditions, snapshot, lang, signal);
			if (signal?.aborted) return [];
			if (matched) {
				matches.push(entry.rule);
				logger.debug("TTSR ast condition matched", {
					ruleName: entry.rule.name,
					astConditions: entry.rule.astCondition,
					toolName: context.toolName,
					filePaths: context.filePaths,
				});
			}
		}
		return matches;
	}

	#recordAstConditionDiagnostics(
		ruleName: string,
		patterns: string[],
		lang: string,
		parseErrors: string[] | undefined,
	): void {
		const patternParseErrors = parseErrors?.filter(parseError => parseError !== SOURCE_SYNTAX_PARSE_ERROR) ?? [];
		if (patternParseErrors.length === 0) return;

		const key = JSON.stringify([ruleName, lang]);
		if (this.#astConditionDiagnostics.has(key)) return;

		const diagnostic: TtsrAstConditionDiagnostic = {
			ruleName,
			lang,
			patterns: [...patterns],
			parseErrors: patternParseErrors,
		};
		this.#astConditionDiagnostics.set(key, diagnostic);
		logger.warn("TTSR astCondition pattern is invalid for target language", {
			ruleName,
			lang,
			patterns: diagnostic.patterns,
			parseErrors: diagnostic.parseErrors,
		});
	}

	async #astConditionsMatch(
		ruleName: string,
		patterns: string[],
		source: string,
		lang: string,
		signal?: AbortSignal,
	): Promise<boolean> {
		try {
			const result = await astMatch({
				patterns,
				source,
				lang,
				strictness: AstMatchStrictness.Smart,
				limit: 1,
				signal,
			});
			if (!signal?.aborted) {
				this.#recordAstConditionDiagnostics(ruleName, patterns, lang, result.parseErrors);
			}
			return result.totalMatches > 0;
		} catch (error) {
			logger.warn("TTSR ast match failed, treating as no match", {
				ruleName,
				patterns,
				lang,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}
}
