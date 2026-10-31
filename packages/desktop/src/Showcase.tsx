import { CircleHelp, Command, LoaderCircle, MessageSquare, Plus, Settings2 } from "lucide-react";
import { useState } from "react";
import type { DesktopBtwConversation, DesktopBtwTurn } from "../../desktop-host/src/btw-protocol";
import type { DesktopMcpServer, DesktopMcpSnapshot } from "../../desktop-host/src/mcp-protocol";
import type { DesktopModelProfile, DesktopModelRolePreference } from "../../desktop-host/src/preferences-protocol";
import type {
	DesktopHistory,
	DesktopModel,
	DesktopSession,
	DesktopThinking,
	DesktopThinkingLevel,
} from "../../desktop-host/src/protocol";
import type { DesktopSessionInfo, DesktopSessionInfoUsage } from "../../desktop-host/src/session-info-protocol";
import { AttachmentPicker, type DesktopAttachmentDraft } from "./AttachmentPicker";
import gajaeMark from "./assets/gajae-mark.png";
import { BtwPanel, type BtwPanelProps } from "./BtwPanel";
import {
	Button,
	Composer,
	ErrorBanner,
	GoalStrip,
	Message,
	Modal,
	QuestionCard,
	SessionRow,
	SettingField,
	TodoPanel,
} from "./components";
import { ForkPanel, type ForkPanelProps } from "./ForkPanel";
import { t, useLocale } from "./i18n";
import { McpPanel, type McpPanelProps } from "./McpPanel";
import { ModelPicker, type PickerModelRole } from "./ModelPicker";
import { ReasoningSelect } from "./ReasoningSelect";
import { SessionInfoPanel, type SessionInfoPanelProps } from "./SessionInfoPanel";
import { SettingsSection, type SettingsTab, SettingsTabs, settingsPanelId, settingsTabId } from "./SettingsTabs";
import { DESKTOP_THEMES } from "./themes";
import "./styles.css";

// Deterministic 768×192 PNG: real intrinsic size exercises responsive preview bounds.
const transcriptPreviewImage =
	"iVBORw0KGgoAAAANSUhEUgAAAwAAAADACAIAAAA845PwAAAEpUlEQVR42u3WwQnAIBREQXuxIOtIbTl6sKRcQmpIDYIhXx2YAkRwfSkfBQBgK8kVAAACCABAAAEACCAAAAEEACCAAAAEEACAAAIAEEAAAAIIAEAAAQAIIAAAAQQAIIAAAAQQAIAAAgAEEACAAAIAEEAAAAIIAEAAAQAIIAAAAQQAsEQA3c8FbGLUbtR2AnQRQIAAAgSQAAIEECCABBAggAABJIAAAQQIIAEECCBAAAkgQAABAkgAAQIIEEACCBBAgAASQCCABBAggAABJIAAAQQIIAEECCBAAAkgQAABAghAAAECCEAAAQIIQAABAggQQAIIEECAABJAgAACBJAAAgQQIIAEECCAAAEkgAABBAggAQQIIEAACSBAAAEC6IsAGnUeIP47NeWAABJAIIAABBAggAAEECCAAAEkgAABBAggAQQIIEAACSBAAAECSACBABJAgAASQCCABBAggAQQCCABBAggAQQCSAABAkgAgQASQIAAEkAggAQQIIAEEAggAQQIIAEEAkgAAQJIAIEAEkCAABJAIIAABBAggAAEECCAAAQQIIAAASSAAAEECCABBAggQAAJIBBAAggQQAIIBJAAAgSQAAIBJIAAASSAQAAJIEAACSAQQAIIEEACCASQAAIEkAACASSAAAEkgEAACSBAAAkgEEACCBBAAggEEIAAAgQQgAACBBCAAAIEECCABBAggAABJIAAAQQIIAEECCBAAAkgEEACCBBAAggEkAACBJAAAgEkgAABJIBAAAkgQAAJIBBAAggQQAIIBJAAAgSQAAIBJIAAASSAQAAJIEAACSAQQAACyC8FAghAAAECCEAAAQIIEEACCBBAgAASQIAAAgSQAAIEECCABBAIIAEECCABBAJIAAECSACBABJAgAASQCCABBAggAQQCCABBAggAQQCSAABAkgAgQASQIAAEkAggAQQIIAEEAggAAEkgEAAAQggQAABCCBAAAECSAABAggQQAIIEECAABJAgAACBJAAAgEkgAABJIBAAAkgQAAJIBBAAggQQAIIBJAAAgSQAAIBJIAAASSAQAAJIEAACSAQQAIIEEACCASQAAIEkAACAWTNAQEkgEAAAQggQAABCCBAAAECSAABAggQQAIIEECAABJAgAACBJAAAgEkgAABJIBAAAkgQAAJIBBAAggQQAIIBJAAAgSQAAIBJIAAASSAQAAJIEAACSAQQAIIEEACCASQAAIEkAACASSAAAEkgEAAAQggQAABCCBAAAECSAABAggQQGsEEBCfAAIEkAACASSAAAEECCABBAggQAAJIEAAAQJIAAECCBBAAAIIEEAAAggQQAACCBBAgAASQIAAAgSQAAIEECCABBAggAABJIAAAQQIIAEECCBAAAkgQAABAkgAAQIIEEACCASQAAIEECCABBAggAABJIAAAQQIIAEECCBAAAEIIEAAAQggQAABCCBAAAECKEIAAQDMQgABAAIIAEAAAQAIIAAAAQQAIIAAAAQQAIAAAgAQQAAAAggAQAABAAggAAABBAAggAAABBAAgAACAAQQAIAAAgAQQAAAAggAQAABAAggAAABBADwqxfwgRtym8TYiQAAAABJRU5ErkJggg==";

const fixtureModels: DesktopModel[] = Array.from(
	{ length: 84 },
	(_, index): DesktopModel => ({
		id: `design-fixture-${index % 2 === 0 ? "a" : "b"}/model-${index + 1}`,
		name:
			// Retained CJK width fixture: the only Hangul left in the showcase, kept so model-name
			// truncation and mixed-script layout stay covered.
			index === 0
				? "한국어와 TypeScript를 함께 검토하는 긴 이름의 디자인 예시 모델"
				: t("showcase.modelFixtureName", { index: index + 1 }),
		provider: index % 2 === 0 ? "design-fixture-a" : "design-fixture-b",
		contextWindow: 128000,
		reasoning: index !== 83,
		thinking:
			index === 83
				? { options: [] }
				: {
						mode: "effort",
						options: [
							{
								value: "medium",
								label: t("showcase.reasoningOptionMediumLabel"),
								description: t("showcase.reasoningOptionMediumDescription"),
							},
							{
								value: "high",
								label: t("showcase.reasoningOptionHighLabel"),
								description: t("showcase.reasoningOptionHighDescription"),
							},
						],
					},
	}),
);

