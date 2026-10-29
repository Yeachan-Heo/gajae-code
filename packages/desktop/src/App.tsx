import {
	Activity,
	Command,
	FileDiff,
	FolderOpen,
	History,
	Info,
	MoreHorizontal,
	Network,
	Pencil,
	Plus,
	Settings2,
	SlidersHorizontal,
	Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
	DesktopActivityDetail,
	DesktopActivityGateAnswer,
	DesktopActivityOperation,
	DesktopActivityRef,
	DesktopActivityScope,
} from "../../desktop-host/src/activity-protocol";
import type { DesktopGatePresentation } from "../../desktop-host/src/gate-presentation-protocol";
import type {
	DesktopMcpAction,
	DesktopMcpOperationResult,
	DesktopMcpRef,
	DesktopMcpSnapshot,
} from "../../desktop-host/src/mcp-protocol";
import type { DesktopOperatorFoldResult, DesktopOperatorOperation } from "../../desktop-host/src/operator-protocol";
import type {
	DesktopPreferenceAction,
	DesktopPreferenceResult,
	DesktopPreferences,
} from "../../desktop-host/src/preferences-protocol";
import type {
	DesktopActivityUpdate,
	DesktopCommand,
	DesktopCommandResult,
	DesktopCredentialSaveResult,
	DesktopDiff,
	DesktopForkResult,
	DesktopFrame,
	DesktopHistory,
	DesktopMethod,
	DesktopModel,
	DesktopSession,
	DesktopSetting,
	DesktopSnapshot,
} from "../../desktop-host/src/protocol";
import type { DesktopSessionInfo } from "../../desktop-host/src/session-info-protocol";
import { ActivityPanel } from "./ActivityPanel";
import {
	AttachmentPicker,
	addDesktopAttachmentFiles,
	type DesktopAttachmentDraft,
	desktopClipboardImageFiles,
	readyDesktopAttachments,
} from "./AttachmentPicker";
import { BtwDialog } from "./BtwDialog";
import { request, selectProject, subscribe } from "./bridge";
import { matchesSlashFilter } from "./command-search";
import { Button, Composer, ErrorBanner, Message, Modal, QuestionCard, SessionRow, SettingField } from "./components";
import { restoreAttachments, restoreDraft } from "./composer-draft";
import { ForkPanel } from "./ForkPanel";
import { GateDialog } from "./GateDialog";
import { McpPanel } from "./McpPanel";
import { ModelPicker } from "./ModelPicker";
import { OAuthSettings } from "./OAuthSettings";
import { OperatorPanel } from "./OperatorPanel";
import { PreferencesPanel } from "./PreferencesPanel";
import { ReasoningSelect } from "./ReasoningSelect";
import { SessionInfoPanel } from "./SessionInfoPanel";
import "./styles.css";

type Dialog =
	| "settings"
	| "commands"
	| "history"
	| "fork"
	| "rename"
	| "delete"
	| "tools"
	| "goal"
	| "result"
	| "activity"
	| "activity-detail"
	| "preferences"
	| "session-actions"
	| "operator"
	| "mcp"
	| "session-info"
	| "btw"
	| null;
interface GateView {
	sessionId: string;
	presentation: DesktopGatePresentation;
	presented: boolean;
	retiring?: { nonce: string };
}
const textOf = (value: unknown) =>
	typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "결과 없음");

