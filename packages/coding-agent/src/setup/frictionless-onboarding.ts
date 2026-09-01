import type * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@gajae-code/utils";
import { withFileLock } from "../config/file-lock";
import { prepareExternalSessionImport, type SessionImportSourceIdentity } from "../session-import/provider-service";

export type OnboardingDecision = "completed" | "skipped";
export type OnboardingOperation = "learn-commands";

export interface OnboardingProfile {
	language: string;
	sources: string[];
	workflow: string[];
	migrationMap: string[];
	omissions: string[];
	evidenceCount: number;
	operations?: OnboardingOperation[];
}

export interface FrictionlessOnboardingState {
	version: 1;
	decision?: OnboardingDecision;
	profile?: OnboardingProfile;
}

export interface OnboardingRootPresence {
	provider: string;
	present: boolean;
	unsupported: boolean;
	activityAt: number;
	rootPath?: string;
	rootRealPath?: string;
	installedCliActivityAt: number;
	rootIdentity?: SessionImportSourceIdentity;
}

export interface OnboardingEvidence {
	provider: string;
	activityAt: number;
	signals: string[];
	userMessages?: string[];
	sessionCount?: number;
	omittedSessions?: number;
	workflowCategories?: string[];
}

const ROOTS = ["codex", "claude", "opencode", "omp", "omo"] as const;
export const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
const MAX_ARRAY_ITEMS = 16;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_DISCOVERY_ENTRIES = 512;
const MAX_SESSION_CANDIDATES = 4;
const MAX_STRING_LENGTH = 500;
/**
 * Function words matched on token boundaries for space-delimited languages.
 * Substring matching is prohibited here: two-letter articles such as `le`, `la`
 * and `el` occur inside ordinary English words (`file`, `please`, `class`,
 * `help`), which used to hand French or Spanish a majority on plain English.
 */
const WORD_LANGUAGES: Record<string, readonly string[]> = {
	en: ["the", "and", "please", "file", "change", "help"],
	es: ["el", "la", "por", "favor", "archivo", "cambio"],
	fr: ["le", "la", "fichier", "merci", "modifier"],
	de: ["der", "die", "datei", "bitte", "ändern"],
};

/** Languages identified by script: their text is unspaced or agglutinative, so word lists never match. */
const SCRIPT_LANGUAGES: ReadonlyArray<{ language: string; pattern: RegExp }> = [
	{ language: "ko", pattern: /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/g },
	{ language: "ja", pattern: /[\u3040-\u30ff]/g },
	{ language: "zh", pattern: /[\u3400-\u4dbf\u4e00-\u9fff]/g },
];

const SUPPORTED_LANGUAGES: ReadonlySet<string> = new Set([
	...Object.keys(WORD_LANGUAGES),
	...SCRIPT_LANGUAGES.map(entry => entry.language),
]);

/** Minimum matches before message evidence outranks the OS locale. */
const LANGUAGE_EVIDENCE_MINIMUM = 2;

export function onboardingStatePath(agentDir = getAgentDir()): string {
	return path.join(agentDir, "onboarding", "frictionless.json");
}

function boundedStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) return undefined;
	if (!value.every(item => typeof item === "string" && item.length <= MAX_STRING_LENGTH)) return undefined;
	return [...value];
}

function validProfile(value: unknown): value is OnboardingProfile {
	if (!value || typeof value !== "object") return false;
	const profile = value as Record<string, unknown>;
	const sources = boundedStringArray(profile.sources);
	const workflow = boundedStringArray(profile.workflow);
	const migrationMap = boundedStringArray(profile.migrationMap);
	const omissions = boundedStringArray(profile.omissions);
	const operations = boundedStringArray(profile.operations);
	return (
		typeof profile.language === "string" &&
		profile.language.length <= 16 &&
		sources !== undefined &&
		workflow !== undefined &&
		migrationMap !== undefined &&
		omissions !== undefined &&
		(typeof profile.operations === "undefined" ||
			operations?.every(operation => operation === "learn-commands") === true) &&
		typeof profile.evidenceCount === "number" &&
		Number.isInteger(profile.evidenceCount) &&
		profile.evidenceCount >= 0 &&
		profile.evidenceCount <= MAX_ARRAY_ITEMS
	);
}