function FixtureControls({
	disabled = false,
	running = false,
	pending = false,
	empty = false,
}: {
	disabled?: boolean;
	running?: boolean;
	pending?: boolean;
	empty?: boolean;
}) {
	const [selectedId, setSelectedId] = useState(fixtureModels[0].id);
	// The design reference opens on an applied preset so the active provider header and the star
	// beside it are visible without clicking first.
	const [appliedProfile, setAppliedProfile] = useState<string>("design-fixture-default");
	const [refreshes, setRefreshes] = useState(0);
	const [assignments, setAssignments] = useState<Partial<Record<PickerModelRole, string>>>({
		executor: fixtureModels[2].id,
		planner: fixtureModels[1].id,
	});
	const roles: DesktopModelRolePreference[] = (["default", "executor", "planner", "critic", "architect"] as const).map(
		id => {
			const model = fixtureModels.find(model => model.id === (id === "default" ? selectedId : assignments[id]));
			return {
				id,
				name: id,
				configured: !!model,
				model: model
					? { provider: model.provider, id: model.id.slice(model.provider.length + 1), name: model.name }
					: null,
				thinkingLevel: null,
				configurationResolution: { origin: "runtime", layers: ["runtime"] },
				canApply: { available: true, reason: null },
				scope: id === "default" ? "default" : "session",
				canClear: { available: id !== "default" && !!model, reason: null },
			};
		},
	);
	const [level, setLevel] = useState<DesktopThinkingLevel>("medium");
	const profiles: DesktopModelProfile[] = [
		{
			id: "design-fixture-default",
			name: t("showcase.profileDefaultName"),
			description: null,
			group: "CODEX",
			groupRank: 0,
			available: true,
			source: "builtin",
			active: appliedProfile === "design-fixture-default",
			default: true,
			roles: [
				{ id: "default", model: fixtureModels[0].id },
				{ id: "executor", model: fixtureModels[2].id },
				{ id: "architect", model: null },
				{ id: "planner", model: fixtureModels[1].id },
				{ id: "critic", model: null },
				{ id: "image", model: null },
			],
			capabilities: {
				selectSession: { available: true, reason: null },
				persistDefault: { available: true, reason: null },
			},
		},
		{
			id: "design-fixture-review",
			name: t("showcase.profileReviewName"),
			description: null,
			group: "COMBOS",
			groupRank: 13,
			available: true,
			source: "configured",
			active: appliedProfile === "design-fixture-review",
			default: false,
			roles: [
				{ id: "default", model: fixtureModels[1].id },
				{ id: "executor", model: null },
				{ id: "architect", model: null },
				{ id: "planner", model: fixtureModels[2].id },
				{ id: "critic", model: fixtureModels[0].id },
				{ id: "image", model: null },
			],
			capabilities: {
				selectSession: { available: true, reason: null },
				persistDefault: { available: false, reason: t("showcase.profileDefaultUnavailable") },
			},
		},
		{
			id: "design-fixture-local",
			name: t("showcase.profileLocalName"),
			description: null,
			group: "macOS Local (oMLX)",
			groupRank: 3,
			// Shown dimmed: this example provider has no registered credential.
			available: false,
			source: "configured",
			active: false,
			default: false,
			roles: [
				{ id: "default", model: fixtureModels[2].id },
				{ id: "executor", model: fixtureModels[2].id },
				{ id: "architect", model: null },
				{ id: "planner", model: null },
				{ id: "critic", model: null },
				{ id: "image", model: null },
			],
			capabilities: {
				selectSession: { available: true, reason: null },
				persistDefault: { available: true, reason: null },
			},
		},
	];
	const appliedProfileName = profiles.find(profile => profile.id === appliedProfile)?.name;
	const models = empty ? [] : fixtureModels;
	const selectedModel = models.find(model => model.id === selectedId);
	const thinking: DesktopThinking = {
		level: selectedModel?.reasoning ? level : null,
		options: selectedModel?.thinking.options ?? [],
		scope: selectedModel ? "session" : null,
		available: selectedModel?.reasoning ?? false,
		mode: selectedModel?.thinking.mode,
		reason: selectedModel?.reasoning ? undefined : t("showcase.reasoningUnavailable"),
	};
	return (
		<div className="model-controls">
			<ModelPicker
				models={models}
				selectedId={empty ? undefined : selectedId}
				disabled={disabled}
				pending={pending}
				onSelect={setSelectedId}
				roles={roles}
				profiles={profiles}
				onApplyProfile={setAppliedProfile}
				onRefresh={() => setRefreshes(value => value + 1)}
				onAssign={(role, modelId) => {
					if (role === "default" && modelId) setSelectedId(modelId);
					else
						setAssignments(previous => {
							const next = { ...previous };
							if (modelId) next[role] = modelId;
							else delete next[role];
							return next;
						});
				}}
			/>
			<ReasoningSelect thinking={thinking} disabled={disabled} pending={pending} onChange={setLevel} />
			<small className="model-control-status fixture-note">
				{running
					? t("showcase.modelControlsRunning")
					: `${t("showcase.modelControlsIdle")}${appliedProfileName ? t("showcase.modelControlsProfile", { name: appliedProfileName }) : ""}${refreshes > 0 ? t("showcase.modelControlsRefreshes", { count: refreshes }) : ""}`}
			</small>
		</div>
	);
}

interface McpFixture extends Pick<McpPanelProps, "snapshot" | "pending" | "busy" | "error"> {
	label: string;
}

const fixtureMcpSnapshot: DesktopMcpSnapshot = {
	connectionGeneration: "DESIGN-ONLY-not-a-live-connection",
	sessionGeneration: 0,
	scope: "factory_manager_may_be_shared",
	available: true,
	truncated: false,
	servers: [
		{
			ref: {
				connectionGeneration: "DESIGN-ONLY-not-a-live-connection",
				sessionGeneration: 0,
				key: "DESIGN-ONLY-server",
			},
			label: t("showcase.mcpServerLabel"),
			state: "connected",
			transport: "stdio",
			sharing: "per-session",
			toolCount: 12,
			controls: ["suspend", "reconnect"],
		},
	],
};
const fixtureMcpConnected: McpFixture = { label: t("showcase.mcpStateConnected"), snapshot: fixtureMcpSnapshot };
const fixtureMcpStates: McpFixture[] = [
	fixtureMcpConnected,
	{
		label: t("showcase.mcpStateSuspended"),
		snapshot: {
			...fixtureMcpSnapshot,
			servers: fixtureMcpSnapshot.servers.map(
				(server): DesktopMcpServer => ({ ...server, state: "suspended", controls: ["resume", "reconnect"] }),
			),
		},
	},
	{
		label: t("showcase.mcpStateNoControls"),
		snapshot: {
			...fixtureMcpSnapshot,
			servers: fixtureMcpSnapshot.servers.map((server): DesktopMcpServer => ({ ...server, controls: [] })),
		},
	},
	{
		label: t("showcase.mcpStateShared"),
		snapshot: {
			...fixtureMcpSnapshot,
			servers: fixtureMcpSnapshot.servers.map((server): DesktopMcpServer => ({ ...server, sharing: "shared" })),
		},
	},
	{
		label: t("showcase.mcpStateUnknown"),
		snapshot: {
			...fixtureMcpSnapshot,
			servers: fixtureMcpSnapshot.servers.map(
				(server): DesktopMcpServer => ({
					...server,
					state: "unknown",
					transport: "unknown",
					sharing: "unknown",
					controls: [],
				}),
			),
		},
	},
	{
		label: t("showcase.mcpStateUnavailable"),
		snapshot: {
			...fixtureMcpSnapshot,
			available: false,
			servers: [],
			error: {
				code: "unavailable",
				message: t("showcase.mcpUnavailableMessage"),
			},
		},
	},
	{
		label: t("showcase.mcpStateUnknownEffect"),
		snapshot: {
			...fixtureMcpSnapshot,
			error: {
				code: "unknown_effect",
				message: t("showcase.mcpUnknownEffectMessage"),
			},
		},
		error: t("showcase.mcpTransportError"),
	},
	{ label: t("showcase.mcpStatePending"), snapshot: fixtureMcpSnapshot, pending: true },
	{ label: t("showcase.mcpStateBusy"), snapshot: fixtureMcpSnapshot, busy: true },
	{ label: t("showcase.mcpStateEmpty"), snapshot: null },
];

