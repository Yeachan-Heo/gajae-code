#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ADAPTERS, OPERATIONS, type Operation } from "../src/sdk/protocol/operation-registry";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const inventoryPath = process.env.GJC_SDK_OPERATION_INVENTORY
	? path.resolve(process.env.GJC_SDK_OPERATION_INVENTORY)
	: path.join(repoRoot, "packages/coding-agent/src/sdk/protocol/operation-inventory.generated.json");

/** Reviewed seams deliberately excluded from the public SDK operation surface. */
const LOCKED_EXCLUSIONS: Readonly<Record<string, string>> = {
	"slash_command:settings": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:theme": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:copy": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:changelog": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:help": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:hotkeys": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:agents": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:monitors": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:tree": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:provider": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:logout": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:ssh": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:drop": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:contribute-pr": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:btw": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:debug": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:memory": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:exit": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:notify":
		"interactive diagnostics command; session on/off delegate to the notifications extension, not an SDK ingress seam",
	"slash_command:pet": "visual/local-only command, not a user-facing SDK control seam",
	"slash_command:transcript": "visual/local-only transcript viewer, not a user-facing SDK control seam",
	"slash_command:sessions": "visual/local-only sessions dashboard, not a user-facing SDK control seam",
	"agent_session:constructor": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:nextToolChoice": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:setForcedToolChoice": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getActiveSkillState": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getActiveSkillPhase": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:peekQueueInvoker": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:peekStandingResolveHandler": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:setStandingResolveHandler": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:buildForkContextSeed": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getHindsightSessionState": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:setHindsightSessionState": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:markPlanCompactAbortPending": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:clearPlanCompactAbortPending": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:enqueueCustomMessageDisplay": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:runMidRunMaintenanceForTests": "test-only maintenance seam, not a user-facing SDK control seam",
	"agent_session:estimateMidRunContextTokensForTests": "test-only estimator seam, not a user-facing SDK control seam",
	"agent_session:activeMidRunBarrierCountForTests": "read-only test seam, not a user-facing SDK control seam",
	"agent_session:activeMidRunMaintenanceCountForTests": "read-only test seam, not a user-facing SDK control seam",
	"agent_session:getPendingNextTurnMessagesForTests": "read-only test seam, not a user-facing SDK control seam",
	"agent_session:setCancelAndSubmitAbortOutcomeProviderForTests":
		"test-only cancellation seam, not a user-facing SDK control seam",
	"agent_session:getAgentId": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:emitNotice": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:subscribe": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:dispose": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:closeWriterStrict": "internal ACP lifecycle teardown plumbing, not a user-facing control seam",
	"agent_session:disposeChildSubprocesses": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:waitForIdle": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:awaitPendingContextTransformations":
		"internal context-transformation lifecycle barrier, not a user-facing SDK control seam",
	"agent_session:drainAsyncJobDeliveriesForAcp": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getAsyncDeliveryStateForAcp":
		"internal ACP lifecycle quiescence plumbing, not a user-facing control seam",
	"agent_session:getToolByName": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:registerForegroundBashBackgroundRequestHandler":
		"internal accessor/plumbing, not a user-facing control seam",
	"agent_session:hasForegroundBashBackgroundRequestHandler":
		"internal accessor/plumbing, not a user-facing control seam",
	"agent_session:requestForegroundBashBackground": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getSelectedMCPToolNames": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:isToolDiscoveryEnabled": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getDiscoverableToolSearchIndex": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getSelectedDiscoveredToolNames": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:activateDiscoveredTools": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:refreshSshTool": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:refreshBaseSystemPrompt": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:refreshMCPTools": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:refreshGjcSubskillTools": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:buildDisplaySessionContext": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:convertMessagesToLlm": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:prepareSimpleStreamOptions": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getPlanModeState": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:setPlanModeState": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getGoalModeState": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:setGoalModeState": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:setSdkPlanModeHandler": "internal host lifecycle plumbing for mode.plan.set",
	"agent_session:getWorkflowGateEmitter": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getAskAnswerSource": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:setWorkflowGateEmitter": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:markPlanReferenceSent": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:setPlanReferencePath": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:setClientBridge": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getCheckpointState": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:setCheckpointState": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:sendPlanModeContext": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:sendGoalModeContext": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:resolveRoleModel": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:resolveRoleModelWithThinking": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:setSlashCommands": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:setMCPPromptCommands": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:queueDeferredMessage": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:queueDeferredMessageForTests": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getContextUsageObservabilityForTests": "test-only observability, not a user-facing control seam",
	"agent_session:purgeQueuedCustomMessages": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:clearQueue": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:popLastQueuedMessage": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:cancelAndSubmit": "interactive queue transaction plumbing, not an independent SDK control seam",
	"agent_session:applyCompactionPostAppendForTests": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:continuePersistedHistory": "internal startup lifecycle plumbing, not a user-facing control seam",
	"agent_session:promoteRecoveryHydrationAfterOwnershipReadyFence":
		"internal owner-recovery authority transition after a durable writer fence, never a user-facing SDK operation",
	"agent_session:setActiveModelProfile": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getActiveModelProfile": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getSessionDefaultModelSelector": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:recordResumeDefaultModel": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:setModelTemporary": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:setModelTemporaryForControl":
		"internal Telegram control wrapper over the reviewed model.set seam, not an independent public SDK operation",
	"agent_session:setThinkingLevelForControl":
		"internal Telegram control wrapper over the reviewed thinking.set seam, not an independent public SDK operation",
	"agent_session:getThinkingScopeForControl":
		"internal Telegram control status accessor, not a user-facing SDK operation seam",
	"agent_session:getThinkingVisibility":
		"internal extension and Telegram display accessor, not a user-facing SDK operation seam",
	"agent_session:setThinkingVisibility": "internal extension display mutation without a public SDK registry operation",
	"agent_session:setThinkingVisibilityForControl":
		"internal Telegram control wrapper over display state, not an independent public SDK operation",
	"agent_session:fetchUsageReportsForControl":
		"internal Telegram control wrapper over the reviewed usage.get seam, not an independent public SDK operation",
	"agent_session:cycleRoleModels": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getRoleModelCycleCandidateCount": "internal role-model display accessor, not a user-facing SDK seam",
	"agent_session:isFastModeEnabled": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:isFastForProvider": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:isFastForSubagentProvider": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:isFastModeActive": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getAvailableThinkingLevels": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:abortCompaction": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:runIdleCompaction": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:abortBranchSummary": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:abortHandoff": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:prepareContributionPrep": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:setResourceSampler": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:setRetainedMemorySampler": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:recordBashResult": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:executePython": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:assertEvalExecutionAllowed": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:promptCustomMessage": "internal custom-message plumbing, not a user-facing SDK control seam",
	"agent_session:sendCustomMessage": "internal custom-message plumbing, not a user-facing SDK control seam",
	"agent_session:trackEvalExecution": "internal execution bookkeeping, not a user-facing SDK control seam",
	"agent_session:recordPythonResult": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:abortEval": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:respondAsBackground": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:emitIrcRelayObservation": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:emitSubagentSteerObservation": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:emitSubagentSteerRelayObservation": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:runEphemeralTurn": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:navigateTree": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:hasCopyCandidateAssistantMessage": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:getLastVisibleHandoffText": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:hasExtensionHandlers": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:registerBeforeAgentStartContributor": "internal accessor/plumbing, not a user-facing control seam",
	"agent_session:setSdkPermissionProvider": "internal reverse-provider plumbing, not a user-facing SDK control seam",
	"agent_session:beginTemporaryProviderSessionScope":
		"internal temporary model/provider restoration scope, not a user-facing SDK control seam",
	"agent_session:restoreTemporaryProviderSessionScope":
		"internal temporary model/provider restoration scope, not a user-facing SDK control seam",
	"agent_session:commitTemporaryProviderSessionScope":
		"internal temporary model/provider restoration scope, not a user-facing SDK control seam",
	"agent_session:getConfiguredModelChain":
		"internal profile and fallback-chain state, not a user-facing SDK control seam",
	"agent_session:setConfiguredModelChain":
		"internal profile and fallback-chain state, not a user-facing SDK control seam",
	"agent_session:setDefaultFallbackRuntimeModel":
		"internal fallback runtime bookkeeping, not a user-facing SDK control seam",
	"agent_session:seedDefaultFallbackResolution":
		"internal fallback resolution bookkeeping, not a user-facing SDK control seam",
};
/** Maps reviewed source seams to registry SDK operation IDs. */
const SEAM_TO_SDK: Readonly<Record<string, string>> = {
	"agent_session:prompt": "turn.prompt",
	"agent_session:steer": "turn.steer",
	"agent_session:followUp": "turn.follow_up",
	"agent_session:abort": "turn.abort",
	"agent_session:newSession": "session.new",
	"agent_session:fork": "session.fork",
	"agent_session:clearContext": "context.clear",
	"agent_session:setSessionName": "session.rename",
	"agent_session:setModel": "model.set",
	"agent_session:setDefaultModelSelection": "model.set",
	"agent_session:cycleModel": "model.cycle",
	"agent_session:setThinkingLevel": "thinking.set",
	"agent_session:cycleThinkingLevel": "thinking.cycle",
	"agent_session:setSteeringMode": "queue.steering_mode.set",
	"agent_session:setFollowUpMode": "queue.follow_up_mode.set",
	"agent_session:setInterruptMode": "queue.interrupt_mode.set",
	"agent_session:compact": "compaction.run",
	"agent_session:setAutoCompactionEnabled": "compaction.auto.set",
	"agent_session:setAutoRetryEnabled": "retry.auto.set",
	"agent_session:abortRetry": "retry.abort",
	"agent_session:retry": "retry.last",
	"agent_session:retryNow": "retry.now",
	"agent_session:setActiveToolsByName": "tools.active.set",
	"agent_session:removeQueuedMessageForEditing": "queue.message.remove",
	"agent_session:moveQueuedMessageForEditing": "queue.message.move",
	"agent_session:executeBash": "bash.execute",
	"agent_session:abortBash": "bash.abort",
	"agent_session:switchSession": "session.switch",
	"agent_session:branch": "session.branch",
	"agent_session:handoff": "session.handoff",
	"agent_session:exportToHtml": "session.export_html",
	"agent_session:getAvailableModels": "models.list/current",
	"agent_session:getSdkConfigItems": "config.list/get",
	"agent_session:getActiveToolNames": "tools.list",
	"agent_session:getQueuedMessages": "queue.messages.list",
	"agent_session:getTodoPhases": "todo.list",
	"agent_session:getContextUsage": "context.get",
	"agent_session:getTranscript": "transcript.list",
	"agent_session:getTranscriptBody": "transcript.body",
	"agent_session:getSessionStats": "session.stats",
	"agent_session:getLastAssistantMessage": "session.last_assistant",
	"agent_session:getUserMessagesForBranching": "session.branch_candidates",
	"agent_session:getAsyncJobSnapshot": "runtime.jobs.list",
	"agent_session:fetchUsageReports": "usage.get",
	"agent_session:setTodoPhases": "todo.replace",
	"agent_session:getQueuedMessageEntries": "queue.messages.list",
	"agent_session:getAllToolNames": "tools.list",
	"agent_session:getDiscoverableTools": "tools.list",
	"agent_session:sendUserMessage": "turn.steer",
	"agent_session:reload": "runtime.reload",
	"agent_session:setSdkPermissionMode": "permission_mode.set",
	"agent_session:invokeSkill": "skill.invoke",
	"agent_session:setSdkPlanMode": "mode.plan.set",
	"agent_session:operateGoal": "mode.goal.operate",
	"agent_session:setServiceTier": "service_tier.set",
	"agent_session:setFastMode": "service_tier.set",
	"agent_session:toggleFastMode": "service_tier.set",
	"agent_session:getLastAssistantText": "session.last_assistant",
	"agent_session:formatSessionAsText": "transcript.body",
	"agent_session:formatCompactContext": "context.get",
	"slash_command:goal": "mode.goal.operate",
	"slash_command:model": "model.set",
	"slash_command:effort": "thinking.set",
	"slash_command:fast": "service_tier.set",
	"slash_command:export": "session.export_html",
	"slash_command:dump": "transcript.body",
	"slash_command:session": "session.list",
	"slash_command:jobs": "runtime.jobs.list",
	"slash_command:context": "context.get",
	"slash_command:usage": "usage.get",
	"slash_command:tools": "tools.list",
	"slash_command:login": "auth.login",
	"slash_command:clear": "context.clear",
	"slash_command:new": "session.new",
	"slash_command:compact": "compaction.run",
	"slash_command:handoff": "session.handoff",
	"slash_command:resume": "session.resume",
	"slash_command:retry": "retry.last",
	"slash_command:background": "bash.background",
	"slash_command:rename": "session.rename",
	"slash_command:move": "session.cwd.move",
};