export function projectOnboardingState(value: unknown): FrictionlessOnboardingState {
	if (!value || typeof value !== "object") return { version: 1 };
	const input = value as Record<string, unknown>;
	const decision = input.decision === "completed" || input.decision === "skipped" ? input.decision : undefined;
	if (!validProfile(input.profile)) return { version: 1, ...(decision ? { decision } : {}) };
	const profile = input.profile;
	return {
		version: 1,
		...(decision ? { decision } : {}),
		profile: {
			language: profile.language,
			sources: [...profile.sources],
			workflow: [...profile.workflow],
			migrationMap: [...profile.migrationMap],
			omissions: [...profile.omissions],
			evidenceCount: profile.evidenceCount,
			...(profile.operations ? { operations: [...profile.operations] } : {}),
		},
	};
}

export async function readOnboardingState(agentDir = getAgentDir()): Promise<FrictionlessOnboardingState> {
	try {
		const statePath = onboardingStatePath(agentDir);
		const stat = await fs.lstat(statePath);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) return { version: 1 };
		return projectOnboardingState(JSON.parse(await Bun.file(statePath).text()));
	} catch {
		return { version: 1 };
	}
}

export async function writeOnboardingState(value: unknown, agentDir = getAgentDir()): Promise<boolean> {
	const target = onboardingStatePath(agentDir);
	const temporary = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
	try {
		await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
		await withFileLock(target, async () => {
			const handle = await fs.open(temporary, "wx", 0o600);
			try {
				await handle.close();
				await Bun.write(temporary, `${JSON.stringify(projectOnboardingState(value))}\n`);
				await fs.chmod(temporary, 0o600);
				await fs.rename(temporary, target);
				await fs.chmod(target, 0o600);
			} finally {
				try {
					await handle.close();
				} catch {
					// The descriptor is already closed in the normal path.
				}
			}
		});
		return true;
	} catch {
		try {
			await fs.unlink(temporary);
		} catch {
			// Best-effort cleanup only.
		}
		return false;
	}
}

function localeLanguage(locale = Intl.DateTimeFormat().resolvedOptions().locale): string {
	const code = locale.split(/[-_]/)[0]?.toLowerCase();
	return code && SUPPORTED_LANGUAGES.has(code) ? code : "en";
}

function addLanguageScore(scores: Map<string, number>, language: string, amount: number): void {
	if (amount <= 0) return;
	scores.set(language, (scores.get(language) ?? 0) + amount);
}

function scriptScores(text: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const entry of SCRIPT_LANGUAGES) counts.set(entry.language, text.match(entry.pattern)?.length ?? 0);
	const hangul = counts.get("ko") ?? 0;
	const kana = counts.get("ja") ?? 0;
	const han = counts.get("zh") ?? 0;
	const scores = new Map<string, number>();
	// Korean Hangul is decisive only once it reaches the evidence minimum and is
	// at least as strong as kana; an equal sub-threshold Hangul/kana pair leaves
	// dominant Han evidence intact. Japanese kana claims mixed Han whenever it
	// exceeds Hangul, including the lone-kana boundary below that minimum.
	const koreanClaims = hangul >= kana && hangul >= LANGUAGE_EVIDENCE_MINIMUM;
	const japaneseClaims = kana > hangul && kana >= LANGUAGE_EVIDENCE_MINIMUM;
	if (hangul > 0 && hangul >= kana) addLanguageScore(scores, "ko", hangul);
	if (kana > hangul) addLanguageScore(scores, "ja", kana + han);
	else if (hangul === 0 && kana === 0) addLanguageScore(scores, "zh", han);
	else if (!koreanClaims && !japaneseClaims) addLanguageScore(scores, "zh", han);
	return scores;
}

function wordScores(text: string): Map<string, number> {
	const scores = new Map<string, number>();
	for (const token of text.split(/[^\p{L}\p{N}]+/u)) {
		if (!token) continue;
		for (const [language, words] of Object.entries(WORD_LANGUAGES)) {
			if (words.includes(token)) addLanguageScore(scores, language, 1);
		}
	}
	return scores;
}