function FixtureMcpPanel() {
	const [fixture, setFixture] = useState(fixtureMcpConnected);
	const [notice, setNotice] = useState(t("showcase.mcpNoticeInitial"));
	return (
		<>
			<p className="fixture-note muted">{t("showcase.mcpNote")}</p>
			<div className="actions" role="group" aria-label={t("showcase.mcpStatesLabel")}>
				{fixtureMcpStates.map(state => (
					<Button
						key={state.label}
						aria-pressed={fixture === state}
						onClick={() => {
							setFixture(state);
							setNotice(t("showcase.mcpNoticeSelected", { label: state.label }));
						}}
					>
						{state.label}
					</Button>
				))}
			</div>
			<p className="showcase-result" role="status">
				{notice}
			</p>
			<McpPanel
				{...fixture}
				onRefresh={() => setNotice(t("showcase.mcpNoticeRefresh"))}
				onOperate={(_ref, action) => setNotice(t("showcase.mcpNoticeOperate", { action }))}
			/>
		</>
	);
}

type AvailableFixtureInfo = Extract<DesktopSessionInfo, { available: true }>;
interface SessionInfoFixture extends Pick<SessionInfoPanelProps, "info" | "pending" | "error"> {
	label: string;
}
const fixtureRecordedUsage: DesktopSessionInfoUsage = {
	available: true,
	source: "transcript_aggregate",
	note: t("showcase.infoRecordedNote"),
	tokens: { input: 2400, output: 400, cacheRead: 600, cacheWrite: 0, total: 2800 },
	premiumRequests: null,
	cost: {
		amount: 0.012,
		source: "sdk_recorded_cost",
		reason: t("showcase.infoRecordedCostReason"),
	},
};
const fixtureActiveUsage: DesktopSessionInfoUsage = {
	...fixtureRecordedUsage,
	source: "active_messages",
	note: t("showcase.infoActiveNote"),
	tokens: { input: 1600, output: 200, cacheRead: 400, cacheWrite: 0, total: 1800 },
	cost: {
		amount: 0.008,
		source: "sdk_recorded_cost",
		reason: t("showcase.infoActiveCostReason"),
	},
};
const fixtureLiveUsage: DesktopSessionInfoUsage = {
	...fixtureRecordedUsage,
	source: "stream_partial",
	note: t("showcase.infoLiveNote"),
	tokens: { input: null, output: 70, cacheRead: null, cacheWrite: null, total: null },
	cost: {
		amount: 0.0003,
		source: "live_partial_cost",
		reason: t("showcase.infoLiveCostReason"),
	},
};
const fixtureSessionInfo: AvailableFixtureInfo = {
	available: true,
	metadata: {
		catalogSessionId: "DESIGN-ONLY-catalog-not-a-real-session",
		name: t("showcase.infoSessionName"),
		sessionFileDisplay: t("showcase.infoSessionFile"),
		cwd: t("showcase.infoSessionCwd"),
		createdAt: null,
		persisted: false,
	},
	model: {
		provider: "design-fixture",
		id: "DESIGN-ONLY/model",
		name: t("showcase.infoModelName"),
	},
	thinkingLevel: t("showcase.infoThinkingLevel"),
	run: {
		state: "running",
		streaming: true,
		bashRunning: false,
		pythonRunning: false,
		compacting: false,
		retrying: false,
		postPromptWork: false,
		queuedMessages: 0,
	},
	tools: { available: 12, pending: 0, calls: 4, results: 4 },
	recordedTotals: fixtureRecordedUsage,
	activeTotals: fixtureActiveUsage,
	liveProgress: fixtureLiveUsage,
	context: {
		tokens: 48000,
		contextWindow: 128000,
		percent: 37.5,
		source: "provider_anchor",
		note: t("showcase.infoContextNote"),
	},
	accountQuota: { available: false, reason: t("showcase.infoQuotaUnavailable") },
	actualBilledCost: { available: false, reason: t("showcase.infoBilledUnavailable") },
};
const fixtureZeroUsage: DesktopSessionInfoUsage = {
	...fixtureRecordedUsage,
	note: t("showcase.infoZeroNote"),
	tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	premiumRequests: 0,
	cost: {
		amount: 0,
		source: "sdk_recorded_cost",
		reason: t("showcase.infoZeroCostReason"),
	},
};
const fixtureUnknownUsage: DesktopSessionInfoUsage = {
	...fixtureRecordedUsage,
	note: t("showcase.infoUnknownNote"),
	tokens: { input: null, output: null, cacheRead: null, cacheWrite: null, total: null },
	cost: {
		amount: null,
		source: "sdk_recorded_cost",
		reason: t("showcase.infoUnknownCostReason"),
	},
};
const fixtureInfoOverlap: SessionInfoFixture = { label: t("showcase.infoStateOverlap"), info: fixtureSessionInfo };
const fixtureSessionInfoStates: SessionInfoFixture[] = [
	fixtureInfoOverlap,
	{
		label: t("showcase.infoStateKnownZero"),
		info: {
			...fixtureSessionInfo,
			tools: { available: 0, pending: 0, calls: 0, results: 0 },
			recordedTotals: fixtureZeroUsage,
			activeTotals: { ...fixtureZeroUsage, source: "active_messages" },
			liveProgress: {
				...fixtureZeroUsage,
				source: "stream_partial",
				cost: {
					amount: 0,
					source: "live_partial_cost",
					reason: t("showcase.infoStateLiveZeroCostReason"),
				},
			},
			context: {
				tokens: 0,
				contextWindow: 128000,
				percent: 0,
				source: "heuristic",
				note: t("showcase.infoStateKnownZeroContextNote"),
			},
		},
	},
	{
		label: t("showcase.infoStateUnknownNotZero"),
		info: {
			...fixtureSessionInfo,
			model: null,
			thinkingLevel: null,
			run: { ...fixtureSessionInfo.run, queuedMessages: null },
			tools: { available: null, pending: null, calls: null, results: null },
			recordedTotals: fixtureUnknownUsage,
			activeTotals: { ...fixtureUnknownUsage, source: "active_messages" },
			liveProgress: {
				...fixtureUnknownUsage,
				source: "stream_partial",
				cost: { ...fixtureUnknownUsage.cost, source: "live_partial_cost" },
			},
			context: {
				tokens: null,
				contextWindow: null,
				percent: null,
				source: "unknown",
				note: t("showcase.infoStateUnknownContextNote"),
			},
		},
	},
	{
		label: t("showcase.infoStateHeuristicContext"),
		info: {
			...fixtureSessionInfo,
			context: {
				tokens: 32000,
				contextWindow: 128000,
				percent: 25,
				source: "heuristic",
				note: t("showcase.infoStateHeuristicNote"),
			},
		},
	},
	{
		label: t("showcase.infoStateTotalsUnavailable"),
		info: {
			...fixtureSessionInfo,
			recordedTotals: { available: false, reason: t("showcase.infoStateRecordedUnavailable") },
			activeTotals: { available: false, reason: t("showcase.infoStateActiveUnavailable") },
			liveProgress: { available: false, reason: t("showcase.infoStateLiveUnavailable") },
		},
	},
	{
		label: t("showcase.infoStateWorkingReads"),
		info: {
			...fixtureSessionInfo,
			run: {
				...fixtureSessionInfo.run,
				state: "running",
				streaming: true,
				bashRunning: true,
				pythonRunning: true,
				queuedMessages: 2,
			},
			tools: { available: 12, pending: 2, calls: 6, results: 4 },
		},
	},
	{
		label: t("showcase.infoStateSessionUnavailable"),
		info: {
			available: false,
			code: "backend_failure",
			reason: t("showcase.infoStateSessionUnavailableReason"),
		},
	},
	{ label: t("showcase.infoStatePending"), info: fixtureSessionInfo, pending: true },
	{
		label: t("showcase.infoStateError"),
		info: fixtureSessionInfo,
		error: t("showcase.infoStateErrorMessage"),
	},
	{ label: t("showcase.infoStateEmpty"), info: null },
];