export default function App() {
	const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null);
	const [selected, setSelected] = useState("");
	const selectedRef = useRef(selected);
	selectedRef.current = selected;
	const [activity, setActivity] = useState<DesktopActivityUpdate | null>(null);
	const [activityDetail, setActivityDetail] = useState<DesktopActivityDetail | null>(null);
	const [preferences, setPreferences] = useState<{ sessionId: string; value: DesktopPreferences } | null>(null);
	const [mcp, setMcp] = useState<{ sessionId: string; value: DesktopMcpSnapshot } | null>(null);
	const [sessionInfo, setSessionInfo] = useState<{ sessionId: string; value: DesktopSessionInfo } | null>(null);
	const [gateViews, setGateViews] = useState<Record<string, GateView>>({});
	const [operatorDrafts, setOperatorDrafts] = useState<Record<string, string>>({});
	const [operatorOperations, setOperatorOperations] = useState<Record<string, DesktopOperatorOperation>>({});
	const rememberOperator = useCallback(
		(sessionId: string, operation: DesktopOperatorOperation, expectedCurrentId?: string) => {
			setOperatorOperations(previous => {
				const old = previous[sessionId];
				if (expectedCurrentId && old && old.operationId !== expectedCurrentId) return previous;
				if (
					old?.operationId === operation.operationId &&
					old.status === "cancel_requested" &&
					operation.status === "running"
				)
					return previous;
				if (old && old.sessionGeneration > operation.sessionGeneration) return previous;
				if (
					old?.operationId === operation.operationId &&
					old.status !== "running" &&
					old.status !== "cancel_requested" &&
					(operation.status === "running" || operation.status === "cancel_requested")
				)
					return previous;
				return { ...previous, [sessionId]: operation };
			});
		},
		[],
	);
	const gateViewsRef = useRef(gateViews);
	gateViewsRef.current = gateViews;
	const applyActivityUpdate = useCallback((update: DesktopActivityUpdate) => {
		if (update.sessionId !== selectedRef.current) return;
		setActivity(previous =>
			previous?.sessionId === update.sessionId && previous.revision >= update.revision ? previous : update,
		);
	}, []);
	const [modelCatalog, setModelCatalog] = useState<{
		sessionId: string;
		generation: number | null;
		models: DesktopModel[];
		loading: boolean;
		error?: string;
	}>({ sessionId: "", generation: null, models: [], loading: false });
	const [modelCatalogRevision, setModelCatalogRevision] = useState(0);
	const refreshModelCatalog = useRef(false);
	const [connection, setConnection] = useState("호스트에 연결하는 중…");
	const [fatal, setFatal] = useState(false);
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [pending, setPending] = useState<Record<string, boolean>>({});
	const locks = useRef(new Set<string>());
	const [drafts, setDrafts] = useState<Record<string, string>>(() => {
		try {
			const stored: unknown = JSON.parse(localStorage.getItem("gjc.desktop.composer-drafts") || "{}");
			return stored && typeof stored === "object" && !Array.isArray(stored)
				? Object.fromEntries(
						Object.entries(stored).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
					)
				: {};
		} catch {
			return {};
		}
	});
	const [attachmentDrafts, setAttachmentDrafts] = useState<Record<string, DesktopAttachmentDraft[]>>({});
	const changeAttachments = useCallback(
		(sessionId: string, update: (current: DesktopAttachmentDraft[]) => DesktopAttachmentDraft[]) => {
			setAttachmentDrafts(previous => {
				const current = previous[sessionId] ?? [];
				const next = update(current);
				return next === current ? previous : { ...previous, [sessionId]: next };
			});
		},
		[],
	);
	const [questionDrafts, setQuestionDrafts] = useState<Record<string, string>>({});
	const [dialog, setDialogState] = useState<Dialog>(null);
	const dialogGeneration = useRef(0);
	const [dialogOwner, setDialogOwner] = useState("");
	const [sidebar, setSidebar] = useState(false);
	const [review, setReview] = useState(false);
	const [wide, setWide] = useState(() => window.matchMedia("(min-width: 1100px)").matches);
	const [diffs, setDiffs] = useState<DesktopDiff[]>([]);
	const [diffPath, setDiffPath] = useState("");
	const [diffLoading, setDiffLoading] = useState(false);
	const [settings, setSettings] = useState<DesktopSetting[] | null>(null);
	const [settingFilter, setSettingFilter] = useState("");
	const [sessionFilter, setSessionFilter] = useState("");
	const [provider, setProvider] = useState("");
	const [keyProviders, setKeyProviders] = useState<string[] | null>(null);
	const [key, setKey] = useState("");
	const [notice, setNotice] = useState("");
	const [editText, setEditText] = useState("");
	const [result, setResult] = useState("");
	const [toolNames, setToolNames] = useState<string[]>([]);
	const [activeTools, setActiveTools] = useState<string[]>([]);
	const [filter, setFilter] = useState("");
	const [historyLimit, setHistoryLimit] = useState(100);
	const [commandList, setCommandList] = useState<DesktopCommand[]>([]);
	const [commandInput, setCommandInput] = useState("");
	const [commandOutput, setCommandOutput] = useState("");
	const [history, setHistory] = useState<DesktopHistory | null>(null);
	const [forkEntryId, setForkEntryId] = useState("");
	const [btwOwner, setBtwOwner] = useState<{
		sessionId: string;
		generation: number;
		question: string;
		composerText?: string;
	} | null>(null);
	const [deliverAs, setDeliverAs] = useState<"steer" | "followUp">("steer");
	const commandInputRef = useRef<HTMLInputElement>(null);
	const conversation = useRef<HTMLDivElement>(null);
	const follow = useRef(true);
	const session = snapshot?.sessions.find(item => item.id === selected);
	// A failed turn is published on the session itself; the request that carried it
	// reports the same string. Render it once instead of twice.
	const scopeError = (scope: string) => {
		const message = errors[scope];
		return message && message !== session?.error ? message : "";
	};
	const project = snapshot?.projects.find(item => item.id === session?.projectId);
	const connected = snapshot !== null && !fatal;
	const modelGeneration = session?.controlGeneration ?? null;
	const modelOwner = session ? `${session.id}:${modelGeneration}` : "";
	const modelOwnerRef = useRef(modelOwner);
	modelOwnerRef.current = modelOwner;
	const setDialog = useCallback(
		(next: Dialog) => {
			dialogGeneration.current += 1;
			setDialogOwner(selected);
			setKey("");
			setNotice("");
			setDialogState(next);
			return dialogGeneration.current;
		},
		[selected],
	);
	const closeDialog = useCallback(() => {
		setDialog(null);
	}, [setDialog]);
	const filteredSettings = (settings ?? []).filter(setting =>
		`${setting.path} ${setting.description ?? ""}`.toLowerCase().includes(settingFilter.toLowerCase()),
	);
	const settingsScope = `settings:${dialogOwner}:${dialogGeneration.current}`;
	const toolsScope = `tools:${dialogOwner}:${dialogGeneration.current}`;
	const authScope = `auth:${dialogOwner}:${dialogGeneration.current}`;
	const operatorScope = `operator:${dialogOwner}`;
	useEffect(() => {
		try {
			localStorage.setItem("gjc.desktop.composer-drafts", JSON.stringify(drafts));
		} catch {
			setErrors(previous => ({
				...previous,
				global: "초안을 기기에 저장하지 못했습니다. 종료 전 필요한 내용을 복사하세요.",
			}));
		}
	}, [drafts]);
	useEffect(() => {
		if (dialog && dialogOwner !== selected) closeDialog();
	}, [selected, dialogOwner, dialog, closeDialog]);

	useEffect(() => {
		let alive = true;
		let unsubscribe: (() => void) | undefined;
		let failed = false;
		let bootstrapped = false;
		const buffered: DesktopFrame[] = [];
		const frame = (event: DesktopFrame) => {
			if (!alive || failed) return;
			if (!bootstrapped && event.type !== "fatal") {
				buffered.push(event);
				return;
			}
			if (event.type === "fatal") {
				failed = true;
				setFatal(true);
				setConnection(event.error);
				dialogGeneration.current += 1;
				setDialogState(null);
				setSidebar(false);
				setReview(false);
				setKey("");
			}
			if (event.type === "snapshot") setSnapshot(event.snapshot);
			if (event.type === "activity") applyActivityUpdate(event.update);
			if (event.type === "operator") rememberOperator(event.sessionId, event.event.operation);
			if (event.type === "gate") {
				const gateEvent = event.event;
				setGateViews(previous => {
					if (gateEvent.type === "presented") {
						const id = gateEvent.presentation.id;
						if (previous[id]) return previous;
						return {
							...previous,
							[id]: { sessionId: event.sessionId, presentation: gateEvent.presentation, presented: false },
						};
					}
					const view = previous[gateEvent.presentationId];
					if (!view || view.sessionId !== event.sessionId) return previous;
					return { ...previous, [gateEvent.presentationId]: { ...view, retiring: { nonce: gateEvent.nonce } } };
				});
			}
			if (event.type === "session")
				setSnapshot(previous =>
					previous
						? {
								...previous,
								sessions: previous.sessions.some(item => item.id === event.session.id)
									? previous.sessions.map(item => (item.id === event.session.id ? event.session : item))
									: [...previous.sessions, event.session],
							}
						: previous,
				);
		};
		void (async () => {
			try {
				unsubscribe = await subscribe(frame);
				if (!alive) {
					unsubscribe();
					return;
				}
				const initial = await request<DesktopSnapshot>("bootstrap");
				if (alive && !failed) {
					setSnapshot(initial);
					bootstrapped = true;
					for (const event of buffered) frame(event);
					setConnection("");
				}
			} catch (error) {
				if (alive) {
					failed = true;
					setFatal(true);
					setConnection(error instanceof Error ? error.message : "호스트 연결 실패");
				}
			}
		})();
		return () => {
			alive = false;
			unsubscribe?.();
		};
	}, [applyActivityUpdate, rememberOperator]);
	useEffect(() => {
		setActivity(null);
		if (!selected || !connected) return;
		let alive = true;
		void request<DesktopActivityUpdate>("activity.get", { sessionId: selected })
			.then(update => {
				if (alive) applyActivityUpdate(update);
			})
			.catch(error => {
				if (alive)
					setErrors(previous => ({
						...previous,
						[`activity:${selected}`]: error instanceof Error ? error.message : "활동 정보를 불러오지 못했습니다.",
					}));
			});
		return () => {
			alive = false;
		};
	}, [selected, connected, applyActivityUpdate]);
	useEffect(() => {
		if (!selected || !connected || modelGeneration === null) return;
		let alive = true;
		const owner = modelOwner;
		setModelCatalog({ sessionId: selected, generation: modelGeneration, models: [], loading: true });
		const refresh = refreshModelCatalog.current;
		refreshModelCatalog.current = false;
		void request<DesktopModel[]>("models.list", { sessionId: selected, ...(refresh ? { refresh: true } : {}) })
			.then(models => {
				if (alive && modelOwnerRef.current === owner)
					setModelCatalog({ sessionId: selected, generation: modelGeneration, models, loading: false });
			})
			.catch(error => {
				if (alive && modelOwnerRef.current === owner)
					setModelCatalog({
						sessionId: selected,
						generation: modelGeneration,
						models: [],
						loading: false,
						error: error instanceof Error ? error.message : "모델 목록을 불러오지 못했습니다.",
					});
			});
		return () => {
			alive = false;
		};
	}, [selected, connected, modelGeneration, modelOwner, snapshot?.models, modelCatalogRevision]);
	useEffect(() => {
		const media = window.matchMedia("(min-width: 1100px)");
		const update = () => setWide(media.matches);
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);
	useEffect(() => {
		const listener = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
				event.preventDefault();
				if (dialog) closeDialog();
				else openCommands();
			}
			if (event.key === "Escape") {
				setSidebar(false);
				setReview(false);
			}
		};
		window.addEventListener("keydown", listener);
		return () => window.removeEventListener("keydown", listener);
	}, [dialog, closeDialog, setDialog]);
	useEffect(() => {
		follow.current = true;
		setHistoryLimit(100);
	}, [selected]);
	useEffect(() => {
		// A notice describes one action; it must not leak into another conversation.
		setNotice("");
	}, [selected]);
	useEffect(() => {
		if (follow.current && conversation.current) conversation.current.scrollTop = conversation.current.scrollHeight;
	}, [session?.messages, session?.question]);
	useEffect(() => {
		if (snapshot && selected && !snapshot.sessions.some(item => item.id === selected)) setSelected("");
	}, [snapshot, selected]);

	const run = useCallback(async (scope: string, action: () => Promise<void>) => {
		if (locks.current.has(scope)) return;
		locks.current.add(scope);
		setPending(previous => ({ ...previous, [scope]: true }));
		setErrors(previous => ({ ...previous, [scope]: "" }));
		try {
			await action();
		} catch (error) {
			setErrors(previous => ({
				...previous,
				[scope]: scope.startsWith("auth:")
					? "API 키 요청을 완료하지 못했습니다. 저장 여부를 확인한 뒤 다시 시도하세요."
					: error instanceof Error
						? error.message
						: "요청에 실패했습니다.",
			}));
		} finally {
			locks.current.delete(scope);
			setPending(previous => ({ ...previous, [scope]: false }));
		}
	}, []);
	const call = (method: DesktopMethod, params: Record<string, unknown> = {}, scope = selected || "global") =>
		run(scope, async () => {
			await request(method, params);
		});
	const select = (item: DesktopSession) => {
		if (!connected) return;
		setSelected(item.id);
		setSidebar(false);
		void call("session.select", { sessionId: item.id }, `select:${item.id}`);
	};
	const openProject = () =>
		run("global", async () => {
			const path = await selectProject();
			if (path) await request("project.open", { path });
		});
	const openSettings = () => {
		const sessionId = selected;
		const generation = setDialog("settings");
		setSettings(null);
		setKeyProviders(null);
		setSettingFilter("");
		void run(`settings:${sessionId}:${generation}`, async () => {
			const [value, providers] = await Promise.all([
				request<DesktopSetting[]>("settings.get", sessionId ? { sessionId } : {}),
				request<string[]>("auth.keyProviders"),
			]);
			if (dialogGeneration.current === generation) {
				setSettings(value);
				setKeyProviders(providers);
			}
		});
	};
	const saveSetting = (path: string, value: unknown) => {
		const sessionId = dialogOwner;
		const generation = dialogGeneration.current;
		void run(settingsScope, async () => {
			await request("settings.set", { path, value, sessionId: sessionId || undefined });
			const values = await request<DesktopSetting[]>("settings.get", sessionId ? { sessionId } : {});
			if (dialogGeneration.current === generation) {
				setSettings(values);
				setNotice("설정을 저장했습니다.");
			}
		});
	};
	const saveTools = () => {
		const sessionId = dialogOwner;
		const generation = dialogGeneration.current;
		void run(toolsScope, async () => {
			await request("tools.set", { sessionId, names: activeTools });
			if (dialogGeneration.current === generation) setNotice("활성 도구를 저장했습니다.");
		});
	};
	const openBtw = (question = "", composerText?: string) => {
		if (!session || !connected || session.controlGeneration === null) return;
		setBtwOwner({ sessionId: session.id, generation: session.controlGeneration, question, composerText });
		setDialog("btw");
	};
	const send = () => {
		if (!session || !connected) return;
		const sessionId = session.id;
		const text = drafts[sessionId] || "";
		const ownedAttachments = attachmentDrafts[sessionId] ?? [];
		if (!text.trim() && ownedAttachments.length === 0) return;
		const sideChat = /^\s*\/btw(?:\s+([\s\S]*))?$/i.exec(text);
		if (sideChat) {
			if (ownedAttachments.length) {
				setErrors(previous => ({
					...previous,
					[sessionId]: "별도 대화는 텍스트만 지원합니다. 첨부 파일을 제거한 뒤 다시 보내세요.",
				}));
				return;
			}
			openBtw(sideChat[1]?.trim() ?? "", text);
			return;
		}
		const queued = session.status === "running" || session.status === "waiting";
		// A prompt request resolves only when the turn ends, so the composer clears on
		// admission rather than on reply: keeping the sent text invites a duplicate
		// submission. Clearing inside the action also means a send that `run` refuses
		// to admit (locked scope) leaves the draft untouched.
		// The original prompt request lasts for the whole turn. Queue admission
		// must not reuse that lock or steer/follow-up submissions never reach the host.
		void run(queued ? `enqueue:${sessionId}` : sessionId, async () => {
			const attachments = readyDesktopAttachments(ownedAttachments);
			const sentIds = new Set(ownedAttachments.map(draft => draft.id));
			setDrafts(previous => (previous[sessionId] === text ? { ...previous, [sessionId]: "" } : previous));
			changeAttachments(sessionId, current => current.filter(draft => !sentIds.has(draft.id)));
			try {
				const result = await request<{ queued?: boolean }>("prompt", {
					sessionId,
					text,
					...(attachments.length ? { attachments } : {}),
					...(queued ? { deliverAs } : {}),
				});
				if (result?.queued) setNotice("실행 중인 작업에 대기열로 추가했습니다.");
			} catch (error) {
				// The host refused the dispatch, so the payload is still undelivered.
				setDrafts(previous => ({ ...previous, [sessionId]: restoreDraft(previous[sessionId] ?? "", text) }));
				changeAttachments(sessionId, current => restoreAttachments(current, ownedAttachments));
				throw error;
			}
		});
	};
	const openCommands = () => {
		const generation = setDialog("commands");
		setFilter("");
		setCommandInput("");
		setCommandOutput("");
		void run("commands", async () => {
			const value = await request<DesktopCommand[]>("command.list");
			if (dialogGeneration.current === generation) setCommandList(value);
		});
	};
	const runCommand = (text: string) => {
		const sessionId = dialogOwner || selected;
		if (!sessionId || !text.trim()) return;
		const generation = dialogGeneration.current;
		setNotice("");
		const sideChat = /^\s*\/btw(?:\s+([\s\S]*))?$/i.exec(text);
		if (sideChat) {
			openBtw(sideChat[1]?.trim() ?? "");
			return;
		}
		// Plain text belongs to the conversation, not the command dispatcher: route it
		// through the same queue-aware prompt path as the composer so it is never
		// dropped when a run is active.
		if (!text.trimStart().startsWith("/")) {
			closeDialog();
			const queued = session?.status === "running" || session?.status === "waiting";
			void run(`command:${sessionId}`, async () => {
				const result = await request<{ queued?: boolean }>("prompt", {
					sessionId,
					text,
					...(queued ? { deliverAs } : {}),
				});
				if (result.queued) setNotice("실행 중인 작업에 대기열로 추가했습니다.");
			});
			return;
		}
		void run(`command:${sessionId}`, async () => {
			const result = await request<DesktopCommandResult>("command.run", { sessionId, text });
			if (dialogGeneration.current !== generation) return;
			setCommandOutput(
				[
					result.output,
					result.refused
						? "실행하지 않았습니다."
						: result.prompt
							? `모델로 전달한 입력: ${result.prompt}`
							: result.consumed
								? result.outputTruncated
									? "명령을 실행했습니다. 출력이 길어 일부만 표시했습니다."
									: "명령을 실행했습니다."
								: "내장 명령이 아니므로 모델에 메시지로 전달했습니다.",
				]
					.filter(Boolean)
					.join("\n\n"),
			);
		});
	};
	const openHistoryDialog = (next: "history" | "fork") => {
		const sessionId = selected;
		const generation = setDialog(next);
		setHistory(null);
		setForkEntryId("");
		void run(`history:${sessionId}`, async () => {
			const value = await request<DesktopHistory>("history.get", { sessionId, offset: 0, limit: 500 });
			if (dialogGeneration.current === generation) setHistory(value);
		});
	};
	const openHistory = () => openHistoryDialog("history");
	const openFork = () => openHistoryDialog("fork");
	const forkSession = (entryId?: string) => {
		const sessionId = dialogOwner;
		const generation = dialogGeneration.current;
		void run(sessionId, async () => {
			const value = await request<DesktopForkResult>("session.fork", {
				sessionId,
				...(entryId === undefined ? {} : { entryId }),
			});
			if (dialogGeneration.current !== generation || selectedRef.current !== sessionId) return;
			if (value.cancelled) {
				setNotice("분기가 취소되었습니다. 원래 대화와 초안은 유지됩니다.");
				return;
			}
			await request<DesktopSession>("session.select", { sessionId: value.session.id });
			if (dialogGeneration.current !== generation || selectedRef.current !== sessionId) return;
			setDrafts(previous => ({ ...previous, [value.session.id]: value.selectedText }));
			closeDialog();
			setSelected(value.session.id);
		});
	};
	const loadMoreHistory = () => {
		const sessionId = dialogOwner;
		if (!history) return;
		const generation = dialogGeneration.current;
		const offset = history.offset + history.messages.length;
		void run(`history:${sessionId}`, async () => {
			const value = await request<DesktopHistory>("history.get", {
				sessionId,
				offset,
				limit: 500,
			});
			if (dialogGeneration.current !== generation) return;
			setHistory(previous =>
				previous
					? { ...value, offset: previous.offset, messages: [...previous.messages, ...value.messages] }
					: value,
			);
		});
	};
	useEffect(() => {
		setDiffs([]);
		setDiffPath("");
		setErrors(previous => ({ ...previous, diff: "" }));
		if (!review || !selected || !connected) return;
		let alive = true;
		setDiffLoading(true);
		void request<DesktopDiff[]>("diff.get", { sessionId: selected })
			.then(value => {
				if (alive) {
					setDiffs(value);
					setDiffPath(value[0]?.path || "");
				}
			})
			.catch(error => {
				if (alive)
					setErrors(previous => ({
						...previous,
						diff: error instanceof Error ? error.message : "변경 내용을 불러오지 못했습니다.",
					}));
			})
			.finally(() => {
				if (alive) setDiffLoading(false);
			});
		return () => {
			alive = false;
		};
	}, [review, selected, connected, session?.status]);
	const openTools = () => {
		const sessionId = selected;
		const generation = setDialog("tools");
		setToolNames([]);
		setActiveTools([]);
		void run(`tools:${sessionId}:${generation}`, async () => {
			const value = await request<unknown>("tools.list", { sessionId });
			if (dialogGeneration.current !== generation) return;
			if (
				!value ||
				typeof value !== "object" ||
				!("available" in value) ||
				!("active" in value) ||
				!Array.isArray(value.available) ||
				!Array.isArray(value.active) ||
				!value.available.every(item => typeof item === "string") ||
				!value.active.every(item => typeof item === "string")
			)
				throw new Error("도구 목록 응답 형식을 확인할 수 없습니다.");
			setToolNames(value.available);
			setActiveTools(value.active);
		});
	};
	const activityScope = `activity:${dialogOwner || selected}`;
	const activityDetailScope = `activity-detail:${dialogOwner}:${dialogGeneration.current}`;
	const preferencesScope = `preferences:${dialogOwner}:${dialogGeneration.current}`;
	const mcpReadScope = `mcp-read:${dialogOwner}:${dialogGeneration.current}`;
	const mcpMutationScope = `mcp-mutation:${dialogOwner}:${dialogGeneration.current}`;
	const sessionInfoScope = `session-info:${dialogOwner}:${dialogGeneration.current}`;
	const refreshActivity = (sessionId = selected) => {
		void run(`activity:${sessionId}`, async () => {
			applyActivityUpdate(await request<DesktopActivityUpdate>("activity.get", { sessionId }));
		});
	};
	const operateActivity = (ref: DesktopActivityRef, operation: DesktopActivityOperation) => {
		const sessionId = dialogOwner || selected;
		void run(`activity:${sessionId}`, async () => {
			applyActivityUpdate(await request<DesktopActivityUpdate>("activity.operate", { sessionId, ref, operation }));
		});
	};
	const acknowledgeActivity = (scope: DesktopActivityScope) => {
		const sessionId = dialogOwner || selected;
		void run(`activity:${sessionId}`, async () => {
			applyActivityUpdate(await request<DesktopActivityUpdate>("activity.acknowledge", { sessionId, scope }));
		});
	};
	const inspectActivity = (ref: DesktopActivityRef) => {
		const sessionId = dialogOwner || selected;
		const generation = setDialog("activity-detail");
		setActivityDetail(null);
		void run(`activity-detail:${sessionId}:${generation}`, async () => {
			const detail = await request<DesktopActivityDetail>("activity.detail", { sessionId, ref });
			if (dialogGeneration.current === generation) setActivityDetail(detail);
		});
	};
	const loadPreferences = (sessionId: string, generation: number) => {
		setPreferences(null);
		void run(`preferences:${sessionId}:${generation}`, async () => {
			const value = await request<DesktopPreferences>("preferences.get", { sessionId });
			if (dialogGeneration.current === generation) setPreferences({ sessionId, value });
		});
	};
	const openPreferences = () => {
		if (!selected) return;
		const generation = setDialog("preferences");
		loadPreferences(selected, generation);
	};
	const applyPreferences = (action: DesktopPreferenceAction) => {
		const sessionId = dialogOwner;
		const generation = dialogGeneration.current;
		void run(`preferences:${sessionId}:${generation}`, async () => {
			const outcome = await request<DesktopPreferenceResult>("preferences.apply", { sessionId, action });
			if (dialogGeneration.current === generation) setPreferences({ sessionId, value: outcome.preferences });
		});
	};
	const loadMcp = (sessionId: string, generation: number) => {
		void run(`mcp-read:${sessionId}:${generation}`, async () => {
			const value = await request<DesktopMcpSnapshot>("mcp.get", { sessionId });
			if (dialogGeneration.current === generation) setMcp({ sessionId, value });
		});
	};
	const openMcp = () => {
		if (!selected) return;
		const generation = setDialog("mcp");
		setMcp(null);
		loadMcp(selected, generation);
	};
	const operateMcp = (ref: DesktopMcpRef, action: DesktopMcpAction) => {
		const sessionId = dialogOwner;
		const generation = dialogGeneration.current;
		void run(`mcp-mutation:${sessionId}:${generation}`, async () => {
			const outcome = await request<DesktopMcpOperationResult>("mcp.operate", { sessionId, ref, action });
			if (dialogGeneration.current === generation) {
				setMcp({ sessionId, value: outcome.snapshot });
				setNotice("관리자 연결 변경 응답을 받았습니다. 원격 세션 종료나 자원 정산을 뜻하지 않습니다.");
			}
		});
	};
	const loadSessionInfo = (sessionId: string, generation: number) => {
		void run(`session-info:${sessionId}:${generation}`, async () => {
			const value = await request<DesktopSessionInfo>("session.info", { sessionId });
			if (dialogGeneration.current === generation) setSessionInfo({ sessionId, value });
		});
	};
	const openSessionInfo = () => {
		if (!selected) return;
		const generation = setDialog("session-info");
		setSessionInfo(null);
		loadSessionInfo(selected, generation);
	};
	const withdrawGate = useCallback(
		(presentationId: string) => {
			void run(`gate-withdraw:${presentationId}`, async () => {
				const view = gateViewsRef.current[presentationId];
				if (!view) throw new Error("승인 화면의 현재 소유권을 확인할 수 없습니다.");
				await request("gate.withdraw", { sessionId: view.sessionId, presentationId });
			});
		},
		[run],
	);
	const openGate = (ref: DesktopActivityRef) => {
		const sessionId = dialogOwner || selected;
		closeDialog();
		void run("gate-open", async () => {
			for (const view of Object.values(gateViewsRef.current)) {
				await request("gate.withdraw", { sessionId: view.sessionId, presentationId: view.presentation.id });
			}
			// Only ordered host events publish UI. The response must not resurrect a retired surface.
			await request("gate.present", { sessionId, ref });
		});
	};
	const acknowledgeGatePresented = (presentationId: string) => {
		void run(`gate-presented:${presentationId}`, async () => {
			const view = gateViewsRef.current[presentationId];
			if (!view) throw new Error("표시할 승인 화면의 소유권을 확인할 수 없습니다.");
			await request("gate.presented", { sessionId: view.sessionId, presentationId });
			setGateViews(previous =>
				previous[presentationId]
					? { ...previous, [presentationId]: { ...previous[presentationId], presented: true } }
					: previous,
			);
		});
	};
	const acknowledgeGateRetired = (presentationId: string, nonce: string) => {
		// Answer/withdraw requests wait for this acknowledgement; it owns a distinct UI lock.
		void run(`gate-retired:${presentationId}`, async () => {
			const view = gateViewsRef.current[presentationId];
			if (!view || view.retiring?.nonce !== nonce)
				throw new Error("철회할 승인 화면과 확인 번호가 일치하지 않습니다.");
			await request("gate.retired", { sessionId: view.sessionId, presentationId, nonce });
			setGateViews(previous => {
				if (previous[presentationId]?.retiring?.nonce !== nonce) return previous;
				const next = { ...previous };
				delete next[presentationId];
				return next;
			});
		});
	};
	const answerGate = (presentationId: string, answer: DesktopActivityGateAnswer) => {
		void run(`gate:${presentationId}`, async () => {
			const view = gateViewsRef.current[presentationId];
			if (!view) throw new Error("응답할 승인 화면의 현재 소유권을 확인할 수 없습니다.");
			await request("gate.answer", { sessionId: view.sessionId, presentationId, answer });
		});
	};
	useEffect(() => {
		if (!connected) return;
		for (const view of Object.values(gateViews)) {
			if (view.sessionId !== selected && !view.retiring) withdrawGate(view.presentation.id);
		}
	}, [selected, connected, gateViews, withdrawGate]);
	const executeOperator = (text: string) => {
		const sessionId = dialogOwner;
		void run(`operator:${sessionId}`, async () => {
			const operation = await request<DesktopOperatorOperation>("operator.execute", { sessionId, text });
			rememberOperator(sessionId, operation);
			setOperatorDrafts(previous => (previous[sessionId] === text ? { ...previous, [sessionId]: "" } : previous));
		});
	};
	const refreshOperator = (operationId: string) => {
		const sessionId = dialogOwner;
		void run(`operator-read:${sessionId}`, async () => {
			const operation = await request<DesktopOperatorOperation>("operator.get", { sessionId, operationId });
			rememberOperator(sessionId, operation, operationId);
		});
	};
	const abortOperator = (operationId: string) => {
		const sessionId = dialogOwner;
		void run(`operator-abort:${sessionId}`, async () => {
			rememberOperator(
				sessionId,
				await request<DesktopOperatorOperation>("operator.abort", { sessionId, operationId }),
			);
		});
	};
	const foldForegroundTool = () => {
		const sessionId = dialogOwner;
		void run(`operator-fold:${sessionId}`, async () => {
			const result = await request<DesktopOperatorFoldResult>("operator.fold", { sessionId });
			setNotice(
				result.status === "unsupported"
					? "현재 포그라운드 도구는 백그라운드 전환을 지원하지 않습니다."
					: result.status === "already_backgrounded"
						? "현재 도구는 이미 백그라운드로 전환되었습니다."
						: "현재 포그라운드 도구를 백그라운드로 옮겼습니다. 실행 완료를 뜻하지 않습니다.",
			);
		});
	};
	const modelControls = (owner: DesktopSession) => {
		const ownerKey = `${owner.id}:${owner.controlGeneration}`;
		const modelScope = `model:${ownerKey}`;
		const thinkingScope = `thinking:${ownerKey}`;
		const busy = owner.status === "running" || owner.status === "waiting";
		const changing = !!(pending[modelScope] || pending[thinkingScope]);
		const catalog =
			modelCatalog.sessionId === owner.id && modelCatalog.generation === owner.controlGeneration
				? modelCatalog
				: null;
		const loadingModels = !catalog || catalog.loading;
		const currentModelAvailable = catalog?.models.some(model => model.id === owner.model) === true;
		return (
			<div className="model-controls" key={ownerKey} aria-busy={changing}>
				<ModelPicker
					key={ownerKey}
					models={catalog?.models ?? []}
					onConfigureProviders={openSettings}
					selectedId={owner.model}
					disabled={!connected || busy || changing || loadingModels || !!catalog?.error}
					pending={pending[modelScope]}
					onSelect={modelId => {
						if (modelOwnerRef.current === ownerKey)
							void call("model.set", { sessionId: owner.id, modelId }, modelScope);
					}}
				/>
				<ReasoningSelect
					thinking={owner.thinking}
					disabled={!connected || busy || changing || !currentModelAvailable}
					pending={pending[thinkingScope]}
					onChange={level => {
						if (modelOwnerRef.current === ownerKey)
							void call("thinking.set", { sessionId: owner.id, level }, thinkingScope);
					}}
				/>
				<small className="model-control-status" role="status">
					{loadingModels
						? "프로젝트 모델 목록을 불러오고 있습니다…"
						: changing
							? "선택한 설정을 적용하고 있습니다…"
							: busy
								? "작업을 마친 뒤 모델과 추론 수준을 변경할 수 있습니다."
								: !currentModelAvailable
									? "제공자를 등록·연결한 뒤 사용 가능한 모델을 선택하세요."
									: !owner.thinking?.available
										? (owner.thinking?.reason ?? "세션을 열면 추론 지원 여부를 확인할 수 있습니다.")
										: owner.thinking.scope === "session"
											? "대화 전용 추론 설정 · 다음 요청에 적용"
											: "공통 추론 설정을 상속 중 · 다음 요청에 적용"}
				</small>
				{!loadingModels && !catalog?.error && catalog?.models.length === 0 && (
					<Button disabled={!connected} onClick={openSettings}>
						제공자 추가·연결
					</Button>
				)}
				{catalog?.error && (
					<div className="model-control-status">
						<ErrorBanner>{catalog.error}</ErrorBanner>
					</div>
				)}
				<Button
					disabled={!connected || busy || changing || loadingModels}
					onClick={() => {
						refreshModelCatalog.current = true;
						setModelCatalogRevision(value => value + 1);
					}}
				>
					목록 다시 불러오기
				</Button>
				{[modelScope, thinkingScope].map(
					scope =>
						errors[scope] && (
							<div className="model-control-status" key={scope}>
								<ErrorBanner>{errors[scope]}</ErrorBanner>
							</div>
						),
				)}
			</div>
		);
	};
	const commands: { label: string; action: () => void; needsSession?: boolean; allowDuringRun?: boolean }[] = [
		{ label: "별도 대화 (/btw)", needsSession: true, allowDuringRun: true, action: () => openBtw() },
		{
			label: "프로젝트 열기",
			action: () => {
				closeDialog();
				void openProject();
			},
		},
		{ label: "설정 및 기능 지원 현황", action: openSettings },
		{
			label: "직접 실행 (셸 · Python)",
			needsSession: true,
			action: () => {
				setDialog("operator");
			},
		},
		{
			label: "대화 분기 (fork)",
			needsSession: true,
			action: openFork,
		},
		{
			label: "대화 압축 (compact)",
			needsSession: true,
			action: () => {
				closeDialog();
				void call("session.compact", { sessionId: selected });
			},
		},
		{
			label: "응답 재시도 (retry)",
			needsSession: true,
			action: () => {
				closeDialog();
				void call("session.retry", { sessionId: selected });
			},
		},
		{
			label: "대화 내보내기 (export)",
			needsSession: true,
			action: () => {
				void run(selected, async () => {
					const value = await request<{ path: string }>("session.export", { sessionId: selected });
					setResult(`대화를 HTML 파일로 내보냈습니다.\n\n${value.path}`);
					setDialog("result");
				});
			},
		},
		{ label: "활성 도구 관리", needsSession: true, action: openTools },
		{
			label: "목표 관리 (goal)",
			needsSession: true,
			action: () => {
				setEditText("");
				setResult("");
				setDialog("goal");
			},
		},
	];
	const sidebarContent = (
		<>
			<header className="sidebar-heading">
				<strong>
					<Command size={18} aria-hidden="true" /> Gajae Code
				</strong>
			</header>
			<Button disabled={!connected || pending.global} onClick={() => void openProject()}>
				<FolderOpen size={16} aria-hidden="true" /> 프로젝트 열기
			</Button>
			<label className="sr-only" htmlFor="session-search">
				대화 검색
			</label>
			<input
				id="session-search"
				className="session-search"
				value={sessionFilter}
				placeholder="대화 검색"
				onChange={event => setSessionFilter(event.target.value)}
			/>
			<nav aria-label="프로젝트와 대화">
				{snapshot?.projects.map(item => (
					<section className="project-group" key={item.id}>
						<div className="project-heading">
							<h2 title={item.path}>{item.name}</h2>
							<Button
								aria-label={`${item.name} 새 대화`}
								disabled={!connected || pending[`project:${item.id}`]}
								onClick={() =>
									void run(`project:${item.id}`, async () => {
										const created = await request<DesktopSession>("session.create", { projectId: item.id });
										if (created && typeof created.id === "string") {
											setSelected(created.id);
											await request("session.select", { sessionId: created.id });
										}
									})
								}
							>
								<Plus size={15} aria-hidden="true" />
							</Button>
						</div>
						<small className="path">{item.path}</small>
						{errors[`project:${item.id}`] && <ErrorBanner>{errors[`project:${item.id}`]}</ErrorBanner>}
						{snapshot.sessions
							.filter(
								chat =>
									chat.projectId === item.id &&
									chat.title.toLowerCase().includes(sessionFilter.trim().toLowerCase()),
							)
							.sort((a, b) => Number(b.starred) - Number(a.starred))
							.map(chat => (
								<SessionRow
									key={chat.id}
									session={chat}
									selected={chat.id === selected}
									onSelect={() => select(chat)}
									onStar={() => {
										if (connected)
											void call("session.star", { sessionId: chat.id, starred: !chat.starred }, "global");
									}}
								/>
							))}
						{!snapshot.sessions.some(chat => chat.projectId === item.id) && (
							<p className="muted">새 대화를 시작하세요.</p>
						)}
					</section>
				))}
			</nav>
			<footer>
				<Button onClick={openSettings} disabled={!connected}>
					<Settings2 size={16} aria-hidden="true" /> 설정
				</Button>
				<Button onClick={openCommands} disabled={!connected}>
					<Command size={15} aria-hidden="true" /> 명령 ⌘K
				</Button>
			</footer>
		</>
	);
	const reviewContent = (
		<>
			{wide && (
				<header>
					<h2>변경 검토</h2>
					<Button onClick={() => setReview(false)}>닫기</Button>
				</header>
			)}
			{errors.diff && <ErrorBanner>{errors.diff}</ErrorBanner>}
			{diffLoading ? (
				<p role="status">변경 내용 불러오는 중…</p>
			) : diffs.length ? (
				<>
					<label htmlFor="diff-file">파일</label>
					<select id="diff-file" value={diffPath} onChange={event => setDiffPath(event.target.value)}>
						{diffs.map(file => (
							<option key={file.path} value={file.path}>
								{file.status} · {file.path}
							</option>
						))}
					</select>
					<pre className="diff-output">{diffs.find(file => file.path === diffPath)?.patch}</pre>
				</>
			) : (
				<p className="muted">표시할 변경 내용이 없습니다.</p>
			)}
		</>
	);
	return (
		<div className="app-shell">
			<aside className="sidebar desktop-sidebar">{sidebarContent}</aside>
			{sidebar && (
				<Modal title="프로젝트와 대화" className="sidebar-drawer" onClose={() => setSidebar(false)}>
					{sidebarContent}
				</Modal>
			)}
			<main className="main-pane">
				<header className="toolbar">
					<Button className="mobile-only" onClick={() => setSidebar(true)}>
						프로젝트
					</Button>
					<div className="toolbar-title">
						<small>{project?.name || "Gajae Code"}</small>
						<h1>{session?.title || "프로젝트에서 시작하세요"}</h1>
					</div>
					{session && (
						<>
							<Button aria-pressed={review} disabled={!connected} onClick={() => setReview(!review)}>
								<FileDiff size={15} aria-hidden="true" /> 변경 검토
							</Button>

							<Button
								disabled={!connected}
								onClick={() => {
									setDialog("activity");
									refreshActivity();
								}}
							>
								<Activity size={15} aria-hidden="true" /> 활동
								{activity?.sessionId === selected &&
									activity.activity.sessionState?.gates.available &&
									activity.activity.sessionState.gates.pending.length > 0 && (
										<span className="activity-badge">
											응답 {activity.activity.sessionState.gates.pending.length}
										</span>
									)}
							</Button>
							<Button
								disabled={!connected}
								aria-label="대화 작업 메뉴"
								title="대화 작업 메뉴"
								onClick={() => setDialog("session-actions")}
							>
								<MoreHorizontal size={16} aria-hidden="true" />
							</Button>
						</>
					)}
					<Button disabled={!connected} onClick={openCommands}>
						명령
					</Button>
				</header>
				{connection &&
					(fatal ? (
						<ErrorBanner>
							연결 끊김: {connection} · 초안은 유지됩니다. 창 닫기는 앱을 숨길 뿐입니다. 앱 메뉴의 Quit(종료)으로
							완전히 종료한 뒤 다시 실행하세요.
						</ErrorBanner>
					) : (
						<p role="status">{connection}</p>
					))}
				{errors.global && <ErrorBanner>{errors.global}</ErrorBanner>}
				{Object.entries(errors)
					.filter(([scope, error]) => scope.startsWith("gate") && error)
					.map(([scope, error]) => (
						<ErrorBanner key={scope}>{error}</ErrorBanner>
					))}
				{session ? (
					<>
						<div className="session-status" role="status">
							{session.status === "running"
								? "작업 중 · 다른 대화로 이동해도 계속됩니다."
								: session.status === "waiting"
									? "응답이 필요합니다."
									: session.status === "error"
										? "작업 오류"
										: "대기"}
							{pending[selected] && " · 요청 처리 중"}
						</div>
						<div
							className="conversation"
							ref={conversation}
							onScroll={event => {
								const node = event.currentTarget;
								follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100;
							}}
						>
							{session.historyTruncated && (
								<p className="muted">
									최근 기록만 표시합니다. 대화 작업 메뉴의 ‘전체 대화 기록’에서 모두 확인할 수 있습니다.
								</p>
							)}
							{session.messages.length > historyLimit && (
								<Button onClick={() => setHistoryLimit(value => value + 100)}>이전 메시지 100개 더 보기</Button>
							)}
							{session.messages.length === 0 && (
								<div className="empty">이 프로젝트에서 할 일을 메시지로 보내세요.</div>
							)}
							{session.messages.slice(-historyLimit).map(message => (
								<Message key={message.id} message={message} />
							))}
							{session.question && (
								<QuestionCard
									key={JSON.stringify([selected, session.question.id])}
									question={session.question}
									value={
										questionDrafts[JSON.stringify([selected, session.question.id])] ??
										session.question.initialValue ??
										""
									}
									onChange={value => {
										const draftKey = JSON.stringify([selected, session.question?.id]);
										setQuestionDrafts(previous => ({ ...previous, [draftKey]: value }));
									}}
									pending={!connected || pending[`question:${selected}`]}
									onAnswer={value => {
										const sessionId = selected;
										const questionId = session.question?.id;
										const draftKey = JSON.stringify([sessionId, questionId]);
										void run(`question:${sessionId}`, async () => {
											await request("question.answer", { sessionId, questionId, value });
											setQuestionDrafts(previous => {
												const next = { ...previous };
												delete next[draftKey];
												return next;
											});
										});
									}}
								/>
							)}
							{session.error && <ErrorBanner>{session.error}</ErrorBanner>}
							{[
								selected,
								`select:${selected}`,
								`question:${selected}`,
								`abort:${selected}`,
								`queue:${selected}`,
								`enqueue:${selected}`,
								// Palette dispatch closes its dialog first, so its failures and queue
								// notices need this surface; while a dialog is open it renders there.
								...(dialog ? [] : [`command:${selected}`]),
							].map(scope =>
								scopeError(scope) ? <ErrorBanner key={scope}>{scopeError(scope)}</ErrorBanner> : null,
							)}
							{!dialog && notice && <p className="notice">{notice}</p>}
						</div>
						{session.queued && session.queued.length > 0 && (
							<div className="queued-inputs">
								<strong>대기열 {session.queued.length}건</strong>
								{session.queued.map(item => (
									<div className="queued-input" key={item.id}>
										<span>
											{item.deliverAs === "steer" ? "개입" : "후속"} · {item.text.slice(0, 120)}
										</span>
										<small>
											{item.execution === "joined-current-run" || item.execution === "promoted-to-run"
												? "실행에 반영됨"
												: item.cancelable
													? "대기 중"
													: "처리 중"}
										</small>
										{item.cancelable && (
											<Button
												disabled={!connected}
												onClick={() =>
													void run(`queue:${selected}`, async () => {
														const outcome = await request<{ removed: boolean }>("queue.cancel", {
															sessionId: selected,
															queueId: item.id,
														});
														if (!outcome.removed)
															setNotice("이미 실행에 반영된 입력이라 취소하지 못했습니다.");
													})
												}
											>
												취소
											</Button>
										)}
									</div>
								))}
							</div>
						)}
						<div className="composer-area">
							<Composer
								controls={
									<>
										{modelControls(session)}
										<AttachmentPicker
											sessionId={session.id}
											attachments={attachmentDrafts[session.id] ?? []}
											supportsImageInput={session.imageInput?.supported === true}
											imagesBlocked={session.imageInput?.blocked}
											disabled={!connected}
											onChange={changeAttachments}
										/>
									</>
								}
								hasAttachments={(attachmentDrafts[session.id]?.length ?? 0) > 0}
								allowQueue={!session.operatorRunning}
								sendDisabled={
									session.operatorRunning ||
									attachmentDrafts[session.id]?.some(
										draft =>
											draft.status !== "ready" ||
											(draft.attachment.kind === "image" &&
												(!session.imageInput?.supported || session.imageInput.blocked)),
									)
								}
								onPaste={event => {
									const files = desktopClipboardImageFiles(event.clipboardData);
									if (!files.length || !connected) return;
									event.preventDefault();
									addDesktopAttachmentFiles(
										{
											sessionId: session.id,
											attachments: attachmentDrafts[session.id] ?? [],
											supportsImageInput: session.imageInput?.supported === true,
											imagesBlocked: session.imageInput?.blocked,
											disabled: !connected,
											onChange: changeAttachments,
										},
										files,
									);
								}}
								value={drafts[selected] || ""}
								onChange={value => setDrafts(previous => ({ ...previous, [selected]: value }))}
								onSend={send}
								onStop={() => void call("abort", { sessionId: selected }, `abort:${selected}`)}
								busy={session.status === "running" || session.status === "waiting"}
								deliverAs={deliverAs}
								onDeliverAs={setDeliverAs}
								onSlash={openCommands}
								disabled={!connected}
							/>
						</div>
					</>
				) : (
					<div className="empty">
						<h2>
							{snapshot?.projects.length ? "대화를 선택하거나 새로 시작하세요" : "프로젝트를 열어 시작하세요"}
						</h2>
						<p>프로젝트별 대화와 백그라운드 작업을 한곳에서 관리합니다.</p>
						<Button disabled={!connected || pending.global} onClick={() => void openProject()}>
							프로젝트 폴더 선택
						</Button>
					</div>
				)}
			</main>
			{review && wide && <aside className="review-pane">{reviewContent}</aside>}
			{review && !wide && (
				<div className="review-drawer">
					<Modal title="변경 검토" onClose={() => setReview(false)}>
						{reviewContent}
					</Modal>
				</div>
			)}
			{dialog === "btw" && dialogOwner === selected && btwOwner?.sessionId === selected && (
				<BtwDialog
					key={dialogGeneration.current}
					sessionId={btwOwner.sessionId}
					sessionGeneration={btwOwner.generation}
					connected={connected}
					initialQuestion={btwOwner.question}
					onClose={closeDialog}
					onAdmitted={() => {
						const { sessionId, composerText } = btwOwner;
						if (composerText !== undefined)
							setDrafts(previous =>
								previous[sessionId] === composerText ? { ...previous, [sessionId]: "" } : previous,
							);
					}}
				/>
			)}
			{dialog && dialog !== "btw" && dialogOwner === selected && (
				<Modal
					title={
						{
							settings: "설정",
							commands: "명령",
							history: "전체 기록",
							fork: "대화 분기 (fork)",
							rename: "대화 이름 변경",
							delete: "대화 삭제",
							tools: "활성 도구",
							goal: "목표 관리",
							result: "요청 결과",
							activity: "백그라운드 활동과 응답 요청",
							"activity-detail": "활동 세부 정보",
							preferences: "모델 프로필과 실행 설정",
							operator: "직접 실행 · 셸과 Python",
							mcp: "MCP 연결 관리",
							"session-info": "세션 정보와 사용량",
							"session-actions": "대화 작업",
						}[dialog]
					}
					onClose={closeDialog}
				>
					{[settingsScope, authScope, toolsScope, "goal", selected].map(scope =>
						scopeError(scope) ? <ErrorBanner key={scope}>{scopeError(scope)}</ErrorBanner> : null,
					)}
					{notice && <p role="status">{notice}</p>}
					{dialog === "session-actions" && (
						<nav className="command-list" aria-label="현재 대화 작업">
							<Button onClick={openPreferences}>
								<SlidersHorizontal aria-hidden="true" />
								모델 프로필과 실행 설정
							</Button>
							<Button onClick={() => setDialog("operator")}>
								<Command aria-hidden="true" />
								직접 실행 · 셸과 Python
							</Button>
							<Button disabled={!connected || session?.controlGeneration === null} onClick={() => openBtw()}>
								<Command aria-hidden="true" />
								별도 대화 · /btw
							</Button>
							<Button onClick={openMcp}>
								<Network aria-hidden="true" />
								MCP 연결 관리
							</Button>
							<Button onClick={openSessionInfo}>
								<Info aria-hidden="true" />
								세션 정보와 사용량
							</Button>
							<Button onClick={openFork}>대화 분기 (fork)</Button>
							<Button onClick={openHistory}>
								<History aria-hidden="true" />
								전체 대화 기록
							</Button>
							<Button
								onClick={() => {
									setEditText(session?.title ?? "");
									setDialog("rename");
								}}
							>
								<Pencil aria-hidden="true" />
								이름 변경
							</Button>
							<Button className="danger" onClick={() => setDialog("delete")}>
								<Trash2 aria-hidden="true" />
								대화 삭제
							</Button>
						</nav>
					)}
					{dialog === "activity" && (
						<ActivityPanel
							snapshot={activity?.sessionId === dialogOwner ? activity.activity : null}
							pending={pending[activityScope]}
							error={errors[activityScope]}
							onRefresh={() => refreshActivity(dialogOwner)}
							onOperate={operateActivity}
							onAcknowledge={acknowledgeActivity}
							onInspect={inspectActivity}
							onOpenGate={openGate}
						/>
					)}
					{dialog === "operator" && (
						<OperatorPanel
							value={operatorDrafts[dialogOwner] ?? ""}
							operation={
								operatorOperations[dialogOwner]?.sessionGeneration ===
								snapshot?.sessions.find(item => item.id === dialogOwner)?.controlGeneration
									? operatorOperations[dialogOwner]!
									: null
							}
							pending={pending[operatorScope]}
							busy={snapshot?.sessions.some(
								item => item.id === dialogOwner && (item.status === "running" || item.status === "waiting"),
							)}
							disabled={!connected}
							error={
								[
									operatorScope,
									`operator-read:${dialogOwner}`,
									`operator-abort:${dialogOwner}`,
									`operator-fold:${dialogOwner}`,
								]
									.map(scope => errors[scope])
									.filter(Boolean)
									.join(" · ") || undefined
							}
							onChange={value => setOperatorDrafts(previous => ({ ...previous, [dialogOwner]: value }))}
							onExecute={executeOperator}
							onAbort={abortOperator}
							onRefresh={refreshOperator}
							onFold={foldForegroundTool}
						/>
					)}
					{dialog === "mcp" && (
						<McpPanel
							snapshot={
								mcp?.sessionId === dialogOwner && mcp.value.sessionGeneration === session?.controlGeneration
									? mcp.value
									: null
							}
							pending={pending[mcpReadScope]}
							busy={
								!!pending[mcpMutationScope] || session?.status === "running" || session?.status === "waiting"
							}
							error={[errors[mcpReadScope], errors[mcpMutationScope]].filter(Boolean).join(" · ") || undefined}
							onRefresh={() => loadMcp(dialogOwner, dialogGeneration.current)}
							onOperate={operateMcp}
						/>
					)}
					{dialog === "session-info" && (
						<SessionInfoPanel
							info={sessionInfo?.sessionId === dialogOwner ? sessionInfo.value : null}
							pending={pending[sessionInfoScope]}
							error={errors[sessionInfoScope]}
							onRefresh={() => loadSessionInfo(dialogOwner, dialogGeneration.current)}
						/>
					)}
					{dialog === "preferences" && (
						<PreferencesPanel
							preferences={preferences?.sessionId === dialogOwner ? preferences.value : null}
							pending={pending[preferencesScope]}
							busy={snapshot?.sessions.some(
								item => item.id === dialogOwner && (item.status === "running" || item.status === "waiting"),
							)}
							error={errors[preferencesScope]}
							onRefresh={() => loadPreferences(dialogOwner, dialogGeneration.current)}
							onApply={applyPreferences}
						/>
					)}
					{dialog === "activity-detail" &&
						(errors[activityDetailScope] ? (
							<ErrorBanner>{errors[activityDetailScope]}</ErrorBanner>
						) : activityDetail ? (
							<>
								<h3>{activityDetail.entry.id}</h3>
								<p>{activityDetail.entry.type}</p>
								{activityDetail.output ? (
									<pre className="bounded-output">
										{activityDetail.output.text}
										{activityDetail.output.truncated ? "\n[출력 생략]" : ""}
									</pre>
								) : (
									<p className="muted">이 활동에는 읽을 수 있는 출력 미리보기가 없습니다.</p>
								)}
							</>
						) : (
							<p role="status">활동 정보를 불러오는 중…</p>
						))}
					{dialog === "settings" && (
						<>
							<section>
								<h3>현재 대화 모델과 추론</h3>
								{session ? modelControls(session) : <p className="muted">대화를 먼저 선택하세요.</p>}
							</section>
							<OAuthSettings key={dialogGeneration.current} connected={connected} />
							<form
								onSubmit={event => {
									event.preventDefault();
									const secret = key;
									const generation = dialogGeneration.current;
									setKey("");
									void run(`auth:${dialogOwner}:${generation}`, async () => {
										const saved = await request<DesktopCredentialSaveResult>("auth.setKey", {
											provider,
											key: secret,
										});
										if (dialogGeneration.current === generation)
											setNotice(
												saved.catalogRefreshed
													? "API 키를 저장했습니다."
													: "API 키는 저장했습니다. 모델 목록을 새로 고치지 못한 대화에서 목록 다시 불러오기로 재시도하세요.",
											);
									});
								}}
							>
								<h3>API 키</h3>
								<label htmlFor="provider">제공자</label>
								<input
									id="provider"
									list="providers"
									value={provider}
									onChange={event => setProvider(event.target.value)}
									required
								/>
								<datalist id="providers">
									{(keyProviders ?? []).map(name => (
										<option key={name} value={name} />
									))}
								</datalist>
								<label htmlFor="api-key">API 키 (저장 후 표시하지 않음)</label>
								<input
									id="api-key"
									type="password"
									autoComplete="off"
									value={key}
									onChange={event => setKey(event.target.value)}
									required
								/>
								<Button
									type="submit"
									disabled={!connected || pending[authScope] || !provider.trim() || !key.trim()}
								>
									키 저장
								</Button>
							</form>
							<section>
								<h3>안전한 설정</h3>
								{settings === null ? (
									<p>설정 불러오는 중…</p>
								) : settings.length === 0 ? (
									<p>공개된 설정이 없습니다.</p>
								) : (
									<>
										<label htmlFor="setting-search">설정 검색</label>
										<input
											id="setting-search"
											value={settingFilter}
											placeholder="compaction, retry, todo…"
											onChange={event => setSettingFilter(event.target.value)}
										/>
										<p className="muted">
											{filteredSettings.length}개 일치 / 전체 {settings.length}개
											{filteredSettings.length > 200 && " · 처음 200개만 표시"}
										</p>
										{filteredSettings.length === 0 && <p>일치하는 설정이 없습니다.</p>}
										{filteredSettings.slice(0, 200).map(setting => (
											<SettingField
												key={`${setting.path}:${textOf(setting.value)}`}
												setting={setting}
												pending={!connected || pending[settingsScope]}
												onSave={value => saveSetting(setting.path, value)}
											/>
										))}
									</>
								)}
							</section>
							<section>
								<h3>기능 지원 현황</h3>
								<p>
									공개 SDK에서 제공하는 기능만 실행합니다. 미지원 기능은 #7322 상위 구현이 필요할 수 있습니다.
								</p>
								{snapshot?.capabilities.map(capability => (
									<div className="capability" key={capability.id}>
										<strong>{capability.label}</strong>
										<span>{capability.available ? "지원됨" : "사용 불가"}</span>
										{capability.reason && <small>{capability.reason}</small>}
									</div>
								))}
							</section>
						</>
					)}
					{dialog === "commands" && (
						<>
							<p className="muted">
								TUI와 같은 내장 슬래시 명령을 실행합니다. 실행할 수 없는 명령은 실행하지 않고 이유를 표시합니다.
							</p>
							<label htmlFor="command-search">명령 검색</label>
							<input id="command-search" value={filter} onChange={event => setFilter(event.target.value)} />
							<form
								className="command-run"
								onSubmit={event => {
									event.preventDefault();
									runCommand(commandInput);
								}}
							>
								<label htmlFor="command-input">명령 실행</label>
								<input
									id="command-input"
									ref={commandInputRef}
									value={commandInput}
									placeholder="/help"
									onChange={event => setCommandInput(event.target.value)}
								/>
								<Button
									type="submit"
									disabled={
										!connected || !selected || !commandInput.trim() || !!pending[`command:${dialogOwner}`]
									}
								>
									실행
								</Button>
							</form>
							{errors[`command:${dialogOwner}`] && <ErrorBanner>{errors[`command:${dialogOwner}`]}</ErrorBanner>}
							{commandOutput && <pre className="bounded-output">{commandOutput}</pre>}
							<div className="command-list">
								{commands
									.filter(command => command.label.toLowerCase().includes(filter.toLowerCase()))
									.map(command => (
										<Button
											key={command.label}
											disabled={
												!connected ||
												(!!command.needsSession &&
													(!session ||
														(!command.allowDuringRun &&
															(!!pending[selected] || session.status === "running"))))
											}
											onClick={command.action}
										>
											{command.label}
										</Button>
									))}
							</div>
							<h3>GJC 슬래시 명령 {commandList.length > 0 && `(${commandList.length})`}</h3>
							<div className="command-list">
								{commandList
									.filter(command => matchesSlashFilter(command.name, command.description, filter))
									.map(command => (
										<Button
											key={command.name}
											title={command.description}
											disabled={!connected || !selected}
											onClick={() => {
												const text = command.hint ? `/${command.name} ` : `/${command.name}`;
												setCommandInput(text);
												commandInputRef.current?.focus();
											}}
										>
											<code>/{command.name}</code> <small>{command.description}</small>
										</Button>
									))}
							</div>
							{snapshot?.capabilities
								.filter(capability => !capability.available)
								.map(capability => (
									<div className="capability" key={capability.id}>
										<strong>{capability.label} · 사용 불가</strong>
										<small>{capability.reason || "공개 SDK 지원 대기 · #7322"}</small>
									</div>
								))}
						</>
					)}

					{dialog === "fork" && (
						<ForkPanel
							history={history}
							selectedEntryId={forkEntryId}
							pending={!!pending[dialogOwner] || !!pending[`history:${dialogOwner}`]}
							disabled={!connected}
							onSelect={setForkEntryId}
							onFork={forkSession}
							onLoadMore={loadMoreHistory}
						/>
					)}
					{(dialog === "history" || dialog === "fork") &&
						history === null &&
						(errors[`history:${dialogOwner}`] ? (
							<ErrorBanner>{errors[`history:${dialogOwner}`]}</ErrorBanner>
						) : (
							<p>전체 기록 불러오는 중…</p>
						))}
					{dialog === "history" && history !== null && (
						<>
							<p className="muted">
								전체 {history.total}개 중 {history.messages.length}개를 표시합니다.
							</p>
							<div className="history-list">
								{history.messages.map(message => (
									<Message key={message.id} message={message} />
								))}
							</div>
							{history.truncated && (
								<Button disabled={pending[`history:${dialogOwner}`]} onClick={loadMoreHistory}>
									다음 500개 불러오기
								</Button>
							)}
						</>
					)}
					{dialog === "rename" && (
						<form
							onSubmit={event => {
								event.preventDefault();
								void run(selected, async () => {
									await request("session.rename", { sessionId: selected, title: editText });
									closeDialog();
								});
							}}
						>
							<label htmlFor="session-title">대화 이름</label>
							<input id="session-title" value={editText} onChange={event => setEditText(event.target.value)} />
							<Button type="submit" disabled={!connected || pending[selected] || !editText.trim()}>
								저장
							</Button>
						</form>
					)}
					{dialog === "delete" && (
						<>
							<p>“{session?.title}” 대화를 삭제할까요? 이 작업은 되돌릴 수 없습니다.</p>
							<Button
								className="danger"
								disabled={!connected || pending[selected]}
								onClick={() =>
									void run(selected, async () => {
										await request("session.delete", { sessionId: selected });
										closeDialog();
									})
								}
							>
								대화 삭제
							</Button>
						</>
					)}
					{dialog === "tools" && (
						<>
							{pending[toolsScope] ? (
								<p>도구 불러오는 중…</p>
							) : toolNames.length === 0 ? (
								<p>사용 가능한 도구가 없습니다.</p>
							) : (
								toolNames.map(name => (
									<label className="checkbox-label" key={name}>
										<input
											type="checkbox"
											checked={activeTools.includes(name)}
											onChange={event =>
												setActiveTools(previous =>
													event.target.checked
														? [...previous, name]
														: previous.filter(item => item !== name),
												)
											}
										/>
										{name}
									</label>
								))
							)}
							<Button disabled={!connected || pending[toolsScope] || !!errors[toolsScope]} onClick={saveTools}>
								도구 저장
							</Button>
						</>
					)}
					{dialog === "goal" && (
						<>
							<label htmlFor="objective">목표</label>
							<textarea
								id="objective"
								rows={4}
								value={editText}
								onChange={event => setEditText(event.target.value)}
							/>
							<div className="actions">
								{(
									[
										["create", "생성"],
										["get", "조회"],
										["resume", "재개"],
										["pause", "일시 중지"],
										["complete", "완료"],
										["drop", "목표 해제"],
									] as const
								).map(([op, label]) => (
									<Button
										key={op}
										disabled={!connected || pending.goal || (op === "create" && !editText.trim())}
										onClick={() =>
											void run("goal", async () => {
												const value = await request("goal.operate", {
													sessionId: selected,
													op,
													...(op === "create" ? { objective: editText } : {}),
												});
												setResult(textOf(value));
											})
										}
									>
										{label}
									</Button>
								))}
							</div>
							{result && <pre className="bounded-output">{result}</pre>}
						</>
					)}
					{dialog === "result" && <pre className="bounded-output">{result}</pre>}
				</Modal>
			)}
			{connected &&
				Object.values(gateViews).map(view => (
					<GateDialog
						key={view.presentation.id}
						presentation={view.presentation}
						presented={view.presented}
						retiring={view.retiring}
						pending={Boolean(
							pending[`gate:${view.presentation.id}`] || pending[`gate-withdraw:${view.presentation.id}`],
						)}
						error={errors[`gate:${view.presentation.id}`] || errors[`gate-withdraw:${view.presentation.id}`]}
						onPresented={acknowledgeGatePresented}
						onRetired={acknowledgeGateRetired}
						onAnswer={answerGate}
						onWithdraw={withdrawGate}
					/>
				))}
		</div>
	);
}
