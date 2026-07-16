import type { RenderResultOptions as AgentRenderResultOptions } from "@gajae-code/agent-core";
import type { RenderResultOptions as CustomToolRenderResultOptions } from "../extensibility/custom-tools/types";
import type { ToolRenderResultOptions } from "../extensibility/extensions/types";
import type { BashExecutionComponent } from "../modes/components/bash-execution";
import type { BranchSummaryMessageComponent } from "../modes/components/branch-summary-message";
import type { CompactionSummaryMessageComponent } from "../modes/components/compaction-summary-message";
import type { EvalExecutionComponent } from "../modes/components/eval-execution";
import type { buildStatusFooter } from "../modes/components/execution-shared";
import type { ReadToolGroupComponent } from "../modes/components/read-tool-group";
import type { ToolExecutionComponent } from "../modes/components/tool-execution";
import type { TtsrNotificationComponent } from "../modes/components/ttsr-notification";
import type { InteractiveModeContext } from "../modes/types";
import type { CodeCellOptions, MarkdownCellOptions } from "../tui/code-cell";

/**
 * Compile-time boundary guards for expansion-hint capability ownership.
 *
 * Every assertion below references the REAL production contract (context
 * fields, exported option interfaces, or constructor parameter positions via
 * `ConstructorParameters`/`Parameters`), so relaxing any declaration —
 * optional `?`, `| undefined` unions, `any`/`unknown` widening, aliasing, or
 * `Partial<>` re-exports — turns the corresponding assertion into `never` and
 * fails `check:types`. This enforcement is whitespace-, comment-, alias-, and
 * file-placement-independent because it lives in the type system, not in a
 * source scan. The three public option contracts assert the inverse: they must
 * stay OPTIONAL and exact, preserving source compatibility for external
 * constructors; `resolveRenderCapability` in render-utils is the sole boundary
 * that reads the optional public field.
 */
type ExactCapability<T> = undefined extends T
	? never
	: T extends () => boolean
		? (() => boolean) extends T
			? true
			: never
		: never;
type AssertRequiredExact<T, K extends keyof T> = ExactCapability<T[K]>;
type AssertOptionalExact<T, K extends keyof T> = undefined extends T[K]
	? ExactCapability<Exclude<T[K], undefined>> extends true
		? true
		: never
	: never;

// Internal interactive contracts — capability must be required and exact.
const _interactiveModeContext: AssertRequiredExact<InteractiveModeContext, "expandHintCapability"> = true;
const _toolExecutionCtorParam: ExactCapability<ConstructorParameters<typeof ToolExecutionComponent>[6]> = true;
const _bashExecutionCtorParam: ExactCapability<ConstructorParameters<typeof BashExecutionComponent>[3]> = true;
const _evalExecutionCtorParam: ExactCapability<ConstructorParameters<typeof EvalExecutionComponent>[4]> = true;
const _branchSummaryCtorParam: ExactCapability<ConstructorParameters<typeof BranchSummaryMessageComponent>[1]> = true;
const _compactionSummaryCtorParam: ExactCapability<ConstructorParameters<typeof CompactionSummaryMessageComponent>[1]> =
	true;
const _ttsrCtorParam: ExactCapability<ConstructorParameters<typeof TtsrNotificationComponent>[1]> = true;
const _readGroupOptions: AssertRequiredExact<
	ConstructorParameters<typeof ReadToolGroupComponent>[0],
	"expandHintCapability"
> = true;
const _statusFooterOptions: AssertRequiredExact<Parameters<typeof buildStatusFooter>[0], "expandHintCapability"> = true;
const _codeCellOptions: AssertRequiredExact<CodeCellOptions, "expandHintCapability"> = true;
const _markdownCellOptions: AssertRequiredExact<MarkdownCellOptions, "expandHintCapability"> = true;

// Public option contracts — capability must stay optional and exact so external
// constructors do not source-break; the render-utils boundary adapter injects.
const _agentPublicOptions: AssertOptionalExact<AgentRenderResultOptions, "expandHintCapability"> = true;
const _customToolPublicOptions: AssertOptionalExact<CustomToolRenderResultOptions, "expandHintCapability"> = true;
const _extensionPublicOptions: AssertOptionalExact<ToolRenderResultOptions, "expandHintCapability"> = true;

void [
	_interactiveModeContext,
	_toolExecutionCtorParam,
	_bashExecutionCtorParam,
	_evalExecutionCtorParam,
	_branchSummaryCtorParam,
	_compactionSummaryCtorParam,
	_ttsrCtorParam,
	_readGroupOptions,
	_statusFooterOptions,
	_codeCellOptions,
	_markdownCellOptions,
	_agentPublicOptions,
	_customToolPublicOptions,
	_extensionPublicOptions,
];