function FixtureSessionInfoPanel() {
	const [fixture, setFixture] = useState(fixtureInfoOverlap);
	const [notice, setNotice] = useState(t("showcase.infoNoticeInitial"));
	return (
		<>
			<p className="fixture-note muted">{t("showcase.infoNote")}</p>
			<div className="actions" role="group" aria-label={t("showcase.infoStatesLabel")}>
				{fixtureSessionInfoStates.map(state => (
					<Button
						key={state.label}
						aria-pressed={fixture === state}
						onClick={() => {
							setFixture(state);
							setNotice(t("showcase.infoNoticeSelected", { label: state.label }));
						}}
					>
						{state.label}
					</Button>
				))}
			</div>
			<p className="showcase-result" role="status">
				{notice}
			</p>
			<SessionInfoPanel {...fixture} onRefresh={() => setNotice(t("showcase.infoNoticeRefresh"))} />
		</>
	);
}

interface BtwFixture extends Pick<BtwPanelProps, "conversation" | "disabled" | "pending"> {
	label: string;
}

const fixtureBtwQuestion = t("showcase.btwQuestion");
const fixtureBtwAnswer = t("showcase.btwAnswer");
const fixtureBtwCompletedTurn: DesktopBtwTurn = {
	turnId: "DESIGN-ONLY-btw-turn-1",
	question: fixtureBtwQuestion,
	answer: fixtureBtwAnswer,
	status: "completed",
	answerTruncated: false,
};
const fixtureBtwConversation: DesktopBtwConversation = {
	conversationId: "DESIGN-ONLY-btw-conversation",
	sessionGeneration: 0,
	revision: 1,
	turns: [fixtureBtwCompletedTurn],
};
const fixtureBtwEmpty: BtwFixture = {
	label: t("showcase.btwStateEmpty"),
	conversation: null,
	disabled: false,
	pending: false,
};
const fixtureBtwStates: BtwFixture[] = [
	fixtureBtwEmpty,
	{
		label: t("showcase.btwStateRunning"),
		conversation: {
			...fixtureBtwConversation,
			turns: [
				{
					...fixtureBtwCompletedTurn,
					answer: t("showcase.btwRunningAnswer"),
					status: "running",
				},
			],
		},
		disabled: false,
		pending: false,
	},
	{
		label: t("showcase.btwStateCancelRequested"),
		conversation: {
			...fixtureBtwConversation,
			turns: [
				{
					...fixtureBtwCompletedTurn,
					answer: t("showcase.btwCancelRequestedAnswer"),
					status: "cancel_requested",
				},
			],
		},
		disabled: false,
		pending: false,
	},
	{
		label: t("showcase.btwStateCancelled"),
		conversation: {
			...fixtureBtwConversation,
			turns: [
				{
					...fixtureBtwCompletedTurn,
					answer: t("showcase.btwCancelledAnswer"),
					status: "cancelled",
				},
			],
		},
		disabled: false,
		pending: false,
	},
	{
		label: t("showcase.btwStateDone"),
		conversation: {
			...fixtureBtwConversation,
			turns: [
				fixtureBtwCompletedTurn,
				{
					turnId: "DESIGN-ONLY-btw-turn-2",
					question: t("showcase.btwFollowUpQuestion"),
					answer: t("showcase.btwFollowUpAnswer"),
					status: "completed",
					answerTruncated: false,
				},
			],
		},
		disabled: false,
		pending: false,
	},
	{
		label: t("showcase.btwStateFailed"),
		conversation: {
			...fixtureBtwConversation,
			turns: [
				{
					...fixtureBtwCompletedTurn,
					answer: t("showcase.btwFailedAnswer"),
					status: "failed",
					error: {
						code: "provider_failure",
						message: t("showcase.btwFailedMessage"),
					},
				},
			],
		},
		disabled: false,
		pending: false,
	},
	{
		label: t("showcase.btwStateTruncated"),
		conversation: {
			...fixtureBtwConversation,
			turns: [
				{
					...fixtureBtwCompletedTurn,
					answer: `${fixtureBtwAnswer}\n\n${t("showcase.btwLongAnswerRepeat").repeat(18)}`,
					answerTruncated: true,
				},
			],
		},
		disabled: false,
		pending: false,
	},
	{ label: t("showcase.btwStateDisconnected"), conversation: fixtureBtwConversation, disabled: true, pending: false },
	{ label: t("showcase.btwStatePending"), conversation: fixtureBtwConversation, disabled: false, pending: true },
];

