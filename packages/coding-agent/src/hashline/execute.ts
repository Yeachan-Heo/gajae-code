import type { AgentToolResult } from "@gajae-code/agent-core";
import { isEnoent } from "@gajae-code/utils";
import { generateDiffString } from "../edit/diff";
import { getFileReadCache } from "../edit/file-read-cache";
import { detectLineEnding, normalizeToLF, restoreLineEndings, stripBom } from "../edit/normalize";
import { readEditFileText, serializeEditFileText } from "../edit/read-file";
import type { EditToolDetails } from "../edit/renderer";
import type { ToolSession } from "../tools";
import { assertEditableFileContent } from "../tools/auto-generated-guard";
import { invalidateFsScanAfterWrite } from "../tools/fs-cache-invalidation";
import { outputMeta } from "../tools/output-meta";
import { enforcePlanModeWrite, resolvePlanPath } from "../tools/plan-mode-guard";
import { enforceTeamWriteScope, withTeamWriteScopeMutation } from "../tools/team-write-scope";
import { HashlineMismatchError } from "./anchors";
import { applyHashlineEdits, type HashlineApplyResult } from "./apply";
import { buildCompactHashlineDiffPreview } from "./diff-preview";
import { type HashlineInputSection, splitHashlineInputs } from "./input";
import { parseHashlineWithWarnings } from "./parser";
import { tryRecoverHashlineWithCache } from "./recovery";
import type {
	ExecuteHashlineSingleOptions,
	HashlineApplyOptions,
	HashlineEdit,
	hashlineEditParamsSchema,
} from "./types";

interface ReadHashlineFileResult {
	exists: boolean;
	rawContent: string;
}

async function readHashlineFile(absolutePath: string, pathText: string): Promise<ReadHashlineFileResult> {
	try {
		return { exists: true, rawContent: await readEditFileText(absolutePath, pathText) };
	} catch (error) {
		if (isEnoent(error)) return { exists: false, rawContent: "" };
		if (error instanceof Error && error.message === `File not found: ${pathText}`)
			return { exists: false, rawContent: "" };
		throw error;
	}
}

function formatNoChangeDiagnostic(pathText: string): string {
	return `Edits to ${pathText} resulted in no changes being made.`;
}

function getHashlineApplyOptions(session: ToolSession): HashlineApplyOptions {
	return {
		autoDropPureInsertDuplicates: session.settings.get("edit.hashlineAutoDropPureInsertDuplicates"),
	};
}

function getTextContent(result: AgentToolResult<EditToolDetails>): string {
	return result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
}

function getEditDetails(result: AgentToolResult<EditToolDetails>): EditToolDetails {
	return result.details ?? { diff: "" };
}

/**
 * Apply hashline edits with anchor-stale recovery: on `HashlineMismatchError`,
 * consult the read-snapshot cache for the file and 3-way-merge the edits onto
 * the current text. If recovery succeeds, return the merged result with a
 * synthetic warning. Otherwise re-throw the original mismatch error.
 */
function applyHashlineEditsWithRecovery(
	session: ToolSession,
	absolutePath: string,
	text: string,
	edits: HashlineEdit[],
	options: HashlineApplyOptions,
): HashlineApplyResult {
	try {
		return applyHashlineEdits(text, edits, options);
	} catch (err) {
		if (!(err instanceof HashlineMismatchError)) throw err;
		const recovered = tryRecoverHashlineWithCache({
			cache: getFileReadCache(session),
			absolutePath,
			currentText: text,
			edits,
			options,
		});
		if (!recovered) throw err;
		return {
			lines: recovered.lines,
			firstChangedLine: recovered.firstChangedLine,
			warnings: recovered.warnings,
		};
	}
}

/**
 * Run all the front-end checks (notebook guard, parse, plan-mode check, file
 * load, edit application) without writing. Used to fail fast before applying
 * any changes in a multi-section batch.
 */
async function preflightHashlineSection(options: ExecuteHashlineSingleOptions & HashlineInputSection): Promise<void> {
	const { session, path: sectionPath, diff } = options;

	const absolutePath = resolvePlanPath(session, sectionPath);
	const { edits } = parseHashlineWithWarnings(diff);
	enforcePlanModeWrite(session, sectionPath, { op: "update" });
	await enforceTeamWriteScope(session, absolutePath);

	const source = await readHashlineFile(absolutePath, sectionPath);
	if (!source.exists) throw new Error(`File not found: ${sectionPath}. Use the write tool to create new files.`);
	if (source.exists) assertEditableFileContent(source.rawContent, sectionPath);

	const { text } = stripBom(source.rawContent);
	const normalized = normalizeToLF(text);
	const result = applyHashlineEditsWithRecovery(
		session,
		absolutePath,
		normalized,
		edits,
		getHashlineApplyOptions(session),
	);
	if (normalized === result.lines) throw new Error(formatNoChangeDiagnostic(sectionPath));
}