function leadingLanguage(scores: Map<string, number>): string | undefined {
	const ranked = [...scores.entries()].sort((left, right) => right[1] - left[1]);
	const winner = ranked[0];
	// Shared words (`la` in both fr and es) and a tied script/word mix must not win a coin flip.
	if (!winner || winner[1] < LANGUAGE_EVIDENCE_MINIMUM || winner[1] === ranked[1]?.[1]) return undefined;
	return winner[0];
}

/**
 * Onboarding copy language. An explicit user preference always wins; script
 * counts and Latin function-word hits share one ranking so two Hangul or Han
 * characters cannot override a clearly English transcript. Evidence is trusted
 * only when one language leads outright; everything else falls back to the OS locale.
 */
export function detectOnboardingLanguage(
	messages: readonly string[],
	osLocale?: string,
	preferredLanguage?: string,
): string {
	if (preferredLanguage && SUPPORTED_LANGUAGES.has(preferredLanguage)) return preferredLanguage;
	const sample = messages.slice(-MAX_ARRAY_ITEMS).join("\n").toLowerCase();
	const scores = wordScores(sample);
	for (const [language, amount] of scriptScores(sample)) addLanguageScore(scores, language, amount);
	return leadingLanguage(scores) ?? localeLanguage(osLocale);
}

function sourceIdentity(stat: nodeFs.BigIntStats): SessionImportSourceIdentity {
	return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}

function sameSourceIdentity(left: SessionImportSourceIdentity, right: SessionImportSourceIdentity): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

async function collectSessionCandidates(
	rootPath: string,
	rootRealPath: string,
	provider: "codex" | "claude",
	openDirectory: typeof fs.opendir,
): Promise<{ candidates: Array<{ path: string; identity: SessionImportSourceIdentity }>; omittedEntries: number }> {
	const start = path.join(rootPath, provider === "codex" ? "sessions" : "projects");
	const maxDepth = provider === "codex" ? 5 : 3;
	const queue: Array<{ directory: string; depth: number }> = [{ directory: start, depth: 0 }];
	const candidates: Array<{ path: string; mtimeMs: number; identity: SessionImportSourceIdentity }> = [];
	let inspected = 0;
	let omittedEntries = 0;

	while (queue.length > 0 && inspected < MAX_DISCOVERY_ENTRIES) {
		const current = queue.shift()!;
		let directory: nodeFs.Dir;
		try {
			const identityBefore = await fs.lstat(current.directory, { bigint: true });
			const realPath = await fs.realpath(current.directory);
			const identityAfter = await fs.lstat(current.directory, { bigint: true });
			if (
				!identityBefore.isDirectory() ||
				identityBefore.isSymbolicLink() ||
				!sameSourceIdentity(identityBefore, identityAfter) ||
				!isWithinRoot(realPath, rootRealPath)
			) {
				omittedEntries++;
				continue;
			}
			directory = await openDirectory(current.directory);
		} catch (error) {
			if (shouldCountOnboardingDirectoryFailure(error, current.depth)) omittedEntries++;
			continue;
		}
		try {
			for await (const entry of directory) {
				if (++inspected > MAX_DISCOVERY_ENTRIES) {
					omittedEntries++;
					break;
				}
				const entryPath = path.join(current.directory, entry.name);
				try {
					const identityBefore = await fs.lstat(entryPath, { bigint: true });
					const realPath = await fs.realpath(entryPath);
					const identityAfter = await fs.lstat(entryPath, { bigint: true });
					if (
						identityBefore.isSymbolicLink() ||
						!sameSourceIdentity(identityBefore, identityAfter) ||
						!isWithinRoot(realPath, rootRealPath)
					) {
						omittedEntries++;
						continue;
					}
					if (identityAfter.isDirectory() && current.depth < maxDepth) {
						queue.push({ directory: entryPath, depth: current.depth + 1 });
					} else if (identityAfter.isFile() && entry.name.endsWith(".jsonl")) {
						candidates.push({
							path: entryPath,
							mtimeMs: Number(identityAfter.mtimeMs),
							identity: sourceIdentity(identityAfter),
						});
					}
				} catch {
					omittedEntries++;
				}
			}
		} catch {
			omittedEntries++;
		} finally {
			await directory.close().catch(() => {});
		}
	}

	return {
		candidates: candidates
			.sort((left, right) => right.mtimeMs - left.mtimeMs)
			.slice(0, MAX_SESSION_CANDIDATES)
			.map(candidate => ({ path: candidate.path, identity: candidate.identity })),
		omittedEntries,
	};
}