/** Genuine action seams awaiting a reviewed registry mapping or exclusion. */
const PENDING_REVIEW: Readonly<Record<string, string>> = {};

function lockedExclusion(sourceId: string): string | undefined {
	return LOCKED_EXCLUSIONS[sourceId];
}

export type SourceKind = "registry" | "controller" | "agent_session" | "slash_command" | "acp" | "locked_exclusion";
export interface SourceSeam {
	sourceId: string;
	sourceFile: string;
	sourceKind: SourceKind;
}
interface IncludedInventoryRecord {
	sourceId: string;
	sourceFile: string;
	sourceKind: SourceKind;
	decision: "include";
	sdkId: string;
	adapterMappings: Operation["adapterDispositions"];
	testIds: string[];
}

interface ExcludedInventoryRecord {
	sourceId: string;
	sourceFile: string;
	sourceKind: SourceKind;
	decision: "exclude";
	rationale: string;
	exclusionMetadata: {
		adapterMappings: "not_applicable";
		testIds: "not_applicable";
	};
}

type InventoryRecord = IncludedInventoryRecord | ExcludedInventoryRecord;

function repoPath(file: string): string {
	return path.relative(repoRoot, file).split(path.sep).join("/");
}

/** Controller seam adapter. Semantic IDs never depend on line numbers. */
function collectCaseSeams(source: string, prefix: string): string[] {
	return [...source.matchAll(/case\s+["']([^"']+)["']/g)].map(match => `${prefix}:${match[1]}`);
}

