import { CircleHelp, Command, LoaderCircle, MessageSquare, Plus, Settings2 } from "lucide-react";
import { useState } from "react";
import type { DesktopBtwConversation, DesktopBtwTurn } from "../../desktop-host/src/btw-protocol";
import type { DesktopMcpServer, DesktopMcpSnapshot } from "../../desktop-host/src/mcp-protocol";
import type {
	DesktopHistory,
	DesktopModel,
	DesktopSession,
	DesktopThinking,
	DesktopThinkingLevel,
} from "../../desktop-host/src/protocol";
import type { DesktopSessionInfo, DesktopSessionInfoUsage } from "../../desktop-host/src/session-info-protocol";
import { BtwPanel, type BtwPanelProps } from "./BtwPanel";
import { Button, Composer, ErrorBanner, Message, Modal, QuestionCard, SessionRow, SettingField } from "./components";
import { ForkPanel, type ForkPanelProps } from "./ForkPanel";
import { McpPanel, type McpPanelProps } from "./McpPanel";
import { ModelPicker } from "./ModelPicker";
import { ReasoningSelect } from "./ReasoningSelect";
import { SessionInfoPanel, type SessionInfoPanelProps } from "./SessionInfoPanel";
import "./styles.css";

const fixtureModels: DesktopModel[] = Array.from(
	{ length: 84 },
	(_, index): DesktopModel => ({
		id: `design-fixture/model-${index + 1}`,
		name:
			index === 0
				? "한국어와 TypeScript를 함께 검토하는 긴 이름의 디자인 예시 모델"
				: `디자인 예시 모델 ${index + 1}`,
		provider: index % 2 === 0 ? "design-fixture-a" : "design-fixture-b",
		contextWindow: 128000,
		reasoning: index !== 83,
		thinking:
			index === 83
				? { options: [] }
				: {
						mode: "effort",
						options: [
							{ value: "medium", label: "기본 예시", description: "실제 추론 설정이 아닌 디자인 예시입니다." },
							{ value: "high", label: "깊이 검토하는 예시", description: "긴 선택지의 줄바꿈을 검토합니다." },
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
	const [selectedId, setSelectedId] = useState("design-fixture/model-1");
	const [level, setLevel] = useState<DesktopThinkingLevel>("medium");
	const models = empty ? [] : fixtureModels;
	const selectedModel = models.find(model => model.id === selectedId);
	const thinking: DesktopThinking = {
		level: selectedModel?.reasoning ? level : null,
		options: selectedModel?.thinking.options ?? [],
		scope: selectedModel ? "session" : null,
		available: selectedModel?.reasoning ?? false,
		mode: selectedModel?.thinking.mode,
		reason: selectedModel?.reasoning ? undefined : "디자인 예시 · 사용할 추론 옵션이 없습니다.",
	};
	return (
		<div className="model-controls">
			<ModelPicker
				models={models}
				selectedId={empty ? undefined : selectedId}
				disabled={disabled}
				pending={pending}
				onSelect={setSelectedId}
			/>
			<ReasoningSelect thinking={thinking} disabled={disabled} pending={pending} onChange={setLevel} />
			<small className="model-control-status fixture-note">
				{running ? "실행 중 디자인 예시 · 실제 요청 없음" : "디자인 전용 · 실제 모델 아님"}
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
			label: "DESIGN-ONLY · 한국어와日本語と中文이 함께 있는 아주 긴 프로젝트 문서 검색 관리자 연결 예시",
			state: "connected",
			transport: "stdio",
			sharing: "per-session",
			toolCount: 12,
			controls: ["suspend", "reconnect"],
		},
	],
};
const fixtureMcpConnected: McpFixture = { label: "연결됨", snapshot: fixtureMcpSnapshot };
const fixtureMcpStates: McpFixture[] = [
	fixtureMcpConnected,
	{
		label: "일시 중지",
		snapshot: {
			...fixtureMcpSnapshot,
			servers: fixtureMcpSnapshot.servers.map(
				(server): DesktopMcpServer => ({ ...server, state: "suspended", controls: ["resume", "reconnect"] }),
			),
		},
	},
	{
		label: "제어 없음",
		snapshot: {
			...fixtureMcpSnapshot,
			servers: fixtureMcpSnapshot.servers.map((server): DesktopMcpServer => ({ ...server, controls: [] })),
		},
	},
	{
		label: "공유 관리자",
		snapshot: {
			...fixtureMcpSnapshot,
			servers: fixtureMcpSnapshot.servers.map((server): DesktopMcpServer => ({ ...server, sharing: "shared" })),
		},
	},
	{
		label: "알 수 없음",
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
		label: "사용 불가",
		snapshot: {
			...fixtureMcpSnapshot,
			available: false,
			servers: [],
			error: {
				code: "unavailable",
				message: "DESIGN-ONLY · 관리자 기능 제공 불가 예시입니다. 서버 종료나 자원 정산을 뜻하지 않습니다.",
			},
		},
	},
	{
		label: "효과 불명 오류",
		snapshot: {
			...fixtureMcpSnapshot,
			error: {
				code: "unknown_effect",
				message: "DESIGN-ONLY · 연결 변경 결과를 확인하지 못한 오류 예시입니다. 재개 성공을 뜻하지 않습니다.",
			},
		},
		error: "디자인 전용 · 전송 오류와 마지막 관리자 정보 표시 예시",
	},
	{ label: "요청 대기", snapshot: fixtureMcpSnapshot, pending: true },
	{ label: "작업 중 · 조회 가능", snapshot: fixtureMcpSnapshot, busy: true },
	{ label: "아직 정보 없음", snapshot: null },
];

function FixtureMcpPanel() {
	const [fixture, setFixture] = useState(fixtureMcpConnected);
	const [notice, setNotice] = useState(
		"DESIGN-ONLY · 버튼은 설명만 표시합니다. 실제 연결·도구 카탈로그·서버 상태를 변경하지 않습니다.",
	);
	return (
		<>
			<p className="fixture-note muted">
				디자인 전용 · 실제 McpPanel에 가상 표시 정보만 전달합니다. 관리자 연결·카탈로그 효과는 원격 자원 정산, 세션
				종료 또는 세션 도구 레지스트리 동기화를 보증하지 않습니다.
			</p>
			<div className="actions" role="group" aria-label="MCP 디자인 예시 상태">
				{fixtureMcpStates.map(state => (
					<Button
						key={state.label}
						aria-pressed={fixture === state}
						onClick={() => {
							setFixture(state);
							setNotice(
								`DESIGN-ONLY · ${state.label} 표시 예시를 선택했습니다. SDK 요청이나 실제 연결 변경은 없습니다.`,
							);
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
				onRefresh={() =>
					setNotice("DESIGN-ONLY · 새로고침 버튼 검토입니다. SDK 조회를 보내지 않았으며 예시 정보는 그대로입니다.")
				}
				onOperate={(_ref, action) =>
					setNotice(
						`DESIGN-ONLY · ${action} 버튼 검토입니다. SDK 호출 없음 · 서버를 중지·재개·재연결하지 않았습니다. 표시 상태와 정리 보증은 바뀌지 않습니다.`,
					)
				}
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
	note: "DESIGN-ONLY · 비활성 분기를 포함하는 가상 기록입니다. 활성 목록과 스트림 일부를 더하지 않습니다. 저장 완료 증명이 아닙니다.",
	tokens: { input: 2400, output: 400, cacheRead: 600, cacheWrite: 0, total: 2800 },
	premiumRequests: null,
	cost: {
		amount: 0.012,
		source: "sdk_recorded_cost",
		reason: "디자인 전용 가상 SDK 기록 값 · 통화·실제 청구·잔액·할당량을 뜻하지 않습니다.",
	},
};
const fixtureActiveUsage: DesktopSessionInfoUsage = {
	...fixtureRecordedUsage,
	source: "active_messages",
	note: "DESIGN-ONLY · 기록 집계와 겹치는 활성 목록입니다. 스트림 일부는 제외하며 별도 합산하지 않습니다.",
	tokens: { input: 1600, output: 200, cacheRead: 400, cacheWrite: 0, total: 1800 },
	cost: {
		amount: 0.008,
		source: "sdk_recorded_cost",
		reason: "디자인 전용 가상 SDK 기록 비용 · 전체 기록 비용에 더하지 않습니다.",
	},
};
const fixtureLiveUsage: DesktopSessionInfoUsage = {
	...fixtureRecordedUsage,
	source: "stream_partial",
	note: "DESIGN-ONLY · 진행 중인 가상 스트림 일부입니다. 잠정·미청구이며 다른 집계와 합산하지 않습니다.",
	tokens: { input: null, output: 70, cacheRead: null, cacheWrite: null, total: null },
	cost: {
		amount: 0.0003,
		source: "live_partial_cost",
		reason: "디자인 전용 잠정 값 · 청구 확정이나 최종 합계가 아닙니다.",
	},
};
const fixtureSessionInfo: AvailableFixtureInfo = {
	available: true,
	metadata: {
		catalogSessionId: "DESIGN-ONLY-catalog-not-a-real-session",
		name: "DESIGN-ONLY · 긴 한국어 프로젝트의 문맥과 실행 정보를 검토하는 日本語・中文 혼합 세션 이름",
		sessionFileDisplay: "/DESIGN-ONLY/[가림]/아주-긴-한국어-日本語-中文-프로젝트/기록/표시-전용-세션.jsonl",
		cwd: "/DESIGN-ONLY/표시-전용/한국어-日本語-中文-프로젝트/packages/아주-긴-작업-디렉터리",
		createdAt: null,
		persisted: false,
	},
	model: {
		provider: "design-fixture",
		id: "DESIGN-ONLY/model",
		name: "디자인 전용 · 실제 연결 없는 한국어와日本語 모델 표시 예시",
	},
	thinkingLevel: "디자인 전용 사고 수준 표시",
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
		note: "DESIGN-ONLY · 가상 공급자 기준점에 후속 휴리스틱 추정을 더한 문맥 예시입니다. 정확한 실측값이 아닙니다.",
	},
	accountQuota: { available: false, reason: "디자인 전용 · 계정 할당량은 제공되지 않습니다." },
	actualBilledCost: { available: false, reason: "디자인 전용 · 실제 청구액은 제공되지 않습니다." },
};
const fixtureZeroUsage: DesktopSessionInfoUsage = {
	...fixtureRecordedUsage,
	note: "DESIGN-ONLY · 명시적으로 알려진 0의 표시 예시입니다. 누락·알 수 없음과 구별합니다.",
	tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	premiumRequests: 0,
	cost: {
		amount: 0,
		source: "sdk_recorded_cost",
		reason: "디자인 전용 · 가격 출처가 있는 명시적 기록 비용 0을 가정한 예시입니다. 실제 청구액이 아닙니다.",
	},
};
const fixtureUnknownUsage: DesktopSessionInfoUsage = {
	...fixtureRecordedUsage,
	note: "DESIGN-ONLY · 누락된 카운터 예시입니다. 알 수 없음은 0이 아닙니다.",
	tokens: { input: null, output: null, cacheRead: null, cacheWrite: null, total: null },
	cost: {
		amount: null,
		source: "sdk_recorded_cost",
		reason: "디자인 전용 · 가격 출처가 없으므로 비용을 알 수 없습니다.",
	},
};
const fixtureInfoOverlap: SessionInfoFixture = { label: "겹치는 집계 · 공급자 기준점", info: fixtureSessionInfo };
const fixtureSessionInfoStates: SessionInfoFixture[] = [
	fixtureInfoOverlap,
	{
		label: "알려진 0",
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
					reason: "DESIGN-ONLY · 명시적 잠정 비용 0의 예시 · 미청구이며 기록 비용에 더하지 않습니다.",
				},
			},
			context: {
				tokens: 0,
				contextWindow: 128000,
				percent: 0,
				source: "heuristic",
				note: "DESIGN-ONLY · 알려진 0의 휴리스틱 추정 예시입니다.",
			},
		},
	},
	{
		label: "알 수 없음 ≠ 0",
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
				note: "DESIGN-ONLY · 문맥 출처와 값을 알 수 없는 예시입니다.",
			},
		},
	},
	{
		label: "휴리스틱 문맥",
		info: {
			...fixtureSessionInfo,
			context: {
				tokens: 32000,
				contextWindow: 128000,
				percent: 25,
				source: "heuristic",
				note: "DESIGN-ONLY · 공급자 기준점 없이 휴리스틱만 사용한 가상 추정입니다. 청구 사용량이 아닙니다.",
			},
		},
	},
	{
		label: "집계 제공 불가",
		info: {
			...fixtureSessionInfo,
			recordedTotals: { available: false, reason: "DESIGN-ONLY · 기록 집계 제공 불가 예시" },
			activeTotals: { available: false, reason: "DESIGN-ONLY · 활성 집계 제공 불가 예시" },
			liveProgress: { available: false, reason: "DESIGN-ONLY · 스트림 일부 제공 불가 예시" },
		},
	},
	{
		label: "작업 중 읽기 · 셸/Python",
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
		label: "세션 정보 사용 불가",
		info: {
			available: false,
			code: "backend_failure",
			reason: "DESIGN-ONLY · 세션 정보 조회 불가 예시입니다. 값이 0이거나 작업이 종료되었다는 뜻은 아닙니다.",
		},
	},
	{ label: "조회 대기 · 마지막 정보", info: fixtureSessionInfo, pending: true },
	{
		label: "조회 오류 · 마지막 정보",
		info: fixtureSessionInfo,
		error: "DESIGN-ONLY · 읽기 요청 실패 예시입니다. 마지막 표시 정보는 현재 상태를 보증하지 않습니다.",
	},
	{ label: "아직 정보 없음", info: null },
];

function FixtureSessionInfoPanel() {
	const [fixture, setFixture] = useState(fixtureInfoOverlap);
	const [notice, setNotice] = useState(
		"DESIGN-ONLY · 경로와 ID는 가상 표시 문자열입니다. 파일 열기·기록 저장·네이티브 기능·모델 요청이 없습니다.",
	);
	return (
		<>
			<p className="fixture-note muted">
				디자인 전용 · 실제 SessionInfoPanel에 가상 값만 전달합니다. 기록·활성 목록·잠정 스트림은 겹치므로 합산하지
				않습니다. 알 수 없음은 0이 아니며 비용은 실제 청구·계정 잔액·할당량이 아닙니다.
			</p>
			<div className="actions" role="group" aria-label="세션 정보 디자인 예시 상태">
				{fixtureSessionInfoStates.map(state => (
					<Button
						key={state.label}
						aria-pressed={fixture === state}
						onClick={() => {
							setFixture(state);
							setNotice(
								`DESIGN-ONLY · ${state.label} 표시 예시를 선택했습니다. SDK·파일·네트워크에 접근하지 않았습니다.`,
							);
						}}
					>
						{state.label}
					</Button>
				))}
			</div>
			<p className="showcase-result" role="status">
				{notice}
			</p>
			<SessionInfoPanel
				{...fixture}
				onRefresh={() =>
					setNotice(
						"DESIGN-ONLY · 작업 중에도 활성인 읽기 전용 버튼 검토입니다. SDK 조회·모델 요청 없음 · 가상 정보는 그대로이며 새로 읽은 결과가 아닙니다.",
					)
				}
			/>
		</>
	);
}

interface BtwFixture extends Pick<BtwPanelProps, "conversation" | "disabled" | "pending"> {
	label: string;
}

const fixtureBtwQuestion =
	"주 작업은 그대로 두고, frozen context의 의미만 설명해 주세요.\n  한국어와 TypeScript / 日本語 / 中文이 섞인 문장도 원래 줄바꿈을 유지하나요?";
const fixtureBtwAnswer =
	"DESIGN-ONLY · 곁대화를 열 때 고정한 문맥으로 답하는 예시입니다.\n\n주 대화에 새 메시지가 생겨도 이 문맥은 바뀌지 않습니다. 도구를 실행하거나 주 대화 기록에 답변을 쓰지 않습니다.\n  들여쓰기가 있는 설명도 그대로 표시합니다.\n\n긴 경로 예시: /DESIGN-ONLY/한국어와-English가-섞인-프로젝트/packages/desktop/src/아주긴단일토큰경로와followUpContextOwnershipBoundary.ts";
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
const fixtureBtwEmpty: BtwFixture = { label: "빈 곁대화", conversation: null, disabled: false, pending: false };
const fixtureBtwStates: BtwFixture[] = [
	fixtureBtwEmpty,
	{
		label: "응답 중 · 부분 출력",
		conversation: {
			...fixtureBtwConversation,
			turns: [
				{
					...fixtureBtwCompletedTurn,
					answer: "DESIGN-ONLY · 고정한 문맥을 바탕으로 답하고 있습니다.\n\n두 번째 설명은 아직 작성 중이며",
					status: "running",
				},
			],
		},
		disabled: false,
		pending: false,
	},
	{
		label: "중지 요청 · 종료 미확인",
		conversation: {
			...fixtureBtwConversation,
			turns: [
				{
					...fixtureBtwCompletedTurn,
					answer:
						"DESIGN-ONLY · 여기까지 받은 부분 답변입니다.\n중지 요청 뒤에도 종료를 확인할 때까지 응답 중입니다.",
					status: "cancel_requested",
				},
			],
		},
		disabled: false,
		pending: false,
	},
	{
		label: "취소됨 · 부분 출력 보존",
		conversation: {
			...fixtureBtwConversation,
			turns: [
				{
					...fixtureBtwCompletedTurn,
					answer: "DESIGN-ONLY · 취소 전에 받은 부분 답변을 보존합니다.\n  이어 쓰지 못한 문장도 그대로 남습니다.",
					status: "cancelled",
				},
			],
		},
		disabled: false,
		pending: false,
	},
	{
		label: "완료 · 후속 질문",
		conversation: {
			...fixtureBtwConversation,
			turns: [
				fixtureBtwCompletedTurn,
				{
					turnId: "DESIGN-ONLY-btw-turn-2",
					question: "그럼 방금 설명한 frozen context로 후속 질문도 이어지나요?",
					answer:
						"DESIGN-ONLY · 네. 이 곁대화의 앞선 질문과 답변을 이어 보며 답합니다. 주 대화의 새 기록과는 별개입니다.",
					status: "completed",
					answerTruncated: false,
				},
			],
		},
		disabled: false,
		pending: false,
	},
	{
		label: "실패 · 받은 출력 보존",
		conversation: {
			...fixtureBtwConversation,
			turns: [
				{
					...fixtureBtwCompletedTurn,
					answer: "DESIGN-ONLY · 실패 전에 받은 답변 일부입니다.",
					status: "failed",
					error: {
						code: "provider_failure",
						message: "DESIGN-ONLY · 응답 연결 오류 예시입니다. 다시 질문하기 전 초안을 검토하세요.",
					},
				},
			],
		},
		disabled: false,
		pending: false,
	},
	{
		label: "출력 생략 · 긴 내용",
		conversation: {
			...fixtureBtwConversation,
			turns: [
				{
					...fixtureBtwCompletedTurn,
					answer: `${fixtureBtwAnswer}\n\n${"한국어 의미 단위와 mixed-language 줄바꿈을 확인하는 긴 답변 예시입니다.\n".repeat(18)}`,
					answerTruncated: true,
				},
			],
		},
		disabled: false,
		pending: false,
	},
	{ label: "연결 끊김 · 초안 보존", conversation: fixtureBtwConversation, disabled: true, pending: false },
	{ label: "요청 처리 대기 · 초안 보존", conversation: fixtureBtwConversation, disabled: false, pending: true },
];

function FixtureBtwPanel() {
	const [fixture, setFixture] = useState(fixtureBtwEmpty);
	const [draft, setDraft] = useState(
		"주 작업과 별개로 궁금한 점을 적어 둡니다.\n  이 초안은 예시 상태를 바꿔도 유지됩니다.",
	);
	const [notice, setNotice] = useState(
		"DESIGN-ONLY · 실제 BtwPanel의 로컬 상태 예시입니다. 모델·SDK·네트워크 요청이나 주 대화 변경은 없습니다.",
	);
	const active = fixture.conversation?.turns.find(
		turn => turn.status === "running" || turn.status === "cancel_requested",
	);
	return (
		<>
			<p className="fixture-note muted">
				디자인 전용 · 아래 버튼으로 모든 표시 상태를 선택하세요. 보내기는 가상 질문을 접수하고, 중지 요청과 완료
				확인은 서로 다른 로컬 단계입니다.
			</p>
			<div className="actions" role="group" aria-label="BTW 곁대화 디자인 예시 상태">
				{fixtureBtwStates.map(state => (
					<Button
						key={state.label}
						aria-pressed={fixture.label === state.label}
						onClick={() => {
							setFixture(state);
							setNotice(`DESIGN-ONLY · ${state.label} 표시 예시입니다. 입력한 초안은 바꾸지 않습니다.`);
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
						label: "로컬 질문 접수",
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
					setNotice(
						"DESIGN-ONLY · 로컬 접수를 모사한 뒤 fixture가 초안을 비웠습니다. 부분 답변 추가와 응답 완료 예시를 눌러 이어 보세요.",
					);
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
					setNotice(
						"DESIGN-ONLY · 이 곁대화 턴의 중지 요청만 모사했습니다. 취소 완료 예시를 누르기 전에는 종료 상태가 아닙니다.",
					);
				}}
			/>
			{active && (
				<div className="actions" role="group" aria-label="BTW 로컬 응답 진행 예시">
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
													answer: `${turn.answer}\nDESIGN-ONLY · 추가로 받은 부분 답변입니다. 한국어와 TypeScript 설명을 이어 갑니다.`,
												}
											: turn,
									),
								},
							}));
						}}
					>
						부분 답변 추가 예시
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
																: turn.answer || "DESIGN-ONLY · 로컬 완료 답변입니다.",
													}
												: turn,
									),
								},
							}));
							setNotice("DESIGN-ONLY · 로컬 종료 확인 예시입니다. 다음 질문을 같은 곁대화에 이어 보세요.");
						}}
					>
						{active.status === "cancel_requested" ? "취소 완료 예시" : "응답 완료 예시"}
					</Button>
				</div>
			)}
		</>
	);
}