function FixtureBtwPanel() {
	const [fixture, setFixture] = useState(fixtureBtwEmpty);
	const [draft, setDraft] = useState(t("showcase.btwDraft"));
	const [notice, setNotice] = useState(t("showcase.btwNoticeInitial"));
	const active = fixture.conversation?.turns.find(
		turn => turn.status === "running" || turn.status === "cancel_requested",
	);
	return (
		<>
			<p className="fixture-note muted">{t("showcase.btwNote")}</p>
			<div className="actions" role="group" aria-label={t("showcase.btwStatesLabel")}>
				{fixtureBtwStates.map(state => (
					<Button
						key={state.label}
						aria-pressed={fixture.label === state.label}
						onClick={() => {
							setFixture(state);
							setNotice(t("showcase.btwNoticeSelected", { label: state.label }));
						}}
					>
						{state.label}
					</Button>
				))}
			</div>
			<p className="showcase-result" role="status">
				{notice}
			</p>
			<BtwPanel
				conversation={fixture.conversation}
				draft={draft}
				disabled={fixture.disabled}
				pending={fixture.pending}
				onDraftChange={setDraft}
				onSend={question => {
					const conversation = fixture.conversation ?? { ...fixtureBtwConversation, turns: [], revision: 0 };
					setFixture({
						label: t("showcase.btwLocalLabel"),
						disabled: false,
						pending: false,
						conversation: {
							...conversation,
							revision: conversation.revision + 1,
							turns: [
								...conversation.turns,
								{
									turnId: `DESIGN-ONLY-local-${conversation.revision + 1}`,
									question,
									answer: "",
									status: "running",
									answerTruncated: false,
								},
							],
						},
					});
					setDraft("");
					setNotice(t("showcase.btwNoticeSent"));
				}}
				onCancel={turnId => {
					setFixture(current => ({
						...current,
						conversation: current.conversation && {
							...current.conversation,
							revision: current.conversation.revision + 1,
							turns: current.conversation.turns.map(
								(turn): DesktopBtwTurn =>
									turn.turnId === turnId ? { ...turn, status: "cancel_requested" } : turn,
							),
						},
					}));
					setNotice(t("showcase.btwNoticeCancelRequested"));
				}}
			/>
			{active && (
				<div className="actions" role="group" aria-label={t("showcase.btwLocalControlsLabel")}>
					<Button
						disabled={active.status !== "running"}
						onClick={() => {
							setFixture(current => ({
								...current,
								conversation: current.conversation && {
									...current.conversation,
									revision: current.conversation.revision + 1,
									turns: current.conversation.turns.map(turn =>
										turn.turnId === active.turnId
											? {
													...turn,
													answer: `${turn.answer}\n${t("showcase.btwAppendedAnswer")}`,
												}
											: turn,
									),
								},
							}));
						}}
					>
						{t("showcase.btwAddPartial")}
					</Button>
					<Button
						onClick={() => {
							setFixture(current => ({
								...current,
								conversation: current.conversation && {
									...current.conversation,
									revision: current.conversation.revision + 1,
									turns: current.conversation.turns.map(
										(turn): DesktopBtwTurn =>
											turn.turnId === active.turnId
												? {
														...turn,
														status: active.status === "cancel_requested" ? "cancelled" : "completed",
														answer:
															active.status === "cancel_requested"
																? turn.answer
																: turn.answer || t("showcase.btwLocalDoneAnswer"),
													}
												: turn,
									),
								},
							}));
							setNotice(t("showcase.btwNoticeCompleted"));
						}}
					>
						{active.status === "cancel_requested"
							? t("showcase.btwCompleteCancelled")
							: t("showcase.btwCompleteDone")}
					</Button>
				</div>
			)}
		</>
	);
}

interface ForkFixture extends Pick<ForkPanelProps, "history" | "selectedEntryId" | "pending" | "disabled"> {
	label: string;
}

const fixtureForkLongText = `${t("showcase.forkLongTextLead")}${t("showcase.forkLongTextRepeat").repeat(18)}${t("showcase.forkLongTextTail")}`;
const fixtureForkHistory: DesktopHistory = {
	sessionId: "DESIGN-ONLY-fork-session",
	total: 4,
	offset: 0,
	truncated: false,
	messages: [
		{ id: "DESIGN-ONLY-display-1", entryId: "DESIGN-ONLY-entry-long", role: "user", text: fixtureForkLongText },
		{ id: "DESIGN-ONLY-display-2", role: "assistant", text: t("showcase.forkAssistantText") },
		{
			id: "DESIGN-ONLY-display-3",
			entryId: "DESIGN-ONLY-entry-duplicate-a",
			role: "user",
			text: t("showcase.forkDuplicateText"),
		},
		{
			id: "DESIGN-ONLY-display-4",
			entryId: "DESIGN-ONLY-entry-duplicate-b",
			role: "user",
			text: t("showcase.forkDuplicateText"),
		},
	],
};
const fixtureForkSelected: ForkFixture = {
	label: t("showcase.forkStateLongSource"),
	history: fixtureForkHistory,
	selectedEntryId: "DESIGN-ONLY-entry-long",
	pending: false,
	disabled: false,
};
const fixtureForkStates: ForkFixture[] = [
	{ ...fixtureForkSelected, label: t("showcase.forkStateLoading"), history: null, selectedEntryId: "" },
	{
		...fixtureForkSelected,
		label: t("showcase.forkStateEmpty"),
		history: { ...fixtureForkHistory, total: 0, messages: [] },
		selectedEntryId: "",
	},
	{ ...fixtureForkSelected, label: t("showcase.forkStateBeforeSelection"), selectedEntryId: "" },
	fixtureForkSelected,
	{
		...fixtureForkSelected,
		label: t("showcase.forkStateDuplicate"),
		selectedEntryId: "DESIGN-ONLY-entry-duplicate-b",
	},
	{
		...fixtureForkSelected,
		label: t("showcase.forkStateUnknownSelection"),
		selectedEntryId: "DESIGN-ONLY-no-longer-present",
	},
	{
		...fixtureForkSelected,
		label: t("showcase.forkStatePending"),
		pending: true,
		history: { ...fixtureForkHistory, total: 5, truncated: true },
	},
	{
		...fixtureForkSelected,
		label: t("showcase.forkStateDisconnected"),
		disabled: true,
		history: { ...fixtureForkHistory, total: 5, truncated: true },
	},
	{
		...fixtureForkSelected,
		label: t("showcase.forkStateTruncatedPreview"),
		history: {
			...fixtureForkHistory,
			total: 5,
			truncated: true,
			messages: fixtureForkHistory.messages.map(message =>
				message.entryId === "DESIGN-ONLY-entry-long" ? { ...message, truncated: true } : message,
			),
		},
	},
];