export function scanSlashCommands(sourceText: string): string[] {
	const anchor = "const BUILTIN_SLASH_COMMAND_REGISTRY";
	const anchorIndex = sourceText.indexOf(anchor);
	if (anchorIndex === -1) throw new Error(`SDK operation inventory scanner: required anchor ${anchor} was not found.`);
	const builtinRegistry = sourceText.slice(anchorIndex);
	return [...builtinRegistry.matchAll(/^\t\tname:\s*["']([^"']+)["']/gm)].map(match => `slash_command:${match[1]}`);
}

type TokenKind = "identifier" | "number" | "punctuation" | "string" | "template";
type Token = {
	kind: TokenKind;
	text: string;
	value?: string;
	hasSubstitution?: boolean;
};

const METHOD_MODIFIERS = new Set([
	"public",
	"protected",
	"private",
	"static",
	"override",
	"abstract",
	"declare",
	"readonly",
]);

function isIdentifierStart(char: string): boolean {
	return (char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || char === "_" || char === "$";
}

function isIdentifierPart(char: string): boolean {
	return isIdentifierStart(char) || (char >= "0" && char <= "9");
}

function skipLineComment(sourceText: string, start: number): number {
	const newline = sourceText.indexOf("\n", start + 2);
	return newline === -1 ? sourceText.length : newline + 1;
}

function skipBlockComment(sourceText: string, start: number): number {
	const end = sourceText.indexOf("*/", start + 2);
	return end === -1 ? sourceText.length : end + 2;
}

function decodeEscape(sourceText: string, index: number): { next: number; value: string } {
	const char = sourceText[index];
	if (char === undefined) return { next: index, value: "" };
	const simpleEscapes: Readonly<Record<string, string>> = {
		b: "\b",
		f: "\f",
		n: "\n",
		r: "\r",
		t: "\t",
		v: "\v",
		"0": "\0",
	};
	if (char in simpleEscapes) return { next: index + 1, value: simpleEscapes[char]! };
	if (char === "\r") return { next: sourceText[index + 1] === "\n" ? index + 2 : index + 1, value: "" };
	if (char === "\n") return { next: index + 1, value: "" };
	if (char === "x") {
		const code = Number.parseInt(sourceText.slice(index + 1, index + 3), 16);
		return { next: index + 3, value: Number.isNaN(code) ? "" : String.fromCodePoint(code) };
	}
	if (char === "u") {
		const braced = sourceText[index + 1] === "{";
		const end = braced ? sourceText.indexOf("}", index + 2) : index + 5;
		const hex = braced ? sourceText.slice(index + 2, end) : sourceText.slice(index + 1, end);
		const code = Number.parseInt(hex, 16);
		return {
			next: braced ? (end === -1 ? index + 2 : end + 1) : end,
			value: Number.isNaN(code) ? "" : String.fromCodePoint(code),
		};
	}
	return { next: index + 1, value: char };
}

function readQuotedToken(sourceText: string, start: number): { next: number; value: string } {
	const quote = sourceText[start]!;
	let value = "";
	let index = start + 1;
	while (index < sourceText.length) {
		const char = sourceText[index]!;
		if (char === quote) return { next: index + 1, value };
		if (char === "\\") {
			const escapeSequence = decodeEscape(sourceText, index + 1);
			value += escapeSequence.value;
			index = escapeSequence.next;
			continue;
		}
		value += char;
		index++;
	}
	return { next: index, value };
}

function skipRegularExpression(sourceText: string, start: number): number {
	let inCharacterClass = false;
	for (let index = start + 1; index < sourceText.length; index++) {
		const char = sourceText[index]!;
		if (char === "\\") {
			index++;
			continue;
		}
		if (char === "[") inCharacterClass = true;
		else if (char === "]") inCharacterClass = false;
		else if (char === "/" && !inCharacterClass) {
			index++;
			while (isIdentifierPart(sourceText[index] ?? "")) index++;
			return index;
		} else if (char === "\n" || char === "\r") return index;
	}
	return sourceText.length;
}

function tokenCanPrecedeRegularExpression(token: Token | undefined): boolean {
	return (
		!token ||
		["(", "[", "{", "=", ":", ",", ";", "!", "?", "&&", "||", "=>", "return", "case", "throw"].includes(token.text)
	);
}

function skipTemplateExpression(sourceText: string, start: number): number {
	let depth = 1;
	for (let index = start; index < sourceText.length; index++) {
		const char = sourceText[index]!;
		if (char === "'" || char === '"') {
			index = readQuotedToken(sourceText, index).next - 1;
			continue;
		}
		if (char === "`") {
			index = readTemplateToken(sourceText, index).next - 1;
			continue;
		}
		if (char === "/" && sourceText[index + 1] === "/") {
			index = skipLineComment(sourceText, index) - 1;
			continue;
		}
		if (char === "/" && sourceText[index + 1] === "*") {
			index = skipBlockComment(sourceText, index) - 1;
			continue;
		}
		if (char === "{") depth++;
		else if (char === "}" && --depth === 0) return index + 1;
	}
	return sourceText.length;
}

function readTemplateToken(
	sourceText: string,
	start: number,
): { next: number; value: string; hasSubstitution: boolean } {
	let hasSubstitution = false;
	let index = start + 1;
	let value = "";
	while (index < sourceText.length) {
		const char = sourceText[index]!;
		if (char === "`") return { next: index + 1, value, hasSubstitution };
		if (char === "\\") {
			const escapeSequence = decodeEscape(sourceText, index + 1);
			value += escapeSequence.value;
			index = escapeSequence.next;
			continue;
		}
		if (char === "$" && sourceText[index + 1] === "{") {
			hasSubstitution = true;
			index = skipTemplateExpression(sourceText, index + 2);
			continue;
		}
		value += char;
		index++;
	}
	return { next: index, value, hasSubstitution };
}

function tokenize(sourceText: string): Token[] {
	const tokens: Token[] = [];
	for (let index = 0; index < sourceText.length; ) {
		const char = sourceText[index]!;
		if (/\s/.test(char)) {
			index++;
			continue;
		}
		if (char === "/" && sourceText[index + 1] === "/") {
			index = skipLineComment(sourceText, index);
			continue;
		}
		if (char === "/" && sourceText[index + 1] === "*") {
			index = skipBlockComment(sourceText, index);
			continue;
		}
		if (char === "'" || char === '"') {
			const token = readQuotedToken(sourceText, index);
			tokens.push({ kind: "string", text: sourceText.slice(index, token.next), value: token.value });
			index = token.next;
			continue;
		}
		if (char === "`") {
			const token = readTemplateToken(sourceText, index);
			tokens.push({
				kind: "template",
				text: sourceText.slice(index, token.next),
				value: token.value,
				hasSubstitution: token.hasSubstitution,
			});
			index = token.next;
			continue;
		}
		if (char === "/" && tokenCanPrecedeRegularExpression(tokens.at(-1))) {
			index = skipRegularExpression(sourceText, index);
			continue;
		}
		if (isIdentifierStart(char)) {
			const start = index++;
			while (isIdentifierPart(sourceText[index] ?? "")) index++;
			tokens.push({ kind: "identifier", text: sourceText.slice(start, index) });
			continue;
		}
		if (char >= "0" && char <= "9") {
			const start = index++;
			while (/[0-9A-Za-z._]/.test(sourceText[index] ?? "")) index++;
			tokens.push({ kind: "number", text: sourceText.slice(start, index) });
			continue;
		}
		const punctuation =
			sourceText.slice(index, index + 3) === "..."
				? "..."
				: sourceText.slice(index, index + 2) === "=>"
					? "=>"
					: char;
		tokens.push({ kind: "punctuation", text: punctuation });
		index += punctuation.length;
	}
	return tokens;
}

function matchingToken(tokens: readonly Token[], start: number, open: string, close: string): number | undefined {
	if (tokens[start]?.text !== open) return undefined;
	let depth = 0;
	for (let index = start; index < tokens.length; index++) {
		if (tokens[index]!.text === open) depth++;
		else if (tokens[index]!.text === close && --depth === 0) return index;
	}
	return undefined;
}

function skipTypeParameters(tokens: readonly Token[], start: number): number {
	if (tokens[start]?.text !== "<") return start;
	let depth = 0;
	for (let index = start; index < tokens.length; index++) {
		if (tokens[index]!.text === "<") depth++;
		else if (tokens[index]!.text === ">" && --depth === 0) return index + 1;
	}
	return start;
}

function isMemberName(token: Token | undefined): boolean {
	return token?.kind === "identifier" || token?.kind === "string" || token?.kind === "number";
}

function memberName(token: Token): string | undefined {
	return token.kind === "string"
		? token.value
		: token.kind === "identifier" || token.kind === "number"
			? token.text
			: undefined;
}

function skipDecorators(tokens: readonly Token[], start: number): number {
	let index = start;
	while (tokens[index]?.text === "@") {
		index++;
		if (tokens[index]?.kind !== "identifier") return index;
		index++;
		while (tokens[index]?.text === "." && tokens[index + 1]?.kind === "identifier") index += 2;
		index = skipTypeParameters(tokens, index);
		if (tokens[index]?.text === "(") {
			const close = matchingToken(tokens, index, "(", ")");
			if (close === undefined) return tokens.length;
			index = close + 1;
		}
	}
	return index;
}

function memberEnd(tokens: readonly Token[], start: number, classEnd: number): number {
	for (let index = start; index < classEnd; index++) {
		if (tokens[index]!.text === ";") return index + 1;
		if (tokens[index]!.text === "{") {
			const close = matchingToken(tokens, index, "{", "}");
			return close === undefined ? classEnd : close + 1;
		}
	}
	return classEnd;
}

function nextMemberStart(tokens: readonly Token[], start: number, classEnd: number): number {
	let braceDepth = 0;
	let bracketDepth = 0;
	let parenDepth = 0;
	for (let index = start; index < classEnd; index++) {
		const token = tokens[index]!.text;
		if (token === "(") parenDepth++;
		else if (token === ")" && parenDepth > 0) parenDepth--;
		else if (token === "[") bracketDepth++;
		else if (token === "]" && bracketDepth > 0) bracketDepth--;
		else if (token === "{") braceDepth++;
		else if (token === "}" && braceDepth > 0) {
			braceDepth--;
			if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) return index + 1;
		} else if (token === ";" && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) return index + 1;
	}
	return classEnd;
}