interface ForkFixture extends Pick<ForkPanelProps, "history" | "selectedEntryId" | "pending" | "disabled"> {
	label: string;
}

const fixtureForkLongText = `DESIGN-ONLY · 한국어와 TypeScript / 日本語 / 中文 원문을 검토합니다.\n  들여쓰기와 줄바꿈은 보존됩니다.\n\n${"긴 미리보기에서 의미 단위 줄바꿈과 내부 스크롤을 확인합니다.\n".repeat(18)}/DESIGN-ONLY/아주긴단일토큰경로와originalSelectedTextMustComeFromSdkTransaction.ts`;
const fixtureForkHistory: DesktopHistory = {
	sessionId: "DESIGN-ONLY-fork-session",
	total: 4,
	offset: 0,
	truncated: false,
	messages: [
		{ id: "DESIGN-ONLY-display-1", entryId: "DESIGN-ONLY-entry-long", role: "user", text: fixtureForkLongText },
		{ id: "DESIGN-ONLY-display-2", role: "assistant", text: "DESIGN-ONLY · 사용자 선택지에 나오지 않는 응답입니다." },
		{
			id: "DESIGN-ONLY-display-3",
			entryId: "DESIGN-ONLY-entry-duplicate-a",
			role: "user",
			text: "DESIGN-ONLY · 같은 텍스트도 서로 다른 사용자 기록입니다.",
		},
		{
			id: "DESIGN-ONLY-display-4",
			entryId: "DESIGN-ONLY-entry-duplicate-b",
			role: "user",
			text: "DESIGN-ONLY · 같은 텍스트도 서로 다른 사용자 기록입니다.",
		},
	],
};
const fixtureForkSelected: ForkFixture = {
	label: "긴 원문 선택",
	history: fixtureForkHistory,
	selectedEntryId: "DESIGN-ONLY-entry-long",
	pending: false,
	disabled: false,
};
const fixtureForkStates: ForkFixture[] = [
	{ ...fixtureForkSelected, label: "기록 불러오는 중", history: null, selectedEntryId: "" },
	{
		...fixtureForkSelected,
		label: "빈 기록",
		history: { ...fixtureForkHistory, total: 0, messages: [] },
		selectedEntryId: "",
	},
	{ ...fixtureForkSelected, label: "선택 전", selectedEntryId: "" },
	fixtureForkSelected,
	{ ...fixtureForkSelected, label: "동일 텍스트 · 두 번째 기록", selectedEntryId: "DESIGN-ONLY-entry-duplicate-b" },
	{ ...fixtureForkSelected, label: "알 수 없는 선택", selectedEntryId: "DESIGN-ONLY-no-longer-present" },
	{
		...fixtureForkSelected,
		label: "요청 처리 대기",
		pending: true,
		history: { ...fixtureForkHistory, total: 5, truncated: true },
	},
	{
		...fixtureForkSelected,
		label: "연결 끊김",
		disabled: true,
		history: { ...fixtureForkHistory, total: 5, truncated: true },
	},
	{
		...fixtureForkSelected,
		label: "미리보기 생략 · 다음 기록",
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
	const [notice, setNotice] = useState(
		"DESIGN-ONLY · 실제 ForkPanel의 로컬 표시 예시입니다. SDK·네트워크 호출, 새 대화 생성, 초안·첨부 변경은 없습니다.",
	);
	return (
		<>
			<p className="fixture-note muted">
				디자인 전용 · 상태와 사용자 메시지 선택, 복사/분기, 다음 기록 버튼은 아래 로컬 예시에만 적용됩니다.
			</p>
			<div className="actions" role="group" aria-label="대화 분기 디자인 예시 상태">
				{fixtureForkStates.map(state => (
					<Button
						key={state.label}
						aria-pressed={fixture.label === state.label}
						onClick={() => {
							setFixture(state);
							setNotice(`DESIGN-ONLY · ${state.label} 로컬 표시입니다. 실제 대화와 초안은 바뀌지 않습니다.`);
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
					setNotice(
						`DESIGN-ONLY · 로컬 canonical entryId 선택: ${entryId || "선택 없음"}. 분기나 전송은 하지 않았습니다.`,
					);
				}}
				onFork={entryId =>
					setNotice(
						entryId === undefined
							? "DESIGN-ONLY · 전체 대화 복사 버튼의 로컬 동작 확인입니다. 새 대화 생성이나 SDK 요청은 없습니다."
							: `DESIGN-ONLY · 선택 분기 버튼의 로컬 entryId: ${entryId}. 새 대화·초안 변경이나 전송은 없습니다.`,
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
									text: "DESIGN-ONLY · 로컬로 추가한 다음 사용자 기록입니다.",
								},
							],
						},
					}));
					setNotice(
						"DESIGN-ONLY · 로컬 fixture에 다음 기록 하나만 추가했습니다. 호스트 조회나 네트워크 요청은 없습니다.",
					);
				}}
			/>
			{fixture.history === null && <p>DESIGN-ONLY · 전체 기록 불러오는 중… (App 소유 로딩 표시 예시)</p>}
		</>
	);
}