function isWithinRoot(candidate: string, root: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function shouldCountOnboardingDirectoryFailure(error: unknown, depth: number): boolean {
	return depth > 0 || (error as NodeJS.ErrnoException).code !== "ENOENT";
}

async function installedCliActivityAt(provider: string): Promise<number> {
	const executablePath = Bun.which(provider);
	if (!executablePath) return 0;
	try {
		return (await fs.stat(executablePath)).mtimeMs;
	} catch {
		return 0;
	}
}

export async function discoverOnboardingRootPresence(
	options: { home?: string } = {},
): Promise<OnboardingRootPresence[]> {
	const home = options.home ?? os.homedir();
	const result: OnboardingRootPresence[] = [];
	for (const provider of ROOTS) {
		const rootPath = path.join(home, `.${provider}`);
		const cliActivityAt = await installedCliActivityAt(provider);
		try {
			const identityBefore = await fs.lstat(rootPath, { bigint: true });
			const rootRealPath = await fs.realpath(rootPath);
			const identityAfter = await fs.lstat(rootPath, { bigint: true });
			const safeDirectory =
				identityBefore.isDirectory() &&
				!identityBefore.isSymbolicLink() &&
				sameSourceIdentity(identityBefore, identityAfter);
			result.push({
				provider,
				present: safeDirectory,
				unsupported: safeDirectory && provider !== "codex" && provider !== "claude",
				activityAt: safeDirectory ? Number(identityAfter.mtimeMs) : 0,
				installedCliActivityAt: cliActivityAt,
				...(safeDirectory ? { rootPath, rootRealPath, rootIdentity: sourceIdentity(identityAfter) } : {}),
			});
		} catch {
			result.push({
				provider,
				present: false,
				unsupported: false,
				activityAt: 0,
				installedCliActivityAt: cliActivityAt,
			});
		}
	}
	return result;
}

function classifyWorkflow(text: string): string[] {
	const normalized = text.toLowerCase();
	const categories: string[] = [];
	if (/\b(test|tests|spec|coverage|verify|qa)\b/u.test(normalized)) categories.push("testing");
	if (/\b(bug|fix|error|failure|debug|crash)\b/u.test(normalized)) categories.push("debugging");
	if (/\b(refactor|cleanup|simplify|rename|extract)\b/u.test(normalized)) categories.push("refactoring");
	if (/\b(git|commit|branch|pull request|pr|review)\b/u.test(normalized)) categories.push("version-control");
	if (/\b(doc|docs|readme|documentation)\b/u.test(normalized)) categories.push("documentation");
	if (/\b(model|provider|config|configure|setup|install)\b/u.test(normalized)) categories.push("configuration");
	return categories;
}

export interface AnalyzeOnboardingEvidenceOptions {
	now?: number;
	openDirectory?: typeof fs.opendir;
}

export async function analyzeOnboardingEvidence(
	presence: readonly OnboardingRootPresence[],
	options: AnalyzeOnboardingEvidenceOptions = {},
): Promise<OnboardingEvidence[]> {
	const now = options.now ?? Date.now();
	const openDirectory = options.openDirectory ?? fs.opendir;
	const evidence: OnboardingEvidence[] = [];
	for (const root of presence) {
		if (!root.present) {
			evidence.push({ provider: root.provider, activityAt: 0, signals: ["missing"] });
			continue;
		}
		if (root.unsupported) {
			evidence.push({ provider: root.provider, activityAt: root.activityAt, signals: ["unsupported"] });
			continue;
		}
		if (!root.rootPath || !root.rootRealPath || !root.rootIdentity) {
			evidence.push({ provider: root.provider, activityAt: root.activityAt, signals: ["unavailable"] });
			continue;
		}
		try {
			const identityBefore = await fs.lstat(root.rootPath, { bigint: true });
			const currentRealPath = await fs.realpath(root.rootPath);
			const identityAfter = await fs.lstat(root.rootPath, { bigint: true });
			if (
				!identityBefore.isDirectory() ||
				identityBefore.isSymbolicLink() ||
				!sameSourceIdentity(identityBefore, identityAfter) ||
				!sameSourceIdentity(identityAfter, root.rootIdentity) ||
				currentRealPath !== root.rootRealPath
			) {
				evidence.push({ provider: root.provider, activityAt: root.activityAt, signals: ["unavailable"] });
				continue;
			}
		} catch {
			evidence.push({ provider: root.provider, activityAt: root.activityAt, signals: ["unavailable"] });
			continue;
		}

		const provider = root.provider as "codex" | "claude";
		const discovery = await collectSessionCandidates(root.rootPath, root.rootRealPath, provider, openDirectory);
		const candidates = discovery.candidates;
		const userMessages: string[] = [];
		const workflowCategories = new Set<string>();
		let sessionCount = 0;
		let omittedSessions = discovery.omittedEntries;
		let activityAt = 0;
		for (const candidate of candidates) {
			try {
				const prepared = await prepareExternalSessionImport({
					sourcePath: candidate.path,
					provider,
					expectedIdentity: candidate.identity,
				});
				sessionCount++;
				activityAt = Math.max(activityAt, Date.parse(prepared.conversation.messages.at(-1)?.timestamp ?? "") || 0);
				for (let index = prepared.conversation.messages.length - 1; index >= 0; index--) {
					const message = prepared.conversation.messages[index]!;
					if (message.role !== "user") continue;
					for (const category of classifyWorkflow(message.text)) workflowCategories.add(category);
					const messageAge = now - Date.parse(message.timestamp ?? "");
					if (messageAge >= 0 && messageAge <= NINETY_DAYS && userMessages.length < MAX_ARRAY_ITEMS) {
						userMessages.unshift(message.text.slice(0, MAX_STRING_LENGTH));
					}
				}
			} catch {
				omittedSessions++;
			}
		}
		if (sessionCount > 0) {
			evidence.push({
				provider,
				activityAt,
				signals: ["supported-session"],
				sessionCount,
				...(omittedSessions > 0 ? { omittedSessions } : {}),
				...(workflowCategories.size > 0
					? { workflowCategories: [...workflowCategories].slice(0, MAX_ARRAY_ITEMS) }
					: {}),
				...(userMessages.length > 0 ? { userMessages } : {}),
			});
		} else if (candidates.length > 0 || omittedSessions > 0) {
			evidence.push({ provider, activityAt: root.activityAt, signals: ["unavailable"], omittedSessions });
		} else {
			const rootAge = now - root.activityAt;
			const cliAge = now - root.installedCliActivityAt;
			if (rootAge >= 0 && rootAge <= NINETY_DAYS) {
				evidence.push({
					provider,
					activityAt: root.activityAt,
					signals: ["agent-root", ...(cliAge >= 0 && cliAge <= NINETY_DAYS ? ["installed-cli"] : [])],
				});
			} else evidence.push({ provider, activityAt: root.activityAt, signals: ["stale"] });
		}
	}
	return evidence;
}

export interface DeriveOnboardingProfileOptions {
	now?: number;
	osLocale?: string;
	/** Explicit `ui.language` selection; authoritative over locale and message evidence. */
	preferredLanguage?: string;
}

interface OnboardingProfileText {
	categories: Record<string, string>;
	mapping: string;
	missing: string;
	unsupported: string;
	stale: string;
	unavailable: string;
	partial: string;
	manualMigration: string;
	manualCommands: string;
}

const PROFILE_TEXT: Record<string, OnboardingProfileText> = {
	en: {
		categories: {
			testing: "Testing and verification",
			debugging: "Debugging and fixes",
			refactoring: "Refactoring and cleanup",
			"version-control": "Git and code review",
			documentation: "Documentation",
			configuration: "Provider and project configuration",
			general: "General coding assistance",
		},
		mapping: "use GJC's matching commands, tools, and review flow",
		missing: "source unavailable",
		unsupported: "source is present but unsupported",
		stale: "source is stale",
		unavailable: "analysis unavailable",
		partial: "session files were safely omitted",
		manualMigration: "Map my existing workflow to GJC",
		manualCommands: "Open the GJC command guide",
	},
	ko: {
		categories: {
			testing: "테스트 및 검증",
			debugging: "디버깅 및 수정",
			refactoring: "리팩터링 및 정리",
			"version-control": "Git 및 코드 리뷰",
			documentation: "문서화",
			configuration: "프로바이더 및 프로젝트 설정",
			general: "일반 코딩 지원",
		},
		mapping: "GJC의 관련 명령, 도구 및 리뷰 흐름 사용",
		missing: "소스를 찾을 수 없음",
		unsupported: "소스가 있지만 지원되지 않음",
		stale: "소스가 오래됨",
		unavailable: "분석할 수 없음",
		partial: "세션 파일을 안전하게 제외함",
		manualMigration: "기존 워크플로를 GJC에 매핑",
		manualCommands: "GJC 명령 안내 열기",
	},
	ja: {
		categories: {
			testing: "テストと検証",
			debugging: "デバッグと修正",
			refactoring: "リファクタリングと整理",
			"version-control": "Gitとコードレビュー",
			documentation: "ドキュメント",
			configuration: "プロバイダーとプロジェクト設定",
			general: "一般的なコーディング支援",
		},
		mapping: "対応するGJCコマンド、ツール、レビューフローを使う",
		missing: "ソースがありません",
		unsupported: "ソースは存在しますが未対応です",
		stale: "ソースが古すぎます",
		unavailable: "分析できません",
		partial: "セッションファイルを安全に除外しました",
		manualMigration: "既存ワークフローをGJCに対応付ける",
		manualCommands: "GJCコマンドガイドを開く",
	},
	zh: {
		categories: {
			testing: "测试与验证",
			debugging: "调试与修复",
			refactoring: "重构与清理",
			"version-control": "Git 与代码审查",
			documentation: "文档",
			configuration: "提供商与项目配置",
			general: "通用编码协助",
		},
		mapping: "使用 GJC 中对应的命令、工具和审查流程",
		missing: "来源不可用",
		unsupported: "来源存在但不受支持",
		stale: "来源已过期",
		unavailable: "无法分析",
		partial: "已安全省略会话文件",
		manualMigration: "将现有工作流映射到 GJC",
		manualCommands: "打开 GJC 命令指南",
	},
	es: {
		categories: {
			testing: "Pruebas y verificación",
			debugging: "Depuración y correcciones",
			refactoring: "Refactorización y limpieza",
			"version-control": "Git y revisión de código",
			documentation: "Documentación",
			configuration: "Configuración de proveedores y proyectos",
			general: "Asistencia general de código",
		},
		mapping: "usar los comandos, herramientas y revisiones equivalentes de GJC",
		missing: "fuente no disponible",
		unsupported: "fuente presente pero no compatible",
		stale: "fuente obsoleta",
		unavailable: "análisis no disponible",
		partial: "archivos de sesión omitidos de forma segura",
		manualMigration: "Adaptar mi flujo existente a GJC",
		manualCommands: "Abrir la guía de comandos de GJC",
	},
	fr: {
		categories: {
			testing: "Tests et vérification",
			debugging: "Débogage et corrections",
			refactoring: "Refactorisation et nettoyage",
			"version-control": "Git et revue de code",
			documentation: "Documentation",
			configuration: "Configuration des fournisseurs et projets",
			general: "Assistance générale au code",
		},
		mapping: "utiliser les commandes, outils et revues GJC correspondants",
		missing: "source indisponible",
		unsupported: "source présente mais non prise en charge",
		stale: "source trop ancienne",
		unavailable: "analyse indisponible",
		partial: "fichiers de session omis en toute sécurité",
		manualMigration: "Adapter mon workflow existant à GJC",
		manualCommands: "Ouvrir le guide des commandes GJC",
	},
	de: {
		categories: {
			testing: "Tests und Verifikation",
			debugging: "Debugging und Fehlerbehebung",
			refactoring: "Refactoring und Bereinigung",
			"version-control": "Git und Code-Review",
			documentation: "Dokumentation",
			configuration: "Provider- und Projektkonfiguration",
			general: "Allgemeine Coding-Unterstützung",
		},
		mapping: "passende GJC-Befehle, Werkzeuge und Review-Abläufe nutzen",
		missing: "Quelle nicht verfügbar",
		unsupported: "Quelle vorhanden, aber nicht unterstützt",
		stale: "Quelle ist veraltet",
		unavailable: "Analyse nicht verfügbar",
		partial: "Sitzungsdateien sicher ausgelassen",
		manualMigration: "Meinen bestehenden Workflow auf GJC abbilden",
		manualCommands: "GJC-Befehlsübersicht öffnen",
	},
};

export function deriveOnboardingProfile(
	evidence: readonly OnboardingEvidence[],
	options: DeriveOnboardingProfileOptions = {},
): OnboardingProfile {
	const now = options.now ?? Date.now();
	const sessionEvidence = evidence.filter(item => item.signals.includes("supported-session"));
	const fallbackEvidence = evidence.filter(item => {
		const age = now - item.activityAt;
		return age >= 0 && age <= NINETY_DAYS && item.signals.includes("agent-root");
	});
	const usable =
		sessionEvidence.length > 0
			? sessionEvidence
			: hasCorroboratedRecentEvidence(evidence, now)
				? fallbackEvidence
				: [];
	const language = detectOnboardingLanguage(
		sessionEvidence.flatMap(item => item.userMessages ?? []),
		options.osLocale,
		options.preferredLanguage,
	);
	const text = PROFILE_TEXT[language] ?? PROFILE_TEXT.en!;
	const omissions = evidence
		.filter(item => !usable.includes(item))
		.map(item => {
			if (item.signals.includes("missing")) return `${item.provider}: ${text.missing}.`;
			if (item.signals.includes("unsupported")) return `${item.provider}: ${text.unsupported}.`;
			if (item.signals.includes("stale")) return `${item.provider}: ${text.stale}.`;
			return `${item.provider}: ${text.unavailable}.`;
		});
	for (const item of usable) {
		if (item.omittedSessions) omissions.push(`${item.provider}: ${item.omittedSessions} ${text.partial}.`);
	}
	const sources = usable.map(item => item.provider);
	const categories = [...new Set(usable.flatMap(item => item.workflowCategories ?? []))];
	if (sources.length > 0 && categories.length === 0) categories.push("general");
	const workflow = categories.map(category => text.categories[category] ?? text.categories.general!);
	return {
		language,
		sources,
		workflow,
		migrationMap: sources
			.flatMap(source => workflow.map(item => `${source}: ${item} → ${text.mapping}`))
			.slice(0, MAX_ARRAY_ITEMS),
		omissions,
		evidenceCount: sources.length,
		operations: sources.length ? ["learn-commands"] : [],
	};
}

export function createManualOnboardingProfile(language: string, intent: "migration" | "commands"): OnboardingProfile {
	const text = PROFILE_TEXT[language] ?? PROFILE_TEXT.en!;
	const label = intent === "migration" ? text.manualMigration : text.manualCommands;
	return {
		language,
		sources: ["manual"],
		workflow: [label],
		migrationMap: [`manual → ${label}`],
		omissions: [],
		evidenceCount: 1,
		operations: ["learn-commands"],
	};
}

export function hasCorroboratedRecentEvidence(evidence: readonly OnboardingEvidence[], now = Date.now()): boolean {
	const recent = evidence.filter(item => {
		const age = now - item.activityAt;
		return age >= 0 && age <= NINETY_DAYS && item.signals.includes("agent-root");
	});
	const providers = new Set(recent.map(item => item.provider));
	const signalFamilies = new Set(recent.flatMap(item => item.signals));
	return providers.size >= 2 && signalFamilies.has("agent-root") && signalFamilies.has("installed-cli");
}

export function shouldOfferOnboarding(state: FrictionlessOnboardingState): boolean {
	return state.decision === undefined;
}

export interface AutomaticOnboardingInput {
	normalInteractive: boolean;
	automation?: boolean;
	initialMessage?: string;
	initialMessages: readonly string[];
	initialImages?: readonly unknown[];
	resumeAction?: string;
}

export function shouldOfferAutomaticOnboarding(input: AutomaticOnboardingInput): boolean {
	return (
		input.normalInteractive &&
		!input.automation &&
		!input.initialMessage &&
		input.initialMessages.length === 0 &&
		(input.initialImages?.length ?? 0) === 0 &&
		input.resumeAction === undefined
	);
}

export function shouldPersistCompletion(operation: OnboardingOperation | undefined, confirmed: boolean): boolean {
	return confirmed && operation !== undefined;
}