type MethodDeclaration = { end: number; name?: string };

type ParsedMemberName = { computed: boolean; end: number; name?: string };

function parseMemberName(tokens: readonly Token[], start: number): ParsedMemberName | undefined {
	const direct = tokens[start];
	if (isMemberName(direct)) return { computed: false, end: start + 1, name: memberName(direct!) };
	if (direct?.text !== "[" || tokens[start + 2]?.text !== "]") return undefined;
	const computed = tokens[start + 1];
	if (computed?.kind === "string" || computed?.kind === "number") {
		return { computed: true, end: start + 3, name: memberName(computed) };
	}
	if (computed?.kind === "template" && !computed.hasSubstitution) {
		return { computed: true, end: start + 3, name: computed.value };
	}
	return undefined;
}

function scanMethodDeclaration(
	tokens: readonly Token[],
	start: number,
	classEnd: number,
): MethodDeclaration | undefined {
	let index = skipDecorators(tokens, start);
	while (tokens[index]?.kind === "identifier" && METHOD_MODIFIERS.has(tokens[index]!.text)) index++;
	if (tokens[index]?.text === "async" && tokens[index + 1]?.text !== "(") index++;
	if (tokens[index]?.text === "*") index++;
	const candidate = tokens[index];
	if (candidate?.text === "get" || candidate?.text === "set") {
		const accessor = parseMemberName(tokens, index + 1);
		if (!accessor) return undefined;
		const accessorEnd = skipTypeParameters(tokens, accessor.end);
		if (tokens[accessorEnd]?.text !== "(") return undefined;
		const close = matchingToken(tokens, accessorEnd, "(", ")");
		if (close === undefined) return undefined;
		return {
			end: memberEnd(tokens, close + 1, classEnd),
			name: accessor.name?.endsWith("ForTests") ? accessor.name : undefined,
		};
	}

	const method = parseMemberName(tokens, index);
	if (!method) return undefined;
	const afterName = skipTypeParameters(tokens, method.end);
	if (tokens[afterName]?.text !== "(") return undefined;
	const close = matchingToken(tokens, afterName, "(", ")");
	if (close === undefined) return undefined;
	return {
		end: memberEnd(tokens, close + 1, classEnd),
		name: method.computed && !method.name?.endsWith("ForTests") ? undefined : method.name,
	};
}