function FixtureForkPanel() {
	const [fixture, setFixture] = useState(fixtureForkSelected);
	const [notice, setNotice] = useState(t("showcase.forkNoticeInitial"));
	return (
		<>
			<p className="fixture-note muted">{t("showcase.forkNote")}</p>
			<div className="actions" role="group" aria-label={t("showcase.forkStatesLabel")}>
				{fixtureForkStates.map(state => (
					<Button
						key={state.label}
						aria-pressed={fixture.label === state.label}
						onClick={() => {
							setFixture(state);
							setNotice(t("showcase.forkNoticeSelected", { label: state.label }));
						}}
					>
						{state.label}
					</Button>
				))}
			</div>
			<p className="showcase-result" role="status">
				{notice}
			</p>
			<ForkPanel
				history={fixture.history}
				selectedEntryId={fixture.selectedEntryId}
				pending={fixture.pending}
				disabled={fixture.disabled}
				onSelect={entryId => {
					setFixture(current => ({ ...current, selectedEntryId: entryId }));
					setNotice(t("showcase.forkNoticeEntry", { entry: entryId || t("showcase.forkNoSelection") }));
				}}
				onFork={entryId =>
					setNotice(
						entryId === undefined
							? t("showcase.forkNoticeCopyAll")
							: t("showcase.forkNoticeForkEntry", { entry: entryId }),
					)
				}
				onLoadMore={() => {
					setFixture(current => ({
						...current,
						history: current.history && {
							...current.history,
							truncated: false,
							messages: [
								...current.history.messages,
								{
									id: "DESIGN-ONLY-display-next",
									entryId: "DESIGN-ONLY-entry-next",
									role: "user",
									text: t("showcase.forkAddedMessage"),
								},
							],
						},
					}));
					setNotice(t("showcase.forkNoticeLoadMore"));
				}}
			/>
			{fixture.history === null && <p>{t("showcase.forkLoading")}</p>}
		</>
	);
}

// The settings section renders the shipped tab bar with local fixture state, so the design
// harness reviews the real contract (ids, aria-controls, keyboard) instead of a mirror.
const fixtureSettingsThemes = [
	{ id: "red-claw", label: () => t("showcase.settingsThemeRedClaw") },
	{ id: "blue-crab", label: () => t("showcase.settingsThemeBlueCrab") },
	{ id: "codex", label: () => t("showcase.settingsThemeCodex") },
] as const;

function FixtureSettingsPanels({
	active,
	onSaved,
	prefix,
	saved,
}: {
	active: SettingsTab;
	onSaved: () => void;
	prefix: string;
	saved: boolean;
}) {
	return (
		<div className="settings-panels">
			<div
				className="settings-panel"
				id={settingsPanelId(prefix, "general")}
				role="tabpanel"
				aria-labelledby={settingsTabId(prefix, "general")}
				hidden={active !== "general"}
			>
				<SettingsSection
					id={`${prefix}-theme`}
					title={t("showcase.settingsThemeTitle")}
					hint={t("showcase.settingsThemeHint")}
				>
					<div className="theme-options" role="radiogroup" aria-label={t("showcase.settingsThemeGroupLabel")}>
						{fixtureSettingsThemes.map(theme => (
							<Button
								key={theme.id}
								className="theme-option"
								role="radio"
								aria-checked={theme.id === "red-claw"}
								tabIndex={theme.id === "red-claw" ? 0 : -1}
							>
								<span
									className="theme-swatch"
									aria-hidden="true"
									style={{
										background: `linear-gradient(135deg, ${DESKTOP_THEMES[theme.id].accent} 0 55%, ${DESKTOP_THEMES[theme.id].surface} 55% 100%)`,
									}}
								/>
								{theme.label()}
							</Button>
						))}
					</div>
				</SettingsSection>
			</div>
			<div
				className="settings-panel"
				id={settingsPanelId(prefix, "account")}
				role="tabpanel"
				aria-labelledby={settingsTabId(prefix, "account")}
				hidden={active !== "account"}
			>
				<SettingsSection
					id={`${prefix}-form`}
					title={t("showcase.settingsFormTitle")}
					hint={t("showcase.settingsFormHint")}
				>
					<form
						className="settings-form"
						onSubmit={event => {
							event.preventDefault();
							onSaved();
						}}
					>
						<label htmlFor={`${prefix}-key-field`}>{t("showcase.settingsFormKeyLabel")}</label>
						<input
							id={`${prefix}-key-field`}
							type="password"
							autoComplete="off"
							defaultValue={t("showcase.settingsFormKeyValue")}
							readOnly
						/>
						<Button type="submit" className="primary">
							{t("showcase.settingsFormSave")}
						</Button>
					</form>
					{saved && (
						<p className="settings-hint" role="status">
							{t("showcase.settingsFormSaved")}
						</p>
					)}
				</SettingsSection>
			</div>
			<div
				className="settings-panel"
				id={settingsPanelId(prefix, "settings")}
				role="tabpanel"
				aria-labelledby={settingsTabId(prefix, "settings")}
				hidden={active !== "settings"}
			>
				<SettingsSection
					id={`${prefix}-runtime`}
					title={t("showcase.settingsRuntimeTitle")}
					hint={t("showcase.settingsRuntimeHint")}
				>
					<p className="muted">{t("showcase.settingsRuntimeBody")}</p>
				</SettingsSection>
			</div>
			<div
				className="settings-panel"
				id={settingsPanelId(prefix, "capabilities")}
				role="tabpanel"
				aria-labelledby={settingsTabId(prefix, "capabilities")}
				hidden={active !== "capabilities"}
			>
				<SettingsSection
					id={`${prefix}-capabilities`}
					title={t("showcase.settingsCapabilitiesTitle")}
					hint={t("showcase.settingsCapabilitiesHint")}
				>
					<p className="muted">{t("showcase.settingsCapabilitiesBody")}</p>
				</SettingsSection>
			</div>
		</div>
	);
}