async function executeHashlineSection(
	options: ExecuteHashlineSingleOptions & HashlineInputSection,
	absolutePathOverride?: string,
): Promise<AgentToolResult<EditToolDetails, typeof hashlineEditParamsSchema>> {
	const {
		session,
		path: sourcePath,
		diff,
		signal,
		batchRequest,
		writethrough,
		beginDeferredDiagnosticsForPath,
	} = options;

	const absolutePath = absolutePathOverride ?? resolvePlanPath(session, sourcePath);
	const { edits, warnings: parseWarnings } = parseHashlineWithWarnings(diff);
	enforcePlanModeWrite(session, sourcePath, { op: "update" });

	const source = await readHashlineFile(absolutePath, sourcePath);
	if (!source.exists) throw new Error(`File not found: ${sourcePath}. Use the write tool to create new files.`);
	if (source.exists) assertEditableFileContent(source.rawContent, sourcePath);

	const { bom, text } = stripBom(source.rawContent);
	const originalEnding = detectLineEnding(text);
	const originalNormalized = normalizeToLF(text);
	const result = applyHashlineEditsWithRecovery(
		session,
		absolutePath,
		originalNormalized,
		edits,
		getHashlineApplyOptions(session),
	);

	if (originalNormalized === result.lines) {
		return {
			content: [{ type: "text", text: formatNoChangeDiagnostic(sourcePath) }],
			details: { diff: "", op: "update", meta: outputMeta().get() },
		};
	}

	const finalContent = await serializeEditFileText(
		absolutePath,
		sourcePath,
		bom + restoreLineEndings(result.lines, originalEnding),
	);
	const diagnostics = await writethrough(
		absolutePath,
		finalContent,
		signal,
		Bun.file(absolutePath),
		batchRequest,
		dst => (dst === absolutePath ? beginDeferredDiagnosticsForPath(absolutePath) : undefined),
	);
	invalidateFsScanAfterWrite(absolutePath);
	// The post-edit content is the freshest, most authoritative "model view"
	// of the file: the model just received it back as the diff/preview. Cache
	// it so a follow-up edit anchored against this state can still recover
	// if the file is touched out-of-band before the next edit lands.
	getFileReadCache(session).recordContiguous(absolutePath, 1, result.lines.split("\n"));

	const diffResult = generateDiffString(originalNormalized, result.lines);
	const meta = outputMeta()
		.diagnostics(diagnostics?.summary ?? "", diagnostics?.messages ?? [])
		.get();
	const preview = buildCompactHashlineDiffPreview(diffResult.diff);

	const warnings = [...parseWarnings, ...(result.warnings ?? [])];
	const warningsBlock = warnings.length > 0 ? `\n\nWarnings:\n${warnings.join("\n")}` : "";
	const previewBlock = preview.preview ? `\n${preview.preview}` : "";
	const headline = preview.preview
		? `${sourcePath}:`
		: source.exists
			? `Updated ${sourcePath}`
			: `Created ${sourcePath}`;

	return {
		content: [{ type: "text", text: `${headline}${previewBlock}${warningsBlock}` }],
		details: {
			diff: diffResult.diff,
			firstChangedLine: result.firstChangedLine ?? diffResult.firstChangedLine,
			diagnostics,
			op: source.exists ? "update" : "create",
			meta,
		},
	};
}

export async function executeHashlineSingle(
	options: ExecuteHashlineSingleOptions,
): Promise<AgentToolResult<EditToolDetails, typeof hashlineEditParamsSchema>> {
	const sections = mergeSamePathSections(
		splitHashlineInputs(options.input, { cwd: options.session.cwd, path: options.path }),
	);

	// Fast path: a single section needs no preflight pass.
	if (sections.length === 1) {
		const section = sections[0];
		const absolutePath = resolvePlanPath(options.session, section.path);
		return withTeamWriteScopeMutation(options.session, [absolutePath], ([canonicalPath]) =>
			executeHashlineSection({ ...options, ...section }, canonicalPath),
		);
	}

	// Multi-section: validate everything up front so we don't apply a partial batch.
	for (const section of sections) await preflightHashlineSection({ ...options, ...section });

	const results = [];
	for (const section of sections) {
		const absolutePath = resolvePlanPath(options.session, section.path);
		const result = await withTeamWriteScopeMutation(options.session, [absolutePath], ([canonicalPath]) =>
			executeHashlineSection({ ...options, ...section }, canonicalPath),
		);
		results.push({ path: section.path, result });
	}

	return {
		content: [{ type: "text", text: results.map(({ result }) => getTextContent(result)).join("\n\n") }],
		details: {
			diff: results.map(({ result }) => getEditDetails(result).diff).join("\n"),
			perFileResults: results.map(({ path: resultPath, result }) => {
				const details = getEditDetails(result);
				return {
					path: resultPath,
					diff: details.diff,
					firstChangedLine: details.firstChangedLine,
					diagnostics: details.diagnostics,
					op: details.op,
					move: details.move,
					meta: details.meta,
				};
			}),
		},
	};
}

/**
 * Collapse consecutive or interleaved sections targeting the same path into a
 * single section with concatenated diffs. Anchors authored against the same
 * file snapshot must be applied as one batch; otherwise the first sub-edit
 * shifts line numbers out from under the second's anchors and validation fails.
 * Path order is preserved by first occurrence.
 */
function mergeSamePathSections(sections: HashlineInputSection[]): HashlineInputSection[] {
	const byPath = new Map<string, string[]>();
	for (const section of sections) {
		const existing = byPath.get(section.path);
		if (existing) existing.push(section.diff);
		else byPath.set(section.path, [section.diff]);
	}
	return Array.from(byPath, ([path, diffs]) => ({ path, diff: diffs.join("\n") }));
}