export function scanAgentSessionMethods(sourceText: string): string[] {
	const tokens = tokenize(sourceText);
	for (let index = 0; index < tokens.length - 2; index++) {
		if (tokens[index]!.text !== "class" || tokens[index + 1]?.text !== "AgentSession") continue;
		let angleDepth = 0;
		let bodyStart: number | undefined;
		for (let bodyIndex = index + 2; bodyIndex < tokens.length; bodyIndex++) {
			if (tokens[bodyIndex]!.text === "<") angleDepth++;
			else if (tokens[bodyIndex]!.text === ">" && angleDepth > 0) angleDepth--;
			else if (tokens[bodyIndex]!.text === ";" && angleDepth === 0) break;
			else if (tokens[bodyIndex]!.text === "{" && angleDepth === 0) {
				bodyStart = bodyIndex;
				break;
			}
		}
		if (bodyStart === undefined)
			throw new Error("SDK operation inventory scanner: AgentSession class is missing its opening body delimiter.");
		const bodyEnd = matchingToken(tokens, bodyStart, "{", "}");
		if (bodyEnd === undefined)
			throw new Error("SDK operation inventory scanner: AgentSession class body is unbalanced.");

		const methods: string[] = [];
		for (let memberStart = bodyStart + 1; memberStart < bodyEnd; ) {
			const declaration = scanMethodDeclaration(tokens, memberStart, bodyEnd);
			if (declaration) {
				if (declaration.name) methods.push(`agent_session:${declaration.name}`);
				memberStart = Math.max(memberStart + 1, declaration.end);
				continue;
			}
			memberStart = Math.max(memberStart + 1, nextMemberStart(tokens, memberStart, bodyEnd));
		}
		return methods;
	}
	throw new Error("SDK operation inventory scanner: required AgentSession class declaration was not found.");
}