export default function Showcase() {
	useLocale();
	const [draft, setDraft] = useState("");
	const [attachments, setAttachments] = useState<DesktopAttachmentDraft[]>([]);
	const [populatedDraft, setPopulatedDraft] = useState(t("showcase.draftPopulated"));
	const [runningDraft, setRunningDraft] = useState(t("showcase.draftRunning"));
	const [dialog, setDialog] = useState(false);
	const [answer, setAnswer] = useState("");
	const [selected, setSelected] = useState("running");
	const [fixtureTab, setFixtureTab] = useState<SettingsTab>("general");
	const [fixtureKeySaved, setFixtureKeySaved] = useState(false);
	const [starred, setStarred] = useState<string[]>(["idle"]);
	const session: DesktopSession = {
		id: "showcase",
		projectId: "fixture",
		title: t("showcase.sessionTitle"),
		starred: false,
		status: "idle",
		imageInput: null,
		operatorRunning: false,
		controlGeneration: null,
		messages: [],
	};
	return (
		<main className="showcase">
			<header className="showcase-heading">
				<img className="brand-mark showcase-brand" src={gajaeMark} alt="" aria-hidden="true" />
				<span className="showcase-eyebrow">{t("showcase.eyebrow")}</span>
				<h1>{t("showcase.title")}</h1>
				<p>{t("showcase.intro")}</p>
				<nav className="showcase-index" aria-label={t("showcase.navLabel")}>
					<a href="#showcase-sessions">{t("showcase.navSessions")}</a>
					<a href="#showcase-messages">{t("showcase.navMessages")}</a>
					<a href="#showcase-questions">{t("showcase.navQuestions")}</a>
					<a href="#showcase-models">{t("showcase.navModels")}</a>
					<a href="#showcase-mcp">{t("showcase.navMcp")}</a>
					<a href="#showcase-session-info">{t("showcase.navSessionInfo")}</a>
					<a href="#showcase-btw">{t("showcase.navBtw")}</a>
					<a href="#showcase-fork">{t("showcase.navFork")}</a>
					<a href="#showcase-session-state">{t("showcase.navSessionState")}</a>
					<a href="#showcase-composers">{t("showcase.navComposers")}</a>
					<a href="#showcase-settings">{t("showcase.navSettings")}</a>
					<a href="#showcase-settings-tabs">{t("showcase.navSettingsTabs")}</a>
				</nav>
			</header>
			<section id="showcase-sessions">
				<h2>{t("showcase.sessionsHeading")}</h2>
				<p className="muted">{t("showcase.sessionsNote")}</p>
				{(["idle", "done", "running", "waiting", "error"] as const).map(status => (
					<SessionRow
						key={status}
						session={{ ...session, id: status, status, starred: starred.includes(status) }}
						selected={selected === status}
						onSelect={() => setSelected(status)}
						onStar={() =>
							setStarred(current =>
								current.includes(status) ? current.filter(id => id !== status) : [...current, status],
							)
						}
					/>
				))}
			</section>
			<section id="showcase-toolbar">
				<h2>{t("showcase.toolbarHeading")}</h2>
				<div className="actions">
					<Button onClick={() => setDialog(true)}>
						<Settings2 aria-hidden="true" />
						{t("showcase.openSettings")}
					</Button>
					<Button disabled>
						<LoaderCircle aria-hidden="true" />
						{t("showcase.loading")}
					</Button>
					<Button className="primary" onClick={() => setAnswer(t("showcase.answerNewConversation"))}>
						<Plus aria-hidden="true" />
						{t("showcase.newConversation")}
					</Button>
					<Button disabled>
						<Command aria-hidden="true" />
						{t("showcase.unavailable")}
					</Button>
				</div>
				<p className="path">{t("showcase.longPath")}</p>
			</section>
			<section id="showcase-messages">
				<h2>{t("showcase.messagesHeading")}</h2>
				<Message
					message={{
						id: "1",
						role: "user",
						text: t("showcase.userMessage"),
					}}
				/>
				<Message
					message={{
						id: "2",
						role: "assistant",
						text: t("showcase.assistantMarkdown"),
					}}
				/>
				<Message
					message={{
						id: "3",
						role: "tool",
						toolName: "read",
						text: Array.from({ length: 100 }, (_, index) =>
							t("showcase.toolLongOutputLine", { line: index + 1 }),
						).join("\n"),
						truncated: true,
					}}
				/>
				<Message
					message={{
						id: "4",
						role: "tool",
						toolName: "bash",
						isError: true,
						text: t("showcase.toolErrorOutput"),
					}}
				/>
				<div id="showcase-message-empty-assistant">
					<p className="muted">{t("showcase.emptyAssistantNote")}</p>
					<Message message={{ id: "5", role: "assistant", text: "" }} />
				</div>
				<div id="showcase-message-thinking">
					<p className="muted">{t("showcase.thinkingOnlyNote")}</p>
					<Message
						message={{
							id: "thinking",
							role: "assistant",
							text: "",
							blocks: [
								{
									type: "thinking",
									text: t("showcase.thinkingOnlyMarkdown"),
								},
							],
						}}
					/>
				</div>
				<div id="showcase-message-image-only">
					<p className="muted">{t("showcase.imageOnlyNote")}</p>
					<Message
						message={{
							id: "image",
							role: "user",
							text: "",
							blocks: [{ type: "image", mimeType: "image/png", data: transcriptPreviewImage }],
						}}
					/>
				</div>
				<div id="showcase-message-mixed">
					<p className="muted">{t("showcase.mixedNote")}</p>
					<Message
						message={{
							id: "mixed",
							role: "assistant",
							text: "",
							blocks: [
								{ type: "text", text: t("showcase.mixedBefore") },
								{ type: "thinking", text: t("showcase.mixedThinking") },
								{ type: "image", mimeType: "image/png", data: transcriptPreviewImage },
								{ type: "text", text: t("showcase.mixedAfter") },
							],
						}}
					/>
				</div>
				<div id="showcase-message-tool-image">
					<p className="muted">{t("showcase.toolImageNote")}</p>
					<Message
						message={{
							id: "tool-image",
							role: "tool",
							toolName: "read",
							text: "",
							blocks: [
								{ type: "text", text: t("showcase.toolImageText") },
								{ type: "image", mimeType: "image/png", data: transcriptPreviewImage },
							],
						}}
					/>
				</div>
				<div id="showcase-message-image-unavailable">
					<p className="muted">{t("showcase.imageUnavailableNote")}</p>
					<Message
						message={{
							id: "unavailable",
							role: "assistant",
							text: "",
							blocks: [
								{ type: "image-unavailable", reason: t("showcase.imageUnavailableReason") },
								{ type: "image", mimeType: "image/png", data: "AAAA" },
							],
						}}
					/>
				</div>
				<Message
					message={{
						id: "6",
						role: "system",
						text: t("showcase.systemMessage"),
					}}
				/>
			</section>
			<section id="showcase-questions">
				<h2>{t("showcase.questionsHeading")}</h2>
				{(["select", "confirm", "input", "editor"] as const).map(kind => (
					<QuestionCard
						key={kind}
						question={{
							id: kind,
							sessionId: "showcase",
							kind,
							title: t("showcase.questionTitle", { kind }),
							options: [
								t("showcase.questionOptionKeep"),
								t("showcase.questionOptionReview"),
								t("showcase.questionOptionLong"),
							],
							initialValue: kind === "editor" ? t("showcase.questionEditorValue") : "",
							message: t("showcase.questionMessage"),
						}}
						onAnswer={value => setAnswer(t("showcase.questionAnswerNotice", { value: String(value) }))}
					/>
				))}
				<QuestionCard
					question={{
						id: "pending",
						sessionId: "showcase",
						kind: "input",
						title: t("showcase.questionPendingTitle"),
						initialValue: t("showcase.questionPendingValue"),
						message: t("showcase.questionPendingMessage"),
					}}
					pending
					onAnswer={() => {}}
				/>
			</section>
			<section id="showcase-feedback">
				<h2>{t("showcase.feedbackHeading")}</h2>
				<ErrorBanner>{t("showcase.disconnectedBanner")}</ErrorBanner>
				<div className="empty">
					<MessageSquare aria-hidden="true" />
					<h2>{t("showcase.emptyTitle")}</h2>
					<p>{t("showcase.emptyBody")}</p>
				</div>
				<p className="notice">
					<CircleHelp aria-hidden="true" />
					{t("showcase.noticeUnsupported")}
				</p>
			</section>
			<section id="showcase-models">
				<h2>{t("showcase.modelsHeading")}</h2>
				<p className="muted">{t("showcase.modelsNote")}</p>
				<h3>{t("showcase.modelsActiveHeading")}</h3>
				<FixtureControls />
				<h3>{t("showcase.modelsDisabledHeading")}</h3>
				<FixtureControls disabled />
				<h3>{t("showcase.modelsPendingHeading")}</h3>
				<FixtureControls pending />
				<h3>{t("showcase.modelsEmptyHeading")}</h3>
				<FixtureControls empty />
				<h3>{t("showcase.reasoningAlwaysOnHeading")}</h3>
				<ReasoningSelect
					thinking={{
						level: null,
						options: [],
						scope: "session",
						available: false,
						mode: "always-on",
						reason: t("showcase.reasoningAlwaysOnReason"),
					}}
					onChange={() => {}}
				/>
			</section>
			<section id="showcase-mcp">
				<h2>{t("showcase.mcpHeading")}</h2>
				<FixtureMcpPanel />
			</section>
			<section id="showcase-session-info">
				<h2>{t("showcase.sessionInfoHeading")}</h2>
				<FixtureSessionInfoPanel />
			</section>
			<section id="showcase-btw">
				<h2>{t("showcase.btwHeading")}</h2>
				<FixtureBtwPanel />
			</section>
			<section id="showcase-fork">
				<h2>{t("showcase.forkHeading")}</h2>
				<FixtureForkPanel />
			</section>
			<section id="showcase-session-state">
				<h2>{t("showcase.sessionStateHeading")}</h2>
				<p className="muted">{t("showcase.sessionStateNote")}</p>
				<h3>{t("showcase.sessionStateTodoHeading")}</h3>
				<TodoPanel
					phases={[
						{
							name: "Foundation",
							tasks: [
								{ content: "Read the shipped host projection", status: "completed" },
								{ content: "Project the live todo list", status: "in_progress" },
								{ content: "Render the checklist", status: "pending" },
							],
						},
						{ name: "Polish", tasks: [{ content: "Check the collapsed summary", status: "abandoned" }] },
					]}
				/>
				<h3>{t("showcase.sessionStateGoalHeading")}</h3>
				<GoalStrip
					goal={{
						objective: "Ship the desktop parity work end to end",
						status: "active",
						tokensUsed: 12,
						timeUsedSeconds: 3,
					}}
					onOperate={() => {}}
				/>
				<GoalStrip
					goal={{
						objective: "Paused example with its own actions",
						status: "paused",
						tokensUsed: 0,
						timeUsedSeconds: 0,
					}}
					onOperate={() => {}}
				/>
			</section>
			<section id="showcase-composers">
				<h2>{t("showcase.composersHeading")}</h2>
				<p className="muted">{t("showcase.composersNote")}</p>
				<h3>{t("showcase.composerEmptyHeading")}</h3>
				<Composer
					value={draft}
					onChange={setDraft}
					attachment={
						<AttachmentPicker
							sessionId="showcase"
							attachments={attachments}
							supportsImageInput
							onChange={(_session, update) => setAttachments(update)}
						/>
					}
					hasAttachments={attachments.length > 0}
					onSend={() => setAnswer(t("showcase.answerEmptySent"))}
					onStop={() => {}}
					onSlash={() => setAnswer(t("showcase.answerSlash"))}
					busy={false}
					controls={<FixtureControls />}
				/>
				<h3>{t("showcase.composerPopulatedHeading")}</h3>
				<Composer
					value={populatedDraft}
					onChange={setPopulatedDraft}
					onSend={() => setAnswer(t("showcase.answerPopulatedSent"))}
					onStop={() => {}}
					busy={false}
					controls={<FixtureControls />}
				/>
				<h3>{t("showcase.composerRunningHeading")}</h3>
				<Composer
					value=""
					onChange={() => {}}
					onSend={() => {}}
					onStop={() => setAnswer(t("showcase.answerStopped"))}
					busy
					controls={<FixtureControls running />}
				/>
				<h3>{t("showcase.composerRunningDraftHeading")}</h3>
				<Composer
					value={runningDraft}
					onChange={setRunningDraft}
					onSend={() => setAnswer(t("showcase.answerQueued"))}
					onStop={() => setAnswer(t("showcase.answerStopped"))}
					busy
					controls={<FixtureControls running />}
				/>
				<h3>{t("showcase.composerDisconnectedHeading")}</h3>
				<Composer
					value={t("showcase.composerDisconnectedDraft")}
					onChange={() => {}}
					onSend={() => {}}
					onStop={() => {}}
					busy={false}
					disabled
					controls={<FixtureControls disabled />}
				/>
				<h3>{t("showcase.composerPlainHeading")}</h3>
				<Composer
					value={draft}
					onChange={setDraft}
					onSend={() => setAnswer(t("showcase.answerPlainSent"))}
					onStop={() => {}}
					busy={false}
				/>
			</section>
			<section id="showcase-settings">
				<h2>{t("showcase.settingsHeading")}</h2>
				<SettingField
					setting={{
						path: "example.mode",
						value: "safe",
						type: "string",
						writable: true,
						choices: ["safe", "review"],
						description: t("showcase.settingDescription"),
					}}
					onSave={value => setAnswer(t("showcase.answerSetting", { value: String(value) }))}
				/>
				<SettingField
					setting={{ path: "example.readonly", value: true, type: "boolean", writable: false }}
					onSave={() => {}}
				/>
				<SettingField
					setting={{
						path: "example.pending",
						value: t("showcase.settingPendingValue"),
						type: "string",
						writable: true,
					}}
					pending
					onSave={() => {}}
				/>
			</section>
			<section id="showcase-settings-tabs">
				<h2>{t("showcase.settingsTabsHeading")}</h2>
				<p className="muted">{t("showcase.settingsTabsNote")}</p>
				<h3>{t("showcase.settingsTabsFullHeading")}</h3>
				<div className="settings-dialog">
					<SettingsTabs prefix="showcase-settings" active={fixtureTab} onSelect={setFixtureTab} />
					<FixtureSettingsPanels
						prefix="showcase-settings"
						active={fixtureTab}
						saved={fixtureKeySaved}
						onSaved={() => setFixtureKeySaved(true)}
					/>
				</div>
				<h3>{t("showcase.settingsTabsNarrowHeading")}</h3>
				<div className="settings-dialog" style={{ maxWidth: 320 }}>
					<SettingsTabs prefix="showcase-narrow" active={fixtureTab} onSelect={setFixtureTab} />
					{/* Both previews share the demo tab and saved flag, so they behave the same. */}
					<FixtureSettingsPanels
						prefix="showcase-narrow"
						active={fixtureTab}
						saved={fixtureKeySaved}
						onSaved={() => setFixtureKeySaved(true)}
					/>
				</div>
			</section>
			<p className="showcase-result" role="status">
				{answer || t("showcase.answerIdle")}
			</p>
			{dialog && (
				<Modal title={t("showcase.modalTitle")} onClose={() => setDialog(false)}>
					<p>{t("showcase.modalBody")}</p>
					<label>
						{t("showcase.modalFieldLabel")}
						<input type="password" autoComplete="off" />
					</label>
					<Button onClick={() => setDialog(false)}>{t("showcase.modalClose")}</Button>
				</Modal>
			)}
		</main>
	);
}