export default function Showcase() {
	const [draft, setDraft] = useState("");
	const [populatedDraft, setPopulatedDraft] = useState(
		"기존 구조를 유지하면서 한국어와 TypeScript 변경 사항을 검토해 주세요.",
	);
	const [runningDraft, setRunningDraft] = useState("실행 중에도 다음 메시지를 작성할 수 있습니다.");
	const [deliverAs, setDeliverAs] = useState<"steer" | "followUp">("steer");
	const [dialog, setDialog] = useState(false);
	const [answer, setAnswer] = useState("");
	const [selected, setSelected] = useState("running");
	const [starred, setStarred] = useState<string[]>(["idle"]);
	const session: DesktopSession = {
		id: "showcase",
		projectId: "fixture",
		title: "한국어와 TypeScript 프로젝트 검토 — 긴 대화 이름",
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
				<span className="showcase-eyebrow">GJC / 디자인 시스템</span>
				<h1>작업에 집중하는 대화 공간</h1>
				<p>
					모든 내용은 디자인 검토용 예시입니다. 실제 프로젝트, 모델, 연결 상태가 아니며 외부 요청을 보내지
					않습니다.
				</p>
				<nav className="showcase-index" aria-label="디자인 예시 탐색">
					<a href="#showcase-sessions">대화</a>
					<a href="#showcase-messages">메시지</a>
					<a href="#showcase-questions">질문</a>
					<a href="#showcase-models">모델</a>
					<a href="#showcase-mcp">MCP 관리자</a>
					<a href="#showcase-session-info">세션 정보</a>
					<a href="#showcase-btw">BTW 곁대화</a>
					<a href="#showcase-fork">대화 분기</a>
					<a href="#showcase-composers">입력</a>
					<a href="#showcase-settings">설정</a>
				</nav>
			</header>
			<section id="showcase-sessions">
				<h2>대화 · 선택과 백그라운드 상태</h2>
				<p className="muted">
					선택, 즐겨찾기, 실행 상태는 각각 독립적입니다. 아래 동작은 이 예시 화면에만 적용됩니다.
				</p>
				{(["idle", "running", "waiting", "error"] as const).map(status => (
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
				<h2>도구 모음 · 기본 / 불러오는 중 / 비활성</h2>
				<div className="actions">
					<Button onClick={() => setDialog(true)}>
						<Settings2 aria-hidden="true" />
						설정 열기
					</Button>
					<Button disabled>
						<LoaderCircle aria-hidden="true" />
						불러오는 중…
					</Button>
					<Button className="primary" onClick={() => setAnswer("새 대화 디자인 예시를 선택했습니다.")}>
						<Plus aria-hidden="true" />새 대화 예시
					</Button>
					<Button disabled>
						<Command aria-hidden="true" />
						사용할 수 없음
					</Button>
				</div>
				<p className="path">
					/Users/developer/Projects/아주-긴-한국어-프로젝트/packages/coding-agent/src/session/long-running-background-session.ts
				</p>
			</section>
			<section id="showcase-messages">
				<h2>메시지와 도구 · 펼친 출력의 끝까지 검토</h2>
				<Message
					message={{
						id: "1",
						role: "user",
						text: "변경 사항을 검토하고 안전하게 정리해 주세요. English와 한국어가 함께 있어도 읽기 편해야 합니다.",
					}}
				/>
				<Message
					message={{
						id: "2",
						role: "assistant",
						text: "먼저 기존 구현을 살펴보겠습니다.\n대화별 작업은 독립적으로 진행됩니다.\n\n日本語の文章と 한국어 문장을 함께 검토합니다. 中文内容也需要保持清晰。",
					}}
				/>
				<Message
					message={{
						id: "3",
						role: "tool",
						toolName: "read",
						text: Array.from(
							{ length: 100 },
							(_, index) => `${index + 1}: 긴 출력과 경로 /packages/example/src/한국어-file.ts`,
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
						text: "권한이 없어 명령을 실행하지 못했습니다.\n비밀 값: [REDACTED]\n다시 시도하기 전에 프로젝트 권한을 확인하세요.",
					}}
				/>
				<Message message={{ id: "5", role: "assistant", text: "" }} />
				<Message
					message={{
						id: "6",
						role: "system",
						text: "연결되지 않은 상태의 디자인 예시입니다. 실행 성공을 의미하지 않습니다.",
					}}
				/>
			</section>
			<section id="showcase-questions">
				<h2>질문 · 선택 / 확인 / 입력 / 편집 / 전송 중</h2>
				{(["select", "confirm", "input", "editor"] as const).map(kind => (
					<QuestionCard
						key={kind}
						question={{
							id: kind,
							sessionId: "showcase",
							kind,
							title: `${kind} · 진행 방법을 선택하세요`,
							options: ["기존 구조 유지", "변경 검토", "한국어와 English를 함께 검토하는 긴 선택지"],
							initialValue: kind === "editor" ? "여러 줄 편집\n검토 내용" : "",
							message: "디자인 예시입니다. 답변은 이 화면에서만 표시됩니다.",
						}}
						onAnswer={value => setAnswer(`질문 디자인 예시: ${String(value)}`)}
					/>
				))}
				<QuestionCard
					question={{
						id: "pending",
						sessionId: "showcase",
						kind: "input",
						title: "답변을 보내는 중인 디자인 예시",
						initialValue: "보존된 답변",
						message: "중복 답변은 비활성 상태입니다.",
					}}
					pending
					onAnswer={() => {}}
				/>
			</section>
			<section id="showcase-feedback">
				<h2>오류 / 빈 상태 / 명시적 사용 불가</h2>
				<ErrorBanner>호스트 연결이 끊어졌습니다. 입력한 초안은 유지됩니다.</ErrorBanner>
				<div className="empty">
					<MessageSquare aria-hidden="true" />
					<h2>아직 대화가 없습니다</h2>
					<p>프로젝트에서 새 대화를 시작하세요. 이 화면은 빈 상태 디자인 예시입니다.</p>
				</div>
				<p className="notice">
					<CircleHelp aria-hidden="true" />
					지원되지 않음 · 공개 SDK 지원 대기 · 디자인 예시
				</p>
			</section>
			<section id="showcase-models">
				<h2>실제 컴포넌트 · 모델과 추론 디자인 예시</h2>
				<p className="muted">
					84개 명시적 디자인 모델로 검색, 80개 제한과 더 보기, 선택 표시, 방향키와 Home/End를 검토하세요. 실제
					제공자 연결이나 요청은 없습니다.
				</p>
				<h3>활성 · 긴 모델 이름 / 두 예시 제공자 / 로컬 선택</h3>
				<FixtureControls />
				<h3>비활성 · 선택값 보존</h3>
				<FixtureControls disabled />
				<h3>적용 중 디자인 예시 · 중복 조작 비활성</h3>
				<FixtureControls pending />
				<h3>결과 없음 · 빈 예시 목록의 검색창 열기</h3>
				<FixtureControls empty />
				<h3>항상 켜진 추론 · 변경할 수 없는 상태의 디자인 예시</h3>
				<ReasoningSelect
					thinking={{
						level: null,
						options: [],
						scope: "session",
						available: false,
						mode: "always-on",
						reason: "디자인 예시 · 추론은 항상 켜져 있습니다.",
					}}
					onChange={() => {}}
				/>
			</section>
			<section id="showcase-mcp">
				<h2>실제 컴포넌트 · MCP 관리자 DESIGN-ONLY</h2>
				<FixtureMcpPanel />
			</section>
			<section id="showcase-session-info">
				<h2>실제 컴포넌트 · 세션 정보 DESIGN-ONLY</h2>
				<FixtureSessionInfoPanel />
			</section>
			<section id="showcase-btw">
				<h2>실제 컴포넌트 · BTW 격리된 곁대화 DESIGN-ONLY</h2>
				<FixtureBtwPanel />
			</section>
			<section id="showcase-fork">
				<h2>실제 컴포넌트 · 대화 분기 DESIGN-ONLY</h2>
				<FixtureForkPanel />
			</section>
			<section id="showcase-composers">
				<h2>입력과 컨트롤 슬롯</h2>
				<p className="muted">
					예시 선택값과 버튼은 디자인 검토용 로컬 상태입니다. 실제 모델 설정이나 작업을 변경하지 않습니다.
				</p>
				<h3>빈 초안 · 입력과 예시 컨트롤 활성</h3>
				<Composer
					value={draft}
					onChange={setDraft}
					onSend={() => setAnswer("빈 초안 디자인 예시에서 전송했습니다.")}
					onStop={() => {}}
					onSlash={() => setAnswer("슬래시 명령 디자인 예시입니다.")}
					busy={false}
					controls={<FixtureControls />}
				/>
				<h3>작성된 초안 · 줄바꿈과 키보드 전송</h3>
				<Composer
					value={populatedDraft}
					onChange={setPopulatedDraft}
					onSend={() => setAnswer("작성된 초안 디자인 예시에서 전송했습니다.")}
					onStop={() => {}}
					busy={false}
					controls={<FixtureControls />}
				/>
				<h3>실행 중 · 전달 방식 / 중지 / 대기열</h3>
				<Composer
					value={runningDraft}
					onChange={setRunningDraft}
					onSend={() => setAnswer("대기열 추가 디자인 예시입니다.")}
					onStop={() => setAnswer("작업 중지 디자인 예시입니다.")}
					busy
					deliverAs={deliverAs}
					onDeliverAs={setDeliverAs}
					controls={<FixtureControls running />}
				/>
				<h3>연결 실패 · 초안 보존 / 컨트롤 비활성</h3>
				<Composer
					value="연결 실패 후 보존된 초안"
					onChange={() => {}}
					onSend={() => {}}
					onStop={() => {}}
					busy={false}
					disabled
					controls={<FixtureControls disabled />}
				/>
				<h3>추가 컨트롤 없는 기본 입력</h3>
				<Composer
					value={draft}
					onChange={setDraft}
					onSend={() => setAnswer("기본 입력 디자인 예시에서 전송했습니다.")}
					onStop={() => {}}
					busy={false}
				/>
			</section>
			<section id="showcase-settings">
				<h2>설정 필드 · 편집 / 읽기 전용 / 저장 중</h2>
				<SettingField
					setting={{
						path: "example.mode",
						value: "safe",
						type: "string",
						writable: true,
						choices: ["safe", "review"],
						description: "로컬 디자인 예시의 선택값입니다.",
					}}
					onSave={value => setAnswer(`설정 디자인 예시: ${String(value)}`)}
				/>
				<SettingField
					setting={{ path: "example.readonly", value: true, type: "boolean", writable: false }}
					onSave={() => {}}
				/>
				<SettingField
					setting={{ path: "example.pending", value: "보존된 설정값", type: "string", writable: true }}
					pending
					onSave={() => {}}
				/>
			</section>
			<p className="showcase-result" role="status">
				{answer || "디자인 예시 동작 결과가 여기에 표시됩니다."}
			</p>
			{dialog && (
				<Modal title="설정 · 키보드 포커스 검토" onClose={() => setDialog(false)}>
					<p>디자인 예시입니다. Tab 순환, Escape 닫기, 트리거 포커스 복원을 확인하세요.</p>
					<label>
						예시 비밀 입력
						<input type="password" autoComplete="off" />
					</label>
					<Button onClick={() => setDialog(false)}>닫기</Button>
				</Modal>
			)}
		</main>
	);
}