export function scanAcpMethods(sourceText: string): string[] {
	const tokens = tokenize(sourceText);
	const methods: string[] = [];
	for (let index = 0; index < tokens.length - 4; index++) {
		if (tokens[index]!.text !== "switch" || tokens[index + 1]?.text !== "(") continue;
		const expressionEnd = matchingToken(tokens, index + 1, "(", ")");
		if (
			expressionEnd === undefined ||
			expressionEnd !== index + 3 ||
			tokens[index + 2]?.text !== "method" ||
			tokens[expressionEnd + 1]?.text !== "{"
		)
			continue;
		const switchEnd = matchingToken(tokens, expressionEnd + 1, "{", "}");
		if (switchEnd === undefined) continue;
		let braceDepth = 0;
		for (let caseIndex = expressionEnd + 2; caseIndex < switchEnd; caseIndex++) {
			const token = tokens[caseIndex]!;
			if (braceDepth === 0 && token.text === "case") {
				const label = tokens[caseIndex + 1];
				if (
					(label?.kind === "string" || (label?.kind === "template" && !label.hasSubstitution)) &&
					tokens[caseIndex + 2]?.text === ":"
				)
					methods.push(`acp:${label.value}`);
			}
			if (token.text === "{") braceDepth++;
			else if (token.text === "}" && braceDepth > 0) braceDepth--;
		}
	}
	return methods;
}

async function scanSeams(): Promise<SourceSeam[]> {
	const root = process.env.GJC_SDK_SEAM_SCAN_ROOT;
	if (root) {
		const files = await fs.readdir(root, { recursive: true });
		const seams: SourceSeam[] = [];
		for (const relative of files) {
			if (typeof relative !== "string" || !relative.endsWith(".ts")) continue;
			const file = path.join(root, relative);
			for (const sourceId of collectCaseSeams(await Bun.file(file).text(), `controller:${relative}`))
				seams.push({ sourceId, sourceFile: file, sourceKind: "controller" });
		}
		return seams;
	}

	const builtinFile = path.join(repoRoot, "packages/coding-agent/src/slash-commands/builtin-registry.ts");
	const sessionFile = path.join(repoRoot, "packages/coding-agent/src/session/agent-session.ts");
	const acpFile = path.join(repoRoot, "packages/coding-agent/src/modes/acp/acp-agent.ts");
	const [builtinSource, sessionSource, acpSource] = await Promise.all([
		Bun.file(builtinFile).text(),
		Bun.file(sessionFile).text(),
		Bun.file(acpFile).text(),
	]);
	return [
		...scanSlashCommands(builtinSource).map(sourceId => ({
			sourceId,
			sourceFile: repoPath(builtinFile),
			sourceKind: "slash_command" as const,
		})),
		...scanAgentSessionMethods(sessionSource).map(sourceId => ({
			sourceId,
			sourceFile: repoPath(sessionFile),
			sourceKind: "agent_session" as const,
		})),
		...scanAcpMethods(acpSource).map(sourceId => ({
			sourceId,
			sourceFile: repoPath(acpFile),
			sourceKind: "acp" as const,
		})),
	];
}

function generatedRecords(seams: Awaited<ReturnType<typeof scanSeams>>): InventoryRecord[] {
	const records: InventoryRecord[] = OPERATIONS.map(operation => ({
		sourceId: `registry:${operation.id}`,
		sourceFile: "packages/coding-agent/src/sdk/protocol/operation-registry.ts",
		sourceKind: "registry" as const,
		decision: "include" as const,
		sdkId: operation.sdkId,
		adapterMappings: operation.adapterDispositions,
		testIds: operation.testIds,
	}));
	for (const seam of seams) {
		const sdkId = SEAM_TO_SDK[seam.sourceId];
		const rationale = lockedExclusion(seam.sourceId);
		if (!sdkId && !rationale) continue;
		if (!sdkId) {
			if (!rationale) continue;
			records.push({
				...seam,
				decision: "exclude",
				rationale,
				exclusionMetadata: { adapterMappings: "not_applicable", testIds: "not_applicable" },
			});
			continue;
		}
		const operation = OPERATIONS.find(candidate => candidate.sdkId === sdkId);
		if (!operation) throw new Error(`SEAM_TO_SDK maps ${seam.sourceId} to unknown SDK ID: ${sdkId}`);
		records.push({
			...seam,
			decision: "include",
			sdkId,
			adapterMappings: operation.adapterDispositions,
			testIds: operation.testIds,
		});
	}
	return records;
}

function validateRegistry(records: InventoryRecord[]): string[] {
	const errors: string[] = [];
	const ids = new Set<string>();
	const sdkIds = new Set<string>();
	for (const operation of OPERATIONS) {
		if (ids.has(operation.id)) errors.push(`Duplicate operation ID: ${operation.id}`);
		ids.add(operation.id);
		const operationKey = `${operation.kind}:${operation.sdkId}`;
		if (sdkIds.has(operationKey)) errors.push(`Duplicate sdkId in ${operation.kind}: ${operation.sdkId}`);
		sdkIds.add(operationKey);
		if (ADAPTERS.some(adapter => !operation.adapterDispositions[adapter]))
			errors.push(`${operation.id} is missing adapter dispositions.`);
		if (operation.testIds.length === 0) errors.push(`${operation.id} is missing test IDs.`);
	}
	for (const record of records) {
		if (record.decision === "exclude") {
			if (!record.rationale) errors.push(`${record.sourceId} exclusion lacks a locked rationale.`);
			if (
				record.exclusionMetadata.adapterMappings !== "not_applicable" ||
				record.exclusionMetadata.testIds !== "not_applicable"
			)
				errors.push(
					`${record.sourceId} exclusion metadata must mark adapter mappings and test IDs as not applicable.`,
				);
			continue;
		}
		if (ADAPTERS.some(adapter => !record.adapterMappings[adapter]))
			errors.push(`${record.sourceId} is missing adapter mappings.`);
		if (record.testIds.length === 0) errors.push(`${record.sourceId} is missing test IDs.`);
	}
	return errors;
}

export function pendingReviewErrors(seams: readonly Pick<SourceSeam, "sourceId">[]): string[] {
	return seams
		.filter(seam => !SEAM_TO_SDK[seam.sourceId] && !lockedExclusion(seam.sourceId))
		.map(seam => `Pending review source seam: ${seam.sourceId}. Add it to SEAM_TO_SDK or LOCKED_EXCLUSIONS.`);
}

async function check(records: InventoryRecord[], seams: Awaited<ReturnType<typeof scanSeams>>): Promise<void> {
	const errors = [...validateRegistry(records), ...pendingReviewErrors(seams)];
	for (const sourceId of Object.keys(PENDING_REVIEW))
		errors.push(`Pending review source seam: ${sourceId}. ${PENDING_REVIEW[sourceId]}`);
	let checkedIn: InventoryRecord[];
	try {
		checkedIn = await Bun.file(inventoryPath).json();
	} catch (error) {
		throw new Error(
			`Unable to read ${repoPath(inventoryPath)}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const expected = JSON.stringify(records);
	const actual = JSON.stringify(checkedIn);
	if (actual !== expected) {
		const expectedSources = new Set(records.map(record => record.sourceId));
		const actualSources = new Set(checkedIn.map(record => record.sourceId));
		for (const sourceId of expectedSources)
			if (!actualSources.has(sourceId)) errors.push(`Unreviewed addition: ${sourceId}`);
		for (const sourceId of actualSources)
			if (!expectedSources.has(sourceId)) errors.push(`Disappeared source: ${sourceId}`);
		errors.push("Generated operation inventory drifts from OPERATIONS.");
	}
	if (errors.length > 0) throw new Error(errors.join("\n"));
}

if (import.meta.main) {
	const seams = await scanSeams();
	const records = generatedRecords(seams);
	const pending = pendingReviewErrors(seams);
	if (process.argv.slice(2).includes("--check")) {
		try {
			await check(records, seams);
		} catch (error) {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
			process.exit(1);
		}
	} else {
		await Bun.write(inventoryPath, `${JSON.stringify(records, null, "\t")}\n`);
		const included = records.filter(record => record.decision === "include").length;
		const excluded = records.filter(record => record.decision === "exclude").length;
		process.stderr.write(
			`Generated ${repoPath(inventoryPath)} (${records.length} records): include=${included}, exclude=${excluded}, pending=${pending.length}.\n`,
		);
	}
}
