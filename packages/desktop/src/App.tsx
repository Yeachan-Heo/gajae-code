import {
	Activity,
	ChevronRight,
	Command,
	FileDiff,
	FolderOpen,
	History,
	Info,
	MoreHorizontal,
	Network,
	PanelLeftClose,
	PanelLeftOpen,
	Pencil,
	Plus,
	Settings2,
	SlidersHorizontal,
	Trash2,
	X,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
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
	DesktopModelProfile,
	DesktopModelRolePreference,
	DesktopPreferenceAction,
	DesktopPreferenceResult,
	DesktopPreferences,
} from "../../desktop-host/src/preferences-protocol";
import type {
	DesktopActivityUpdate,
	DesktopCommand,
	DesktopCommandResult,
	DesktopCredentialSaveResult,
	DesktopDeliveryReceipt,
	DesktopDiff,
	DesktopForkResult,
	DesktopFrame,
	DesktopHistory,
	DesktopMethod,
	DesktopModel,
	DesktopSession,
	DesktopSetting,
	DesktopSnapshot,
	DesktopThinkingLevel,
} from "../../desktop-host/src/protocol";
import type { DesktopSessionInfo } from "../../desktop-host/src/session-info-protocol";
import { ActivityPanel } from "./ActivityPanel";
import {
	AttachmentPicker,
	addDesktopAttachmentFiles,
	type DesktopAttachmentDraft,
	desktopClipboardFiles,
	readyDesktopAttachments,
} from "./AttachmentPicker";
import gajaeMark from "./assets/gajae-mark.png";
import { BtwDialog } from "./BtwDialog";
import { DesktopRequestError, request, selectProject, subscribe, validateDesktopRequest } from "./bridge";
import { matchesSlashFilter } from "./command-search";
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
import { restoreAttachments, restoreDraft } from "./composer-draft";
import {
	commitDraftAndDelivery,
	type DeliveryRecovery,
	deleteDelivery,
	loadDeliveries,
	loadDrafts,
	recoveryNotice,
	saveDelivery,
	saveDrafts,
} from "./delivery-recovery";
import { ForkPanel } from "./ForkPanel";
import { GateDialog } from "./GateDialog";
import { t, useLocale } from "./i18n";
import { McpPanel } from "./McpPanel";
import { ModelPicker } from "./ModelPicker";
import { OAuthSettings } from "./OAuthSettings";
import { OperatorPanel } from "./OperatorPanel";
import { PreferencesPanel } from "./PreferencesPanel";
import { ReasoningSelect } from "./ReasoningSelect";
import { Select } from "./Select";
import { SessionInfoPanel } from "./SessionInfoPanel";
import { SettingsSection, type SettingsTab, SettingsTabs, settingsPanelId, settingsTabId } from "./SettingsTabs";
import {
	applyFontSize,
	applyTheme,
	clampFontSize,
	DESKTOP_THEMES,
	type DesktopThemeId,
	MAX_FONT_SIZE,
	MIN_FONT_SIZE,
	readFontSizePreference,
	readThemePreference,
	THEME_IDS,
	themeLabel,
	writeFontSizePreference,
	writeThemePreference,
} from "./themes";
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
	typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? t("shell.noResult"));
const isFinalDelivery = (disposition: DesktopDeliveryReceipt["disposition"]) =>
	["completed", "cancelled", "refused", "removed", "failed"].includes(disposition);
/** The host accepts a selection or preference write once the session is no longer live. */
const isSettled = (session: DesktopSession) =>
	!["running", "waiting"].includes(session.status) && !session.operatorRunning && (session.queued?.length ?? 0) === 0;

type GoalOp = "create" | "get" | "resume" | "pause" | "complete" | "drop";
/**
 * The same rule the goal strip applies: a running or waiting turn owns the session, so no
 * operation is offered; otherwise only the operations the current goal state allows.
 */
function goalOperationAllowed(op: GoalOp, session: DesktopSession | undefined): boolean {
	if (session && (session.status === "running" || session.status === "waiting")) return false;
	const status = session?.goal?.status;
	switch (op) {
		case "get":
			return true;
		case "create":
			return status === undefined || status === "complete" || status === "dropped";
		case "resume":
			return status === "paused";
		case "pause":
		case "complete":
			return status === "active";
		case "drop":
			return status !== undefined;
	}
}

/** Conversations listed per workspace before "Show more" appends another page. */
const SESSION_PAGE = 5;
export default function App() {
	useLocale();
	const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null);
	const [selected, setSelected] = useState("");
	const selectedRef = useRef(selected);
	selectedRef.current = selected;
	const [activity, setActivity] = useState<DesktopActivityUpdate | null>(null);
	const [activityDetail, setActivityDetail] = useState<DesktopActivityDetail | null>(null);
	const [preferences, setPreferences] = useState<{
		sessionId: string;
		owner: string;
		value: DesktopPreferences;
	} | null>(null);
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
		roles?: DesktopModelRolePreference[];
		profiles?: DesktopModelProfile[];
		loading: boolean;
		error?: string;
	}>({ sessionId: "", generation: null, models: [], loading: false });
	const [theme, setTheme] = useState<DesktopThemeId>(readThemePreference);
	/** Root size in pixels; every layout size in `styles.css` is expressed in rem. */
	const [fontSize, setFontSize] = useState<number>(readFontSizePreference);
	/** What the field shows while it is being typed in; it may hold a partial number. */
	const [fontSizeDraft, setFontSizeDraft] = useState(() => String(readFontSizePreference()));
	const [modelCatalogRevision, setModelCatalogRevision] = useState(0);
	const refreshModelCatalog = useRef(false);
	const [connection, setConnection] = useState(t("shell.connecting"));
	const [fatal, setFatal] = useState(false);
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [errorOwners, setErrorOwners] = useState<Record<string, { requestId: string; sessionId: string }>>({});
	const [recoveries, setRecoveries] = useState<DeliveryRecovery[]>([]);
	const [recoveryBootstrapSettled, setRecoveryBootstrapSettled] = useState(false);
	const recoveriesRef = useRef<DeliveryRecovery[]>([]);
	const recoveryWork = useRef<Promise<void>>(Promise.resolve());
	const ackFlights = useRef(new Set<string>());
	const [unsentBlocked, setUnsentBlocked] = useState<Record<string, boolean>>({});
	const unsentBlockedRef = useRef(new Set<string>());
	const unsentRestoredInMemory = useRef(new Set<string>());
	const unsentRepairs = useRef(new Map<string, string>());
	const restorationFailures = useRef(new Map<string, { sessionId: string; disposition: "refused" | "removed" }>());
	const [, setRestorationRevision] = useState(0);
	const finishUnsentRepair = (id: string, sessionId: string) => {
		unsentRepairs.current.delete(id);
		unsentRestoredInMemory.current.delete(id);
		if ([...unsentRepairs.current.values()].includes(sessionId)) return;
		unsentBlockedRef.current.delete(sessionId);
		setUnsentBlocked(previous => ({ ...previous, [sessionId]: false }));
	};
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
	// These refs are the authoritative draft state during asynchronous durable
	// transactions. A render may still contain an older React snapshot and must
	// never overwrite a handoff that has not yet been published to React.
	const draftsRef = useRef(drafts);
	const attachmentsRef = useRef(attachmentDrafts);
	const [recoveryReady, setRecoveryReady] = useState(false);
	const draftLocks = useRef(new Set<string>());
	const deferredAttachments = useRef(
		new Map<string, Array<(current: DesktopAttachmentDraft[]) => DesktopAttachmentDraft[]>>(),
	);
	const deferredText = useRef(new Map<string, Array<(current: string) => string>>());
	const [busyDrafts, setBusyDrafts] = useState<Record<string, boolean>>({});
	const lockDraft = (sessionId: string) => {
		draftLocks.current.add(sessionId);
		setBusyDrafts(previous => ({ ...previous, [sessionId]: true }));
	};
	const drainDraft = (sessionId: string) => {
		const textUpdates = deferredText.current.get(sessionId) ?? [];
		deferredText.current.delete(sessionId);
		for (const update of textUpdates)
			draftsRef.current = { ...draftsRef.current, [sessionId]: update(draftsRef.current[sessionId] ?? "") };
		if (textUpdates.length) setDrafts(draftsRef.current);
		const updates = deferredAttachments.current.get(sessionId) ?? [];
		deferredAttachments.current.delete(sessionId);
		for (const update of updates) {
			const next = update(attachmentsRef.current[sessionId] ?? []);
			attachmentsRef.current = { ...attachmentsRef.current, [sessionId]: next };
		}
		if (updates.length) setAttachmentDrafts(attachmentsRef.current);
	};
	const unlockDraft = (sessionId: string) => {
		drainDraft(sessionId);
		draftLocks.current.delete(sessionId);
		setBusyDrafts(previous => ({ ...previous, [sessionId]: false }));
	};
	const flushDraft = async (sessionId: string) => {
		do {
			drainDraft(sessionId);
			await saveDrafts([
				{
					sessionId,
					text: draftsRef.current[sessionId] ?? "",
					attachments: (attachmentsRef.current[sessionId] ?? []).filter(item => item.status === "ready"),
				},
			]);
		} while (deferredText.current.has(sessionId) || deferredAttachments.current.has(sessionId));
	};
	const changeText = (sessionId: string, update: (text: string) => string) => {
		if (draftLocks.current.has(sessionId)) {
			const updates = deferredText.current.get(sessionId) ?? [];
			updates.push(update);
			deferredText.current.set(sessionId, updates);
			return;
		}
		draftsRef.current = { ...draftsRef.current, [sessionId]: update(draftsRef.current[sessionId] ?? "") };
		setDrafts(draftsRef.current);
	};
	const changeAttachments = useCallback(
		(sessionId: string, update: (current: DesktopAttachmentDraft[]) => DesktopAttachmentDraft[]) => {
			if (draftLocks.current.has(sessionId)) {
				const updates = deferredAttachments.current.get(sessionId) ?? [];
				updates.push(update);
				deferredAttachments.current.set(sessionId, updates);
				return;
			}
			const current = attachmentsRef.current[sessionId] ?? [];
			const next = update(current);
			if (next !== current) {
				attachmentsRef.current = { ...attachmentsRef.current, [sessionId]: next };
				setAttachmentDrafts(attachmentsRef.current);
			}
		},
		[],
	);
	const updateRecoveries = useCallback((entries: DeliveryRecovery[]) => {
		recoveriesRef.current = entries;
		setRecoveries(entries);
	}, []);
	const enqueueRecovery = useCallback((work: () => Promise<void>) => {
		recoveryWork.current = recoveryWork.current.then(work).catch(error => {
			setErrors(previous => ({
				...previous,
				global: t("shell.recoveryStorageError", {
					detail: error instanceof Error ? error.message : String(error),
				}),
			}));
		});
	}, []);
	const restoreRecovery = useCallback(
		async (entry: DeliveryRecovery) => {
			lockDraft(entry.sessionId);
			try {
				if (entry.restored) {
					await flushDraft(entry.sessionId);
					return;
				}
				const currentText = draftsRef.current[entry.sessionId] ?? "";
				const currentAttachments = attachmentsRef.current[entry.sessionId] ?? [];
				const text = restoreDraft(currentText, entry.text);
				const attachments = restoreAttachments(currentAttachments, entry.attachments);
				const next = { ...entry, restored: true };
				await commitDraftAndDelivery(next, {
					sessionId: entry.sessionId,
					text,
					attachments: attachments.filter(item => item.status === "ready"),
				});
				updateRecoveries(recoveriesRef.current.map(item => (item.id === entry.id ? next : item)));
				const latestText = draftsRef.current[entry.sessionId] ?? "";
				const latestAttachments = attachmentsRef.current[entry.sessionId] ?? [];
				const mergedText = latestText === currentText ? text : restoreDraft(latestText, entry.text);
				const mergedAttachments =
					latestAttachments === currentAttachments
						? attachments
						: restoreAttachments(latestAttachments, entry.attachments);
				draftsRef.current = { ...draftsRef.current, [entry.sessionId]: mergedText };
				attachmentsRef.current = { ...attachmentsRef.current, [entry.sessionId]: mergedAttachments };
				setDrafts(draftsRef.current);
				setAttachmentDrafts(attachmentsRef.current);
				await flushDraft(entry.sessionId);
			} finally {
				unlockDraft(entry.sessionId);
			}
		},
		[updateRecoveries],
	);
	const finalizeRecovery = useCallback(
		async (entry: DeliveryRecovery) => {
			const finalized = { ...entry, finalizing: true };
			await saveDelivery(finalized);
			updateRecoveries(recoveriesRef.current.map(item => (item.id === entry.id ? finalized : item)));
			if (ackFlights.current.has(entry.id)) return;
			ackFlights.current.add(entry.id);
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = Promise.withResolvers<never>();
			timer = setTimeout(() => timeout.reject(new Error(t("shell.deliveryAckTimeout"))), 5000);
			void Promise.race([request("delivery.ack", { deliveryId: entry.id }), timeout.promise])
				.then(() => {
					enqueueRecovery(async () => {
						const current = recoveriesRef.current.find(item => item.id === entry.id);
						if (!current?.finalizing) return;
						await deleteDelivery(entry.id);
						updateRecoveries(recoveriesRef.current.filter(item => item.id !== entry.id));
					});
				})
				.catch(error => {
					setErrors(previous => ({
						...previous,
						global: t("shell.deliveryAckError", {
							detail: error instanceof Error ? error.message : String(error),
						}),
					}));
				})
				.finally(() => {
					if (timer) clearTimeout(timer);
					ackFlights.current.delete(entry.id);
				});
		},
		[updateRecoveries, enqueueRecovery],
	);
	const reconcileReceipt = useCallback(
		async (receipt: DesktopDeliveryReceipt) => {
			const entry = recoveriesRef.current.find(
				item => item.id === receipt.id && item.sessionId === receipt.sessionId,
			);
			if (!entry) return;
			if (entry.prepared) {
				if (unsentRestoredInMemory.current.has(entry.id)) {
					const restored = { ...entry, disposition: "refused" as const, prepared: false, restored: true };
					await commitDraftAndDelivery(restored, {
						sessionId: entry.sessionId,
						text: draftsRef.current[entry.sessionId] ?? "",
						attachments: (attachmentsRef.current[entry.sessionId] ?? []).filter(item => item.status === "ready"),
					});
					updateRecoveries(recoveriesRef.current.map(item => (item.id === entry.id ? restored : item)));
				} else await restoreRecovery({ ...entry, disposition: "refused", prepared: false });
				const current = recoveriesRef.current.find(item => item.id === entry.id);
				if (current) await finalizeRecovery(current);
				finishUnsentRepair(entry.id, entry.sessionId);
				return;
			}
			if (unsentRepairs.current.has(entry.id) && entry.restored) await flushDraft(entry.sessionId);
			if (entry.finalizing) {
				await finalizeRecovery(entry);
				if (unsentRepairs.current.has(entry.id)) finishUnsentRepair(entry.id, entry.sessionId);
				return;
			}
			const next = isFinalDelivery(entry.disposition)
				? entry
				: { ...entry, disposition: receipt.disposition, error: receipt.error };
			try {
				await saveDelivery(next);
				updateRecoveries(recoveriesRef.current.map(item => (item.id === next.id ? next : item)));
				if (next.disposition === "refused" || next.disposition === "removed") await restoreRecovery(next);
			} catch (error) {
				if (next.disposition === "unknown" && !isFinalDelivery(entry.disposition)) {
					updateRecoveries(recoveriesRef.current.map(item => (item.id === entry.id ? next : item)));
				}
				if (next.disposition === "refused" || next.disposition === "removed") {
					restorationFailures.current.set(entry.id, { sessionId: entry.sessionId, disposition: next.disposition });
					setRestorationRevision(revision => revision + 1);
				}
				throw error;
			}
			if (restorationFailures.current.delete(entry.id)) setRestorationRevision(revision => revision + 1);
			if (
				next.disposition === "completed" ||
				next.disposition === "cancelled" ||
				next.disposition === "refused" ||
				next.disposition === "removed"
			) {
				const current = recoveriesRef.current.find(item => item.id === entry.id);
				if (current) await finalizeRecovery(current);
				if (unsentRepairs.current.has(entry.id)) finishUnsentRepair(entry.id, entry.sessionId);
			}
		},
		[restoreRecovery, updateRecoveries, finalizeRecovery],
	);
	useEffect(() => {
		enqueueRecovery(async () => {
			const [entries, storedDrafts] = await Promise.all([loadDeliveries(), loadDrafts()]);
			for (const entry of entries)
				if (entry.prepared) {
					unsentBlockedRef.current.add(entry.sessionId);
					unsentRepairs.current.set(entry.id, entry.sessionId);
				}
			setUnsentBlocked(Object.fromEntries([...unsentBlockedRef.current].map(sessionId => [sessionId, true])));
			updateRecoveries(entries);
			const nextDrafts = { ...draftsRef.current };
			const nextAttachments = { ...attachmentsRef.current };
			for (const draft of storedDrafts) {
				nextDrafts[draft.sessionId] = draft.text;
				nextAttachments[draft.sessionId] = draft.attachments;
			}
			draftsRef.current = nextDrafts;
			attachmentsRef.current = nextAttachments;
			setDrafts(nextDrafts);
			setAttachmentDrafts(nextAttachments);
			setRecoveryReady(true);
		});
	}, [enqueueRecovery, updateRecoveries]);
	useEffect(() => {
		if (!recoveryReady) return;
		enqueueRecovery(async () => {
			const ids = new Set([...Object.keys(draftsRef.current), ...Object.keys(attachmentsRef.current)]);
			await saveDrafts(
				[...ids].map(sessionId => ({
					sessionId,
					text: draftsRef.current[sessionId] ?? "",
					attachments: (attachmentsRef.current[sessionId] ?? []).filter(item => item.status === "ready"),
				})),
			);
		});
	}, [drafts, attachmentDrafts, recoveryReady, enqueueRecovery]);
	const [questionDrafts, setQuestionDrafts] = useState<Record<string, string>>({});
	const [dialog, setDialogState] = useState<Dialog>(null);
	const dialogGeneration = useRef(0);
	const [dialogOwner, setDialogOwner] = useState("");
	const [sidebar, setSidebar] = useState(false);
	const [compactSidebar, setCompactSidebar] = useState(() => {
		try {
			return localStorage.getItem("gjc.desktop.sidebar-compact") === "true";
		} catch {
			return false;
		}
	});
	useEffect(() => {
		try {
			localStorage.setItem("gjc.desktop.sidebar-compact", String(compactSidebar));
		} catch {
			/* A denied local preference must not disable navigation. */
		}
	}, [compactSidebar]);
	const [review, setReview] = useState(false);
	const [wide, setWide] = useState(() => window.matchMedia("(min-width: 1100px)").matches);
	const [diffs, setDiffs] = useState<DesktopDiff[]>([]);
	const [diffPath, setDiffPath] = useState("");
	const [diffLoading, setDiffLoading] = useState(false);
	const [settings, setSettings] = useState<DesktopSetting[] | null>(null);
	const [settingFilter, setSettingFilter] = useState("");
	const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
	const settingsPanelPrefix = useId();
	const settingsPanelsRef = useRef<HTMLDivElement>(null);
	// Each workspace shows a bounded list; "Show more" grows it by a page.
	const [sessionLimits, setSessionLimits] = useState<Record<string, number>>({});
	/** Workspaces whose conversation list is folded away; every project starts expanded. */
	const [collapsedProjects, setCollapsedProjects] = useState<string[]>([]);
	const [menu, setMenu] = useState<
		| { kind: "project"; id: string; x: number; y: number }
		| { kind: "session"; id: string; projectId: string; x: number; y: number }
		| null
	>(null);
	const [dragProject, setDragProject] = useState<string | null>(null);
	const dragProjectRef = useRef<string | null>(null);
	/** The conversation whose open is still outstanding; its transcript is unknown. */
	const [opening, setOpening] = useState<string | null>(null);
	/** The row under the pointer and which of its edges the dragged item will land on. */
	const [dropTarget, setDropTarget] = useState<{ key: string; after: boolean } | null>(null);
	const dropTargetRef = useRef<{ key: string; after: boolean } | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);
	/**
	 * One Escape must dismiss only the drawer's context menu. The menu clears first, then the
	 * modal dialog raises its own close request; this flag tells that request to keep the drawer.
	 */
	const keepDrawerOpen = useRef(false);
	/**
	 * The menu handles Escape itself, which clears the menu state before the window listener and
	 * the dialog's cancel handler see the same keypress. The event's own timestamp identifies
	 * that one keypress, so both later handlers can stand down instead of closing the drawer too.
	 */
	const menuEscapeAt = useRef(-1);
	/**
	 * Suppresses the drawer's close request for the keypress that just dismissed its menu. The
	 * request is dispatched during that same keypress, so the flag expires on the next macrotask
	 * and a later click on the drawer's own close button is never swallowed.
	 */
	const armDrawerSuppression = useCallback(() => {
		keepDrawerOpen.current = true;
		setTimeout(() => {
			keepDrawerOpen.current = false;
		}, 0);
	}, []);
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
	const commandInputRef = useRef<HTMLInputElement>(null);
	const conversation = useRef<HTMLDivElement>(null);
	const follow = useRef(true);
	const session = snapshot?.sessions.find(item => item.id === selected);
	const scopeError = (scope: string) => {
		const owner = errorOwners[scope];
		return owner && owner.sessionId === session?.id && owner.requestId === session?.errorOwner
			? ""
			: (errors[scope] ?? "");
	};
	const project = snapshot?.projects.find(item => item.id === session?.projectId);
	const connected = snapshot !== null && !fatal && recoveryReady;
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
				global: t("shell.draftSaveFailed"),
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
		const reconcileIndividually = async (receipt: DesktopDeliveryReceipt) => {
			try {
				await reconcileReceipt(receipt);
			} catch (error) {
				setErrors(previous => ({
					...previous,
					global: t("shell.recoveryStorageError", {
						detail: error instanceof Error ? error.message : String(error),
					}),
				}));
			}
		};
		const settleFailedBootstrap = () => {
			const receipts: DesktopDeliveryReceipt[] = [];
			for (const event of buffered) {
				if (event.type === "snapshot") receipts.push(...event.snapshot.deliveries);
				if (event.type === "delivery") receipts.push(event.receipt);
			}
			enqueueRecovery(async () => {
				try {
					for (const entry of recoveriesRef.current) {
						const matched = receipts.filter(
							receipt => receipt.id === entry.id && receipt.sessionId === entry.sessionId,
						);
						if (matched.length) {
							for (const receipt of matched) await reconcileIndividually(receipt);
						} else if (
							!entry.prepared &&
							!entry.finalizing &&
							!unsentRepairs.current.has(entry.id) &&
							["pending", "accepted", "queued"].includes(entry.disposition)
						) {
							await reconcileIndividually({ id: entry.id, sessionId: entry.sessionId, disposition: "unknown" });
						}
					}
				} finally {
					if (alive) setRecoveryBootstrapSettled(true);
				}
			});
		};
		const frame = (event: DesktopFrame) => {
			if (!alive || failed) return;
			if (!bootstrapped && event.type !== "fatal") {
				buffered.push(event);
				return;
			}
			if (event.type === "fatal") {
				if (!bootstrapped) settleFailedBootstrap();
				else
					enqueueRecovery(async () => {
						for (const entry of recoveriesRef.current) {
							if (
								!entry.prepared &&
								!entry.finalizing &&
								!unsentRepairs.current.has(entry.id) &&
								["pending", "accepted", "queued"].includes(entry.disposition)
							) {
								await reconcileIndividually({
									id: entry.id,
									sessionId: entry.sessionId,
									disposition: "unknown",
								});
							}
						}
					});
				failed = true;
				setFatal(true);
				setConnection(event.error);
				dialogGeneration.current += 1;
				setDialogState(null);
				setSidebar(false);
				setReview(false);
				setKey("");
			}
			if (event.type === "snapshot") {
				setSnapshot(event.snapshot);
				enqueueRecovery(async () => {
					for (const receipt of event.snapshot.deliveries) await reconcileIndividually(receipt);
				});
			}
			if (event.type === "delivery") enqueueRecovery(() => reconcileReceipt(event.receipt));
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
					const bootstrapDeliveries = [...initial.deliveries];
					for (const event of buffered) {
						if (event.type === "snapshot") bootstrapDeliveries.push(...event.snapshot.deliveries);
						if (event.type === "delivery") bootstrapDeliveries.push(event.receipt);
					}
					enqueueRecovery(async () => {
						try {
							for (const entry of recoveriesRef.current) {
								const receipts = bootstrapDeliveries.filter(
									item => item.id === entry.id && item.sessionId === entry.sessionId,
								);
								if (receipts.length) {
									for (const receipt of receipts) await reconcileIndividually(receipt);
								} else {
									await reconcileIndividually({
										id: entry.id,
										sessionId: entry.sessionId,
										disposition: "unknown",
									});
								}
							}
						} finally {
							if (alive) setRecoveryBootstrapSettled(true);
						}
					});
					bootstrapped = true;
					for (const event of buffered) frame(event);
					setConnection("");
				}
			} catch (error) {
				if (alive) {
					if (!failed && !bootstrapped) settleFailedBootstrap();
					failed = true;
					setFatal(true);
					setConnection(error instanceof Error ? error.message : t("shell.hostConnectionFailed"));
				}
			}
		})();
		return () => {
			alive = false;
			unsubscribe?.();
		};
	}, [applyActivityUpdate, rememberOperator, enqueueRecovery, reconcileReceipt]);
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
						[`activity:${selected}`]: error instanceof Error ? error.message : t("shell.activityLoadFailed"),
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
		void Promise.all([
			request<DesktopModel[]>("models.list", { sessionId: selected, ...(refresh ? { refresh: true } : {}) }),
			request<DesktopPreferences>("preferences.get", { sessionId: selected }),
		])
			.then(([models, preferences]) => {
				if (alive && modelOwnerRef.current === owner)
					setModelCatalog({
						sessionId: selected,
						generation: modelGeneration,
						models,
						roles: preferences.roles,
						profiles: preferences.profiles,
						loading: false,
					});
			})
			.catch(error => {
				if (alive && modelOwnerRef.current === owner)
					setModelCatalog({
						sessionId: selected,
						generation: modelGeneration,
						models: [],
						loading: false,
						error: error instanceof Error ? error.message : t("shell.modelsLoadFailed"),
					});
			});
		return () => {
			alive = false;
		};
	}, [selected, connected, modelGeneration, modelOwner, snapshot?.models, modelCatalogRevision]);
	useEffect(() => {
		applyTheme(theme);
	}, [theme]);
	useEffect(() => {
		applyFontSize(fontSize);
	}, [fontSize]);
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
				if (menuEscapeAt.current === event.timeStamp) return;
				if (menu) {
					armDrawerSuppression();
					setMenu(null);
					return;
				}
				// A dialog owns its own Escape (its cancel request closes it); the drawer and the
				// review pane stay put so one press never dismisses two layers.
				if (dialog) return;
				setSidebar(false);
				setReview(false);
			}
		};
		window.addEventListener("keydown", listener);
		return () => window.removeEventListener("keydown", listener);
	}, [dialog, closeDialog, menu, sidebar, setDialog]);

	/**
	 * A dialog paints its own top layer, so a menu left underneath would be invisible while still
	 * owning the next Escape and its drawer suppression. Opening any dialog dismisses it instead.
	 */
	useEffect(() => {
		if (dialog) setMenu(null);
	}, [dialog]);

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

	// The SDK serializes model/reasoning selection behind its own fence, and issuing
	// one while a turn runs makes queued follow-ups wait behind a selection that in
	// turn waits for idle. Requesting it only once the session is settled keeps both
	// available without that deadlock.
	const [deferredSelection, setDeferredSelection] = useState<{
		ownerKey: string;
		modelId?: string;
		thinkingLevel?: DesktopThinkingLevel;
		preference?: DesktopPreferenceAction;
	} | null>(null);
	const run = useCallback(async (scope: string, action: () => Promise<void>) => {
		if (locks.current.has(scope)) return;
		locks.current.add(scope);
		setPending(previous => ({ ...previous, [scope]: true }));
		setErrors(previous => ({ ...previous, [scope]: "" }));
		setErrorOwners(previous => {
			const next = { ...previous };
			delete next[scope];
			return next;
		});
		const errorSessionId = selectedRef.current;
		try {
			await action();
		} catch (error) {
			if (error instanceof DesktopRequestError)
				setErrorOwners(previous => ({
					...previous,
					[scope]: { requestId: error.requestId, sessionId: errorSessionId },
				}));
			setErrors(previous => ({
				...previous,
				[scope]: scope.startsWith("auth:")
					? t("shell.apiKeyRequestFailed")
					: error instanceof Error
						? error.message
						: t("shell.requestFailed"),
			}));
		} finally {
			locks.current.delete(scope);
			setPending(previous => ({ ...previous, [scope]: false }));
		}
	}, []);
	useEffect(() => {
		const target = deferredSelection;
		if (!target) return;
		// The intent applies only while its own session and control generation stay
		// selected. Any other owner — another conversation or a retired generation —
		// can never apply it, so retire it with a notice instead of dropping it silently.
		if (!session) return;
		if (`${session.id}:${session.controlGeneration}` !== target.ownerKey) {
			setDeferredSelection(null);
			setNotice(t("shell.deferredOwnerChanged"));
			return;
		}
		if (!isSettled(session)) return;
		const scope = `selection:${target.ownerKey}`;
		// Another request owns the scope; keep the intent so it retries when the scope frees.
		if (locks.current.has(scope) || pending[scope]) return;
		const sessionId = session.id;
		const { modelId, thinkingLevel, preference } = target;
		// A level only merges into model.set when the target model declares it, so an
		// incompatible or inherited level cannot reject the model change wholesale.
		const targetModel = modelId === undefined ? undefined : modelCatalog.models.find(item => item.id === modelId);
		const declaresLevel =
			thinkingLevel !== undefined &&
			targetModel?.thinking.options.some(option => option.value === thinkingLevel) === true;
		const merged = modelId !== undefined && thinkingLevel !== undefined && declaresLevel ? thinkingLevel : undefined;
		const followUp =
			modelId !== undefined && thinkingLevel !== undefined && merged === undefined ? thinkingLevel : undefined;
		void run(scope, async () => {
			// A profile or role change lands first so an explicit model choice is not
			// overwritten by the mapping the profile reintroduces.
			if (preference !== undefined) {
				const outcome = await request<DesktopPreferenceResult>("preferences.apply", {
					sessionId,
					action: preference,
				});
				if (modelOwnerRef.current === target.ownerKey) {
					setModelCatalogRevision(value => value + 1);
					setPreferences(previous =>
						previous?.sessionId === sessionId && previous.owner === target.ownerKey
							? { ...previous, value: outcome.preferences }
							: previous,
					);
				}
			}
			if (modelId !== undefined)
				await request("model.set", { sessionId, modelId, ...(merged ? { thinkingLevel: merged } : {}) });
			else if (thinkingLevel !== undefined) {
				await request("thinking.set", { sessionId, level: thinkingLevel });
				return;
			}
			// The model change is committed first; a level it does not declare is offered
			// to the host afterwards so the real reason surfaces instead of being dropped.
			if (followUp !== undefined) await request("thinking.set", { sessionId, level: followUp });
		}).finally(() => {
			// The optimistic value stays visible until the host answers; then the host value
			// takes over, and a rejection leaves its error on this same scope.
			setDeferredSelection(current => (current === target ? null : current));
		});
	}, [deferredSelection, session, pending]);
	const call = (method: DesktopMethod, params: Record<string, unknown> = {}, scope = selected || "global") =>
		run(scope, async () => {
			await request(method, params);
		});
	const select = (item: DesktopSession) => {
		if (!connected) return;
		setSelected(item.id);
		setSidebar(false);
		setOpening(item.id);
		void call("session.select", { sessionId: item.id }, `select:${item.id}`).finally(() => {
			setOpening(current => (current === item.id ? null : current));
		});
	};
	const openProject = () =>
		run("global", async () => {
			const path = await selectProject();
			if (path) await request("project.open", { path });
		});
	const openSettingsTab = (tab: SettingsTab) => {
		setSettingsTab(tab);
		if (settingsPanelsRef.current) settingsPanelsRef.current.scrollTop = 0;
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
	// Zero-argument so entry points can pass this by reference without a click
	// event leaking into the tab state.
	const openSettings = () => openSettingsTab("general");
	const saveSetting = (path: string, value: unknown) => {
		const sessionId = dialogOwner;
		const generation = dialogGeneration.current;
		void run(settingsScope, async () => {
			await request("settings.set", { path, value, sessionId: sessionId || undefined });
			const values = await request<DesktopSetting[]>("settings.get", sessionId ? { sessionId } : {});
			if (dialogGeneration.current === generation) {
				setSettings(values);
				setNotice(t("shell.settingsSaved"));
			}
		});
	};
	const saveTools = () => {
		const sessionId = dialogOwner;
		const generation = dialogGeneration.current;
		void run(toolsScope, async () => {
			await request("tools.set", { sessionId, names: activeTools });
			if (dialogGeneration.current === generation) setNotice(t("shell.toolsSaved"));
		});
	};
	const openBtw = (question = "", composerText?: string) => {
		if (!session || !connected || session.controlGeneration === null) return;
		setBtwOwner({ sessionId: session.id, generation: session.controlGeneration, question, composerText });
		setDialog("btw");
	};
	const send = () => {
		if (!session || !connected || unsentBlockedRef.current.has(session.id)) return;
		const sessionId = session.id;
		const text = drafts[sessionId] || "";
		const ownedAttachments = attachmentDrafts[sessionId] ?? [];
		if (!text.trim() && ownedAttachments.length === 0) return;
		const sideChat = /^\s*\/btw(?:\s+([\s\S]*))?$/i.exec(text);
		if (sideChat) {
			if (ownedAttachments.length) {
				setErrors(previous => ({
					...previous,
					[sessionId]: t("shell.sideChatTextOnly"),
				}));
				return;
			}
			openBtw(sideChat[1]?.trim() ?? "", text);
			return;
		}
		const queued = session.status === "running" || session.status === "waiting";
		void run(queued ? `enqueue:${sessionId}` : sessionId, async () => {
			const attachments = readyDesktopAttachments(ownedAttachments);
			const id = crypto.randomUUID();
			const params = {
				sessionId,
				text,
				...(attachments.length ? { attachments } : {}),
				...(queued ? { deliverAs: "steer" as const } : {}),
			};
			validateDesktopRequest("prompt", params, id);
			const entry: DeliveryRecovery = {
				id,
				sessionId,
				text,
				attachments: ownedAttachments,
				disposition: "pending",
				prepared: true,
			};
			const sentIds = new Set(ownedAttachments.map(draft => draft.id));
			const commit = recoveryWork.current.then(async () => {
				lockDraft(sessionId);
				try {
					const currentText = draftsRef.current[sessionId] ?? "";
					const currentAttachments = attachmentsRef.current[sessionId] ?? [];
					await commitDraftAndDelivery(entry, {
						sessionId,
						text: currentText === text ? "" : currentText,
						attachments: currentAttachments.filter(draft => !sentIds.has(draft.id) && draft.status === "ready"),
					});
					updateRecoveries([...recoveriesRef.current, entry]);
					const latestText = draftsRef.current[sessionId] ?? "";
					draftsRef.current = { ...draftsRef.current, [sessionId]: latestText === text ? "" : latestText };
					attachmentsRef.current = {
						...attachmentsRef.current,
						[sessionId]: (attachmentsRef.current[sessionId] ?? []).filter(draft => !sentIds.has(draft.id)),
					};
					try {
						await flushDraft(sessionId);
						const dispatching = { ...entry, prepared: false };
						await saveDelivery(dispatching);
						updateRecoveries(recoveriesRef.current.map(item => (item.id === id ? dispatching : item)));
					} catch (error) {
						draftsRef.current = {
							...draftsRef.current,
							[sessionId]: restoreDraft(draftsRef.current[sessionId] ?? "", text),
						};
						attachmentsRef.current = {
							...attachmentsRef.current,
							[sessionId]: restoreAttachments(attachmentsRef.current[sessionId] ?? [], ownedAttachments),
						};
						setDrafts(draftsRef.current);
						setAttachmentDrafts(attachmentsRef.current);
						unsentRestoredInMemory.current.add(id);
						unsentRepairs.current.set(id, sessionId);
						unsentBlockedRef.current.add(sessionId);
						setUnsentBlocked(previous => ({ ...previous, [sessionId]: true }));
						try {
							const restored = { ...entry, disposition: "refused" as const, prepared: false, restored: true };
							await commitDraftAndDelivery(restored, {
								sessionId,
								text: draftsRef.current[sessionId] ?? "",
								attachments: (attachmentsRef.current[sessionId] ?? []).filter(item => item.status === "ready"),
							});
							updateRecoveries(recoveriesRef.current.map(item => (item.id === id ? restored : item)));
							await flushDraft(sessionId);
							await finalizeRecovery(restored);
							finishUnsentRepair(id, sessionId);
						} catch {
							// Keep the durable prepared record and block retry until reconciliation succeeds.
						}
						throw error;
					}
					setDrafts(draftsRef.current);
					setAttachmentDrafts(attachmentsRef.current);
				} finally {
					unlockDraft(sessionId);
				}
			});
			recoveryWork.current = commit.catch(() => {});
			await commit;
			try {
				const result = await request<{ queued?: boolean }>("prompt", params, id);
				if (result?.queued) setNotice(t("shell.addedToQueue"));
			} catch (error) {
				enqueueRecovery(async () => {
					const current = recoveriesRef.current.find(item => item.id === id);
					if (!current) return;
					const disposition =
						error instanceof DesktopRequestError ? (error.deliveryDisposition ?? "unknown") : "unknown";
					await reconcileReceipt({
						id,
						sessionId,
						disposition,
						error: error instanceof Error ? error.message : undefined,
					});
				});
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
			const queued = session?.status === "running" || session?.status === "waiting";
			void run(`command:${sessionId}`, async () => {
				const id = crypto.randomUUID();
				const params = { sessionId, text, ...(queued ? { deliverAs: "steer" as const } : {}) };
				validateDesktopRequest("prompt", params, id);
				const entry: DeliveryRecovery = { id, sessionId, text, attachments: [], disposition: "pending" };
				const commit = recoveryWork.current.then(async () => {
					await saveDelivery(entry);
					updateRecoveries([...recoveriesRef.current, entry]);
				});
				recoveryWork.current = commit.catch(() => {});
				await commit;
				closeDialog();
				try {
					const result = await request<{ queued?: boolean }>("prompt", params, id);
					if (result.queued) setNotice(t("shell.addedToQueue"));
				} catch (error) {
					enqueueRecovery(async () => {
						const current = recoveriesRef.current.find(item => item.id === id);
						if (!current) return;
						const disposition =
							error instanceof DesktopRequestError ? (error.deliveryDisposition ?? "unknown") : "unknown";
						await reconcileReceipt({
							id,
							sessionId,
							disposition,
							error: error instanceof Error ? error.message : undefined,
						});
					});
					throw error;
				}
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
						? t("shell.commandNotRun")
						: result.prompt
							? t("shell.commandPrompt", { prompt: result.prompt })
							: result.consumed
								? result.outputTruncated
									? t("shell.commandRanTruncated")
									: t("shell.commandRan")
								: t("shell.commandSentToModel"),
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
				setNotice(t("shell.forkCancelled"));
				return;
			}
			await request<DesktopSession>("session.select", { sessionId: value.session.id });
			if (dialogGeneration.current !== generation || selectedRef.current !== sessionId) return;
			changeText(value.session.id, () => value.selectedText);
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
						diff: error instanceof Error ? error.message : t("shell.diffLoadFailed"),
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
				throw new Error(t("shell.toolListInvalid"));
			setToolNames(value.available);
			setActiveTools(value.active);
		});
	};
	const activityScope = `activity:${dialogOwner || selected}`;
	const activityDetailScope = `activity-detail:${dialogOwner}:${dialogGeneration.current}`;
	const preferencesScope = `preferences:${dialogOwner}:${dialogGeneration.current}:${modelOwner}`;
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
		const owner = modelOwnerRef.current;
		setPreferences(null);
		void run(`preferences:${sessionId}:${generation}:${owner}`, async () => {
			const value = await request<DesktopPreferences>("preferences.get", { sessionId });
			if (dialogGeneration.current === generation && modelOwnerRef.current === owner)
				setPreferences({ sessionId, owner, value });
		});
	};
	const openPreferences = () => {
		if (selected) setDialog("preferences");
	};
	const applyPreferences = (action: DesktopPreferenceAction) => {
		const sessionId = dialogOwner;
		const generation = dialogGeneration.current;
		const owner = modelOwnerRef.current;
		if (preferences?.sessionId !== sessionId || preferences.owner !== owner) return;
		const dialogSession = snapshot?.sessions.find(item => item.id === sessionId);
		if (dialogSession && !isSettled(dialogSession)) {
			// Same rule as the picker: hold the choice and dispatch it when the session settles.
			setDeferredSelection(previous =>
				previous?.ownerKey === owner
					? { ...previous, preference: action }
					: { ownerKey: owner, preference: action },
			);
			return;
		}
		setDeferredSelection(previous => (previous?.ownerKey === owner ? null : previous));
		void run(`preferences:${sessionId}:${generation}:${owner}`, async () => {
			const outcome = await request<DesktopPreferenceResult>("preferences.apply", { sessionId, action });
			if (modelOwnerRef.current === owner) {
				setModelCatalogRevision(value => value + 1);
				if (dialogGeneration.current === generation)
					setPreferences({ sessionId, owner, value: outcome.preferences });
			}
		});
	};
	useEffect(() => {
		if (dialog === "preferences" && selected && connected) loadPreferences(selected, dialogGeneration.current);
	}, [dialog, selected, connected, modelOwner]);
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
				setNotice(t("shell.administratorChangeAcknowledged"));
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
				if (!view) throw new Error(t("shell.gateWithdrawOwnerUnknown"));
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
			if (!view) throw new Error(t("shell.gatePresentedOwnerUnknown"));
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
			if (!view || view.retiring?.nonce !== nonce) throw new Error(t("shell.gateRetiredNonceMismatch"));
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
			if (!view) throw new Error(t("shell.gateAnswerOwnerUnknown"));
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
					? t("shell.foldUnsupported")
					: result.status === "already_backgrounded"
						? t("shell.foldAlreadyBackgrounded")
						: t("shell.foldMoved"),
			);
		});
	};
	const modelControls = (owner: DesktopSession) => {
		const ownerKey = `${owner.id}:${owner.controlGeneration}`;
		const modelScope = `model:${ownerKey}`;
		const thinkingScope = `thinking:${ownerKey}`;
		const deferred = deferredSelection?.ownerKey === ownerKey ? deferredSelection : null;
		// The deferred dispatch is a real write: show it as applying and keep the chosen
		// value on screen until the host answers.
		const selectionScope = `selection:${ownerKey}`;
		const changing = !!(pending[modelScope] || pending[thinkingScope] || pending[selectionScope]);
		// Every write goes through one rule: settled now, dispatch now; otherwise hold it.
		const settled = isSettled(owner);
		const deferModel = (modelId: string) =>
			setDeferredSelection(previous =>
				previous?.ownerKey === ownerKey ? { ...previous, modelId } : { ownerKey, modelId },
			);
		const deferThinking = (thinkingLevel: DesktopThinkingLevel) =>
			setDeferredSelection(previous =>
				previous?.ownerKey === ownerKey ? { ...previous, thinkingLevel } : { ownerKey, thinkingLevel },
			);
		const deferPreference = (preference: DesktopPreferenceAction) =>
			setDeferredSelection(previous =>
				previous?.ownerKey === ownerKey ? { ...previous, preference } : { ownerKey, preference },
			);
		const route = (dispatch: () => void, defer: () => void) => {
			// A direct write retires any earlier intent so a stale choice cannot win later.
			if (settled) {
				setDeferredSelection(previous => (previous?.ownerKey === ownerKey ? null : previous));
				dispatch();
			} else defer();
		};
		const routePreference = (preference: DesktopPreferenceAction, runNow: () => void) =>
			route(runNow, () => deferPreference(preference));
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
					roles={catalog?.roles ?? []}
					profiles={catalog?.profiles}
					onConfigureProviders={() => openSettingsTab("account")}
					selectedId={deferred?.modelId ?? owner.model}
					disabled={!connected || changing}
					onRefresh={() => {
						refreshModelCatalog.current = true;
						setModelCatalogRevision(value => value + 1);
					}}
					refreshing={catalog?.loading === true}
					loading={loadingModels}
					onApplyProfile={(profileId, scope) => {
						if (modelOwnerRef.current !== ownerKey) return;
						const action: DesktopPreferenceAction = { type: "profile.select", name: profileId, scope };
						routePreference(
							action,
							() =>
								void run(modelScope, async () => {
									await request<DesktopPreferenceResult>("preferences.apply", { sessionId: owner.id, action });
									if (modelOwnerRef.current === ownerKey) setModelCatalogRevision(value => value + 1);
								}),
						);
					}}
					pending={pending[modelScope]}
					applying={changing}
					onSelect={modelId => {
						if (modelOwnerRef.current !== ownerKey) return;
						route(
							() => void call("model.set", { sessionId: owner.id, modelId }, modelScope),
							() => deferModel(modelId),
						);
					}}
					onAssign={(role, modelId, scope) => {
						if (modelOwnerRef.current !== ownerKey) return;
						if (role !== "default" && scope !== "session") return;
						if (role === "default" && modelId !== null && scope === "session") {
							route(
								() =>
									void run(modelScope, async () => {
										await request("model.set", { sessionId: owner.id, modelId });
										if (modelOwnerRef.current === ownerKey) setModelCatalogRevision(value => value + 1);
									}),
								() => deferModel(modelId),
							);
							return;
						}
						const action: DesktopPreferenceAction = { type: "role.set", role, modelId };
						routePreference(
							action,
							() =>
								void run(modelScope, async () => {
									await request<DesktopPreferenceResult>("preferences.apply", { sessionId: owner.id, action });
									if (modelOwnerRef.current === ownerKey) setModelCatalogRevision(value => value + 1);
								}),
						);
					}}
				/>
				<ReasoningSelect
					thinking={
						deferred?.thinkingLevel !== undefined && owner.thinking
							? { ...owner.thinking, level: deferred.thinkingLevel }
							: owner.thinking
					}
					disabled={!connected || changing || !currentModelAvailable}
					pending={pending[thinkingScope]}
					onChange={level => {
						if (modelOwnerRef.current !== ownerKey) return;
						route(
							() => void call("thinking.set", { sessionId: owner.id, level }, thinkingScope),
							() => deferThinking(level),
						);
					}}
				/>
				{/* The loading state lives in the model trigger, so no line appears until there is
				    something the trigger cannot say. */}
				{!loadingModels && (changing || !currentModelAvailable) && (
					<small className="model-control-status" role="status">
						{changing ? t("models.applyingSelection") : t("shell.providerRequired")}
					</small>
				)}
				{!loadingModels && !catalog?.error && catalog?.models.length === 0 && (
					<Button disabled={!connected} onClick={() => openSettingsTab("account")}>
						{t("shell.addProvider")}
					</Button>
				)}
				{catalog?.error && (
					<div className="model-control-status">
						<ErrorBanner>{catalog.error}</ErrorBanner>
					</div>
				)}
				{[modelScope, thinkingScope, selectionScope].map(
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
		{ label: t("shell.sideChatCommand"), needsSession: true, allowDuringRun: true, action: () => openBtw() },
		{
			label: t("shell.openProject"),
			action: () => {
				closeDialog();
				void openProject();
			},
		},
		{ label: t("shell.settingsAndCapabilities"), action: openSettings },
		{
			label: t("shell.directExecution"),
			needsSession: true,
			action: () => {
				setDialog("operator");
			},
		},
		{
			label: t("shell.forkConversation"),
			needsSession: true,
			action: openFork,
		},
		{
			label: t("shell.compactConversation"),
			needsSession: true,
			action: () => {
				closeDialog();
				void call("session.compact", { sessionId: selected });
			},
		},
		{
			label: t("shell.retryResponse"),
			needsSession: true,
			action: () => {
				closeDialog();
				void call("session.retry", { sessionId: selected });
			},
		},
		{
			label: t("shell.exportConversation"),
			needsSession: true,
			action: () => {
				void run(selected, async () => {
					const value = await request<{ path: string }>("session.export", { sessionId: selected });
					setResult(t("shell.exportedConversation", { path: value.path }));
					setDialog("result");
				});
			},
		},
		{ label: t("shell.manageActiveTools"), needsSession: true, action: openTools },
		{
			label: t("shell.manageGoal"),
			needsSession: true,
			action: () => {
				setEditText("");
				setResult("");
				setDialog("goal");
			},
		},
	];
	useEffect(() => {
		if (!menu) return;
		menuRef.current?.focus();
	}, [menu]);
	const clearDrag = () => {
		dropTargetRef.current = null;
		setDropTarget(null);
		dragProjectRef.current = null;
		setDragProject(null);
	};
	/** Move one item one slot up or down; the keyboard path for list reordering. */
	const moveProject = (id: string, direction: -1 | 1) => {
		const ids = (snapshot?.projects ?? []).map(project => project.id);
		const from = ids.indexOf(id);
		const to = from + direction;
		if (from < 0 || to < 0 || to >= ids.length) return;
		ids.splice(to, 0, ...ids.splice(from, 1));
		setMenu(null);
		if (connected) void call("project.reorder", { ids }, "global");
	};
	const closeProject = (projectId: string) => {
		setMenu(null);
		if (!connected) return;
		const owned = (snapshot?.sessions ?? []).filter(session => session.projectId === projectId);
		if (owned.some(session => session.id === selected)) setSelected("");
		// Its own scope: closing must not be dropped because a conversation is being created.
		void call("project.close", { projectId }, `close-project:${projectId}`);
	};
	const sidebarContent = (
		<>
			<header className="sidebar-heading">
				<strong>
					<img className="brand-mark" src={gajaeMark} alt="" aria-hidden="true" />{" "}
					<span className="sidebar-label">Gajae Code</span>
				</strong>
			</header>
			<Button
				className="sidebar-open-project"
				aria-label={t("shell.openProject")}
				title={t("shell.openProject")}
				disabled={!connected || pending.global}
				onClick={() => void openProject()}
			>
				<FolderOpen size={16} aria-hidden="true" /> <span className="sidebar-label">{t("shell.openProject")}</span>
			</Button>
			<nav aria-label={t("shell.projectsAndConversations")} onDragEnd={clearDrag}>
				{(snapshot?.projects ?? []).map(item => {
					// The host catalog appends new conversations. Reverse that creation sequence for
					// display only; message/status updates must not shuffle a running list.
					const all = snapshot?.sessions.filter(chat => chat.projectId === item.id).toReversed() ?? [];
					const limit = sessionLimits[item.id] ?? SESSION_PAGE;
					// Selecting or creating a conversation beyond the page must not hide its own row.
					const selectedIndex = all.findIndex(chat => chat.id === selected);
					const pageSize = Math.max(limit, selectedIndex + 1);
					const visible = all.slice(0, pageSize);
					const remaining = all.length - visible.length;
					return (
						<section
							className={`project-group ${dragProject === item.id ? "dragging" : ""} ${
								dropTarget?.key === `project:${item.id}`
									? `drop-target ${dropTarget.after ? "drop-after" : "drop-before"}`
									: ""
							}`}
							key={item.id}
							onContextMenu={event => {
								event.preventDefault();
								setMenu({ kind: "project", id: item.id, x: event.clientX, y: event.clientY });
							}}
							onDragOver={event => {
								// The cue follows the drag state; the payload is read in the drop below, which
								// is where a browser exposes it.
								const dragged = dragProjectRef.current;
								if (!dragged || dragged === item.id) return;
								event.preventDefault();
								const order = (snapshot?.projects ?? []).map(project => project.id);
								// The cue marks the edge the drop inserts at, matching the splice below.
								setDropTarget({
									key: `project:${item.id}`,
									after: order.indexOf(dragged) < order.indexOf(item.id),
								});
							}}
							onDragLeave={() =>
								setDropTarget(previous => (previous?.key === `project:${item.id}` ? null : previous))
							}
							onDrop={event => {
								// The payload is authoritative: a fast drag can drop before React
								// has re-rendered the handlers with the drag state.
								const dragged = event.dataTransfer?.getData("text/plain") || dragProject;
								if (!dragged || dragged === item.id) return;
								event.preventDefault();
								const ids = (snapshot?.projects ?? []).map(project => project.id);
								const from = ids.indexOf(dragged);
								const to = ids.indexOf(item.id);
								if (from < 0 || to < 0) return;
								ids.splice(to, 0, ...ids.splice(from, 1));
								clearDrag();
								if (connected) void call("project.reorder", { ids }, "global");
							}}
						>
							<div
								className="project-heading"
								draggable
								tabIndex={0}
								aria-haspopup="menu"
								onKeyDown={event => {
									if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
									event.preventDefault();
									const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
									setMenu({ kind: "project", id: item.id, x: box.left, y: box.bottom });
								}}
								onDragStart={event => {
									dragProjectRef.current = item.id;
									setDragProject(item.id);
									event.dataTransfer?.setData("text/plain", item.id);
									if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
								}}
								onDragEnd={clearDrag}
							>
								<Button
									className="project-toggle"
									title={item.name}
									aria-expanded={!collapsedProjects.includes(item.id)}
									aria-label={
										collapsedProjects.includes(item.id)
											? t("shell.expandConversations", { project: item.name })
											: t("shell.collapseConversations", { project: item.name })
									}
									onClick={() =>
										setCollapsedProjects(previous =>
											previous.includes(item.id)
												? previous.filter(id => id !== item.id)
												: [...previous, item.id],
										)
									}
								>
									<ChevronRight
										className="disclosure-chevron"
										aria-hidden="true"
										data-open={collapsedProjects.includes(item.id) ? undefined : true}
									/>
									<span className="project-initials" aria-hidden="true">
										{Array.from(item.name).slice(0, 2).join("")}
									</span>
								</Button>
								<h2 title={item.path}>{item.name}</h2>
								<Button
									aria-label={t("shell.newConversationIn", { project: item.name })}
									disabled={!connected || pending[`project:${item.id}`]}
									onClick={() =>
										void run(`project:${item.id}`, async () => {
											const created = await request<DesktopSession>("session.create", {
												projectId: item.id,
											});
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
							{!collapsedProjects.includes(item.id) && (
								<>
									<small className="path">{item.path}</small>
									{errors[`project:${item.id}`] && <ErrorBanner>{errors[`project:${item.id}`]}</ErrorBanner>}
									{visible.map(chat => (
										<div
											key={chat.id}
											className="session-item"
											onContextMenu={event => {
												event.preventDefault();
												event.stopPropagation();
												setMenu({
													kind: "session",
													id: chat.id,
													projectId: item.id,
													x: event.clientX,
													y: event.clientY,
												});
											}}
										>
											<SessionRow
												session={chat}
												selected={chat.id === selected}
												onSelect={() => select(chat)}
												onMenu={(x, y) =>
													setMenu({ kind: "session", id: chat.id, projectId: item.id, x, y })
												}
											/>
										</div>
									))}
									{remaining > 0 && (
										<Button
											className="show-more"
											aria-label={t("shell.showMoreConversations", {
												count: Math.min(SESSION_PAGE, remaining),
											})}
											title={t("shell.showMoreConversations", { count: Math.min(SESSION_PAGE, remaining) })}
											onClick={() =>
												setSessionLimits(previous => ({
													...previous,
													[item.id]: pageSize + SESSION_PAGE,
												}))
											}
										>
											<span className="sidebar-label">
												{t("shell.showMoreConversations", { count: Math.min(SESSION_PAGE, remaining) })}
											</span>
											<MoreHorizontal className="compact-more" aria-hidden="true" />
										</Button>
									)}
								</>
							)}
						</section>
					);
				})}
			</nav>
			<footer>
				<Button
					onClick={openSettings}
					disabled={!connected}
					aria-label={t("shell.settings")}
					title={t("shell.settings")}
				>
					<Settings2 size={16} aria-hidden="true" /> <span className="sidebar-label">{t("shell.settings")}</span>
				</Button>
				<Button
					className="sidebar-toggle"
					aria-label={t(compactSidebar ? "shell.expandSidebar" : "shell.collapseSidebar")}
					title={t(compactSidebar ? "shell.expandSidebar" : "shell.collapseSidebar")}
					aria-expanded={!compactSidebar}
					onClick={() => setCompactSidebar(value => !value)}
				>
					{compactSidebar ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
				</Button>
			</footer>
		</>
	);
	const reviewContent = (
		<>
			{wide && (
				<header>
					<h2>{t("shell.reviewChanges")}</h2>
					<Button aria-label={t("shell.closeReviewChanges")} onClick={() => setReview(false)}>
						<X aria-hidden="true" />
					</Button>
				</header>
			)}
			{errors.diff && <ErrorBanner>{errors.diff}</ErrorBanner>}
			{diffLoading ? (
				<p role="status">{t("shell.loadingChanges")}</p>
			) : diffs.length ? (
				<>
					<div className="select-field">
						<label id="diff-file">{t("shell.file")}</label>
						<Select
							value={diffPath}
							options={diffs.map(file => ({ value: file.path, label: `${file.status} · ${file.path}` }))}
							ariaLabel={t("shell.file")}
							ariaLabelledby="diff-file"
							onChange={setDiffPath}
						/>
					</div>
					<pre className="diff-output">{diffs.find(file => file.path === diffPath)?.patch}</pre>
				</>
			) : (
				<p className="muted">{t("shell.noChanges")}</p>
			)}
		</>
	);
	const recoveryPanel = (item: DeliveryRecovery) => {
		if (!recoveryBootstrapSettled) return null;
		const restorationFailure = restorationFailures.current.get(item.id);
		const copy =
			restorationFailure?.sessionId === item.sessionId
				? t("shell.recoveryRestoreFailed")
				: recoveryNotice(item, unsentRepairs.current.get(item.id) === item.sessionId);
		return copy ? (
			<div className="notice" key={item.id} role="status">
				<p>{copy}</p>
				{item.error && <p>{item.error}</p>}
				{(unsentRepairs.current.get(item.id) === item.sessionId ||
					restorationFailure?.sessionId === item.sessionId) && (
					<Button
						onClick={() =>
							enqueueRecovery(async () => {
								const current = recoveriesRef.current.find(entry => entry.id === item.id);
								const failure = restorationFailures.current.get(item.id);
								if (
									current &&
									(unsentRepairs.current.get(current.id) === current.sessionId ||
										failure?.sessionId === current.sessionId)
								)
									await reconcileReceipt({
										id: current.id,
										sessionId: current.sessionId,
										disposition: failure?.sessionId === current.sessionId ? failure.disposition : "refused",
									});
							})
						}
					>
						{t("shell.retryRecovery")}
					</Button>
				)}
				<Button
					disabled={
						item.restored || unsentBlocked[item.sessionId] || restorationFailure?.sessionId === item.sessionId
					}
					onClick={() =>
						enqueueRecovery(async () => {
							const current = recoveriesRef.current.find(entry => entry.id === item.id);
							if (current) await restoreRecovery(current);
						})
					}
				>
					{t("shell.restoreDraft")}
				</Button>
				<Button
					disabled={
						(!isFinalDelivery(item.disposition) && !(item.disposition === "unknown" && item.restored)) ||
						item.finalizing ||
						unsentRepairs.current.has(item.id) ||
						restorationFailure?.sessionId === item.sessionId
					}
					onClick={() =>
						enqueueRecovery(async () => {
							const current = recoveriesRef.current.find(entry => entry.id === item.id);
							if (
								!current ||
								current.finalizing ||
								unsentRepairs.current.has(current.id) ||
								restorationFailures.current.get(current.id)?.sessionId === current.sessionId
							)
								return;
							if (
								isFinalDelivery(current.disposition) ||
								(current.disposition === "unknown" && current.restored)
							)
								await finalizeRecovery(current);
						})
					}
				>
					{item.disposition === "unknown" ? t("shell.discardRestoredRecord") : t("shell.discardRecoveryRecord")}
				</Button>
			</div>
		) : null;
	};
	const menuSession =
		menu?.kind === "session" ? (snapshot?.sessions ?? []).find(session => session.id === menu.id) : undefined;
	const menuProjectIndex = menu?.kind === "project" ? (snapshot?.projects ?? []).findIndex(p => p.id === menu.id) : -1;
	const menuProjectCount = (snapshot?.projects ?? []).length;
	/** True when the workspace being closed has a turn running, so the label can say it stops. */
	const menuProjectBusy =
		menu?.kind === "project" &&
		(snapshot?.sessions ?? []).some(
			session => session.projectId === menu.id && (session.status === "running" || session.status === "waiting"),
		);
	// The context menu lives inside the drawer while it is open: a modal dialog paints in the
	// top layer, so a menu rendered beside it would be invisible and inert.
	const contextMenu = menu && (
		<>
			{/* Any click outside dismisses; the menu itself stops propagation. */}
			<button className="menu-scrim" aria-label={t("shell.dismissMenu")} onClick={() => setMenu(null)} />
			<div
				className="context-menu"
				role="menu"
				ref={menuRef}
				tabIndex={-1}
				onKeyDown={event => {
					if (event.key !== "Escape") return;
					event.preventDefault();
					menuEscapeAt.current = event.timeStamp;
					// Focused inside the menu: the dialog's cancel request is suppressed here.
					armDrawerSuppression();
					setMenu(null);
				}}
				style={{
					left: Math.max(8, Math.min(menu.x, window.innerWidth - 240)),
					top: Math.max(8, Math.min(menu.y, window.innerHeight - 168)),
				}}
			>
				{menu.kind === "project" ? (
					<>
						<Button role="menuitem" disabled={menuProjectIndex <= 0} onClick={() => moveProject(menu.id, -1)}>
							{t("shell.moveWorkspace")}
						</Button>
						<Button
							role="menuitem"
							disabled={menuProjectIndex < 0 || menuProjectIndex >= menuProjectCount - 1}
							onClick={() => moveProject(menu.id, 1)}
						>
							{t("shell.moveWorkspaceBack")}
						</Button>
						<Button
							role="menuitem"
							disabled={!!pending[`project:${menu.id}`]}
							onClick={() => closeProject(menu.id)}
						>
							{menuProjectBusy ? t("shell.closeWorkspaceBusy") : t("shell.closeWorkspace")}
						</Button>
					</>
				) : (
					menuSession && (
						<Button
							role="menuitem"
							onClick={() => {
								setMenu(null);
								select(menuSession);
							}}
						>
							{t("shell.openConversation")}
						</Button>
					)
				)}
			</div>
		</>
	);
	return (
		<div className="app-shell">
			<aside className="sidebar desktop-sidebar" data-compact={compactSidebar || undefined}>
				{sidebarContent}
			</aside>
			{sidebar && (
				<Modal
					title={t("shell.projectsAndConversations")}
					className="sidebar-drawer"
					onClose={() => {
						// A menu dismissal and the dialog's close request are one Escape, not two.
						if (keepDrawerOpen.current) {
							keepDrawerOpen.current = false;
							return;
						}
						if (menu) {
							setMenu(null);
							return;
						}
						setSidebar(false);
					}}
				>
					{sidebarContent}
					{contextMenu}
				</Modal>
			)}
			{!sidebar && contextMenu}
			<main className="main-pane">
				<header className="toolbar">
					<Button className="mobile-only" onClick={() => setSidebar(true)}>
						{t("shell.projects")}
					</Button>
					<div className="toolbar-title">
						{project && <small>{project.name}</small>}
						<h1>{session?.title || t("shell.startInProject")}</h1>
					</div>
					{session && (
						<>
							<Button aria-pressed={review} disabled={!connected} onClick={() => setReview(!review)}>
								<FileDiff size={15} aria-hidden="true" /> {t("shell.reviewChanges")}
							</Button>

							<Button
								disabled={!connected}
								onClick={() => {
									setDialog("activity");
									refreshActivity();
								}}
							>
								<Activity size={15} aria-hidden="true" /> {t("shell.activity")}
								{activity?.sessionId === selected &&
									activity.activity.sessionState?.gates.available &&
									activity.activity.sessionState.gates.pending.length > 0 && (
										<span className="activity-badge">
											{t("shell.needsInputCount", {
												count: activity.activity.sessionState.gates.pending.length,
											})}
										</span>
									)}
							</Button>
							<Button
								disabled={!connected}
								aria-label={t("shell.conversationActionsMenu")}
								title={t("shell.conversationActionsMenu")}
								onClick={() => setDialog("session-actions")}
							>
								<MoreHorizontal size={16} aria-hidden="true" />
							</Button>
						</>
					)}
					<Button disabled={!connected} onClick={openCommands}>
						{t("shell.commands")}
					</Button>
				</header>
				{connection && fatal && <ErrorBanner>{t("shell.disconnected", { connection })}</ErrorBanner>}
				{errors.global && <ErrorBanner>{errors.global}</ErrorBanner>}
				{!session && recoveries.map(recoveryPanel)}
				{Object.entries(errors)
					.filter(([scope, error]) => scope.startsWith("gate") && error)
					.map(([scope, error]) => (
						<ErrorBanner key={scope}>{error}</ErrorBanner>
					))}
				{session ? (
					<>
						<div
							className="conversation"
							ref={conversation}
							onScroll={event => {
								const node = event.currentTarget;
								follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100;
							}}
						>
							{session.historyTruncated && <p className="muted">{t("shell.historyTruncated")}</p>}
							{session.messages.length > historyLimit && (
								<Button onClick={() => setHistoryLimit(value => value + 100)}>
									{t("shell.showOlderMessages")}
								</Button>
							)}
							{session.messages.length === 0 &&
								(opening === session.id ? (
									<div className="empty" role="status">
										{t("shell.loadingConversation")}
									</div>
								) : (
									<div className="empty">{t("shell.emptyConversation")}</div>
								))}
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
								<strong>{t("shell.queuedCount", { count: session.queued.length })}</strong>
								{session.queued.map(item => (
									<div className="queued-input" key={item.id}>
										<span>
											{item.deliverAs === "steer" ? t("shell.queueSteer") : t("shell.queueFollowUp")} ·{" "}
											{item.text.slice(0, 120)}
										</span>
										<small>
											{item.execution === "joined-current-run" || item.execution === "promoted-to-run"
												? t("shell.queueApplied")
												: item.cancelable
													? t("shell.queueWaiting")
													: t("shell.queueProcessing")}
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
														if (!outcome.removed) setNotice(t("shell.queueCancelTooLate"));
													})
												}
											>
												{t("support.cancel")}
											</Button>
										)}
									</div>
								))}
							</div>
						)}
						{recoveries.filter(item => item.sessionId === session.id).map(recoveryPanel)}
						{(session.todos?.length ?? 0) > 0 && <TodoPanel phases={session.todos!} />}
						{session.goal && (
							<>
								<GoalStrip
									goal={session.goal}
									pending={!!pending[`goal:${session.id}`]}
									busy={session.status === "running" || session.status === "waiting"}
									onOperate={op =>
										void call("goal.operate", { sessionId: session.id, op }, `goal:${session.id}`)
									}
								/>
								{errors[`goal:${session.id}`] && <ErrorBanner>{errors[`goal:${session.id}`]}</ErrorBanner>}
							</>
						)}
						<div className="composer-area">
							<Composer
								controls={modelControls(session)}
								attachment={
									<AttachmentPicker
										sessionId={session.id}
										attachments={attachmentDrafts[session.id] ?? []}
										supportsImageInput={session.imageInput?.supported !== false}
										imagesBlocked={session.imageInput?.blocked}
										disabled={!connected || busyDrafts[session.id]}
										onChange={changeAttachments}
									/>
								}
								hasAttachments={(attachmentDrafts[session.id]?.length ?? 0) > 0}
								allowQueue={!session.operatorRunning}
								sendDisabled={
									session.operatorRunning ||
									unsentBlocked[session.id] ||
									attachmentDrafts[session.id]?.some(
										draft =>
											draft.status !== "ready" ||
											(draft.attachment.kind === "image" &&
												(session.imageInput?.supported === false || session.imageInput?.blocked === true)),
									)
								}
								onPaste={event => {
									// A paste that carries text stays a text paste; a copied file from Finder
									// carries none and becomes an attachment.
									if (event.clipboardData.types.includes("text/plain")) return;
									const files = desktopClipboardFiles(event.clipboardData);
									if (!files.length || !connected || draftLocks.current.has(session.id)) return;
									event.preventDefault();
									addDesktopAttachmentFiles(
										{
											sessionId: session.id,
											attachments: attachmentDrafts[session.id] ?? [],
											supportsImageInput: session.imageInput?.supported !== false,
											imagesBlocked: session.imageInput?.blocked,
											disabled: !connected || busyDrafts[session.id],
											onChange: changeAttachments,
										},
										files,
									);
								}}
								value={drafts[selected] || ""}
								onChange={value => changeText(selected, () => value)}
								onSend={send}
								onStop={() => void call("abort", { sessionId: selected }, `abort:${selected}`)}
								busy={session.status === "running" || session.status === "waiting"}
								onSlash={openCommands}
								disabled={!connected || busyDrafts[session.id]}
							/>
						</div>
					</>
				) : connection && !fatal ? (
					<div className="empty connection-state" role="status">
						<img className="empty-brand" src={gajaeMark} alt="" aria-hidden="true" />
						<p>{connection}</p>
					</div>
				) : (
					<div className="empty">
						<img className="empty-brand" src={gajaeMark} alt="" aria-hidden="true" />
						<h2>{snapshot?.projects.length ? t("shell.selectConversation") : t("shell.openProjectToStart")}</h2>
						<Button disabled={!connected || pending.global} onClick={() => void openProject()}>
							{t("shell.chooseProjectFolder")}
						</Button>
					</div>
				)}
			</main>
			{review && wide && <aside className="review-pane">{reviewContent}</aside>}
			{review && !wide && (
				<div className="review-drawer">
					<Modal title={t("shell.reviewChanges")} onClose={() => setReview(false)}>
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
							changeText(sessionId, current => (current === composerText ? "" : current));
					}}
				/>
			)}
			{dialog && dialog !== "btw" && dialogOwner === selected && (
				<Modal
					title={
						{
							settings: t("shell.settings"),
							commands: t("shell.commands"),
							history: t("shell.dialogHistory"),
							fork: t("shell.dialogFork"),
							rename: t("shell.dialogRename"),
							delete: t("shell.dialogDelete"),
							tools: t("shell.dialogTools"),
							goal: t("shell.dialogGoal"),
							result: t("shell.dialogResult"),
							activity: t("shell.dialogActivity"),
							"activity-detail": t("shell.dialogActivityDetail"),
							preferences: t("shell.dialogPreferences"),
							operator: t("shell.dialogOperator"),
							mcp: t("shell.dialogMcp"),
							"session-info": t("shell.dialogSessionInfo"),
							"session-actions": t("shell.conversationActions"),
						}[dialog]
					}
					onClose={closeDialog}
				>
					{[settingsScope, authScope, toolsScope, "goal", selected].map(scope =>
						scopeError(scope) ? <ErrorBanner key={scope}>{scopeError(scope)}</ErrorBanner> : null,
					)}
					{notice && <p role="status">{notice}</p>}
					{dialog === "session-actions" && (
						<nav className="command-list" aria-label={t("shell.conversationActions")}>
							<Button onClick={openPreferences}>
								<SlidersHorizontal aria-hidden="true" />
								{t("shell.dialogPreferences")}
							</Button>
							<Button onClick={() => setDialog("operator")}>
								<Command aria-hidden="true" />
								{t("shell.dialogOperator")}
							</Button>
							<Button disabled={!connected || session?.controlGeneration === null} onClick={() => openBtw()}>
								<Command aria-hidden="true" />
								{t("shell.sideChatCommand")}
							</Button>
							<Button onClick={openMcp}>
								<Network aria-hidden="true" />
								{t("shell.dialogMcp")}
							</Button>
							<Button onClick={openSessionInfo}>
								<Info aria-hidden="true" />
								{t("shell.dialogSessionInfo")}
							</Button>
							<Button onClick={openFork}>{t("shell.dialogFork")}</Button>
							<Button onClick={openHistory}>
								<History aria-hidden="true" />
								{t("shell.fullHistory")}
							</Button>
							<Button
								onClick={() => {
									setEditText(session?.title ?? "");
									setDialog("rename");
								}}
							>
								<Pencil aria-hidden="true" />
								{t("shell.rename")}
							</Button>
							<Button className="danger" onClick={() => setDialog("delete")}>
								<Trash2 aria-hidden="true" />
								{t("shell.dialogDelete")}
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
							preferences={
								preferences?.sessionId === dialogOwner && preferences.owner === modelOwner
									? preferences.value
									: null
							}
							pending={pending[preferencesScope] || pending[`selection:${modelOwner}`]}
							error={errors[preferencesScope] || errors[`selection:${modelOwner}`]}
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
										{activityDetail.output.truncated ? `\n${t("shell.outputOmitted")}` : ""}
									</pre>
								) : (
									<p className="muted">{t("shell.noActivityOutput")}</p>
								)}
							</>
						) : (
							<p role="status">{t("shell.activityLoading")}</p>
						))}
					{dialog === "settings" && (
						<div className="settings-dialog">
							<SettingsTabs
								prefix={settingsPanelPrefix}
								active={settingsTab}
								onSelect={tab => {
									setSettingsTab(tab);
									if (settingsPanelsRef.current) settingsPanelsRef.current.scrollTop = 0;
								}}
							/>
							{/* Every panel stays mounted and only the active one is visible, so each tab's
							    aria-controls always resolves and panel-local state survives a switch. */}
							<div className="settings-panels" ref={settingsPanelsRef}>
								<div
									className="settings-panel"
									id={settingsPanelId(settingsPanelPrefix, "general")}
									role="tabpanel"
									aria-labelledby={settingsTabId(settingsPanelPrefix, "general")}
									hidden={settingsTab !== "general"}
								>
									<SettingsSection
										id={`${settingsPanelPrefix}-theme`}
										title={t("shell.theme")}
										hint={t("shell.themeHint")}
									>
										<div
											className="theme-options"
											role="radiogroup"
											aria-label={t("shell.theme")}
											onKeyDown={event => {
												const radios = [
													...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
												];
												const index = THEME_IDS.indexOf(theme);
												const next =
													event.key === "Home"
														? 0
														: event.key === "End"
															? radios.length - 1
															: event.key === "ArrowRight" || event.key === "ArrowDown"
																? (index + 1) % radios.length
																: event.key === "ArrowLeft" || event.key === "ArrowUp"
																	? (index - 1 + radios.length) % radios.length
																	: -1;
												const target = radios[next];
												if (!target) return;
												event.preventDefault();
												target.focus();
												target.click();
											}}
										>
											{THEME_IDS.map(id => (
												<Button
													key={id}
													className="theme-option"
													role="radio"
													aria-checked={theme === id}
													tabIndex={theme === id ? 0 : -1}
													onClick={() => {
														setTheme(id);
														if (!writeThemePreference(id)) setNotice(t("shell.themeSaveFailed"));
													}}
												>
													<span
														className="theme-swatch"
														aria-hidden="true"
														style={{
															background: `linear-gradient(135deg, ${DESKTOP_THEMES[id].accent} 0 55%, ${DESKTOP_THEMES[id].surface} 55% 100%)`,
														}}
													/>
													{themeLabel(id)}
												</Button>
											))}
										</div>
									</SettingsSection>
									<SettingsSection id={`${settingsPanelPrefix}-font-size`} title={t("shell.fontSize")}>
										<div className="font-size-control" role="group" aria-label={t("shell.fontSize")}>
											<Button
												aria-label={t("shell.fontSizeSmaller")}
												disabled={fontSize <= MIN_FONT_SIZE}
												onClick={() => {
													const next = clampFontSize(fontSize - 1);
													setFontSize(next);
													setFontSizeDraft(String(next));
													if (!writeFontSizePreference(next)) setNotice(t("shell.fontSizeSaveFailed"));
												}}
											>
												−
											</Button>
											<input
												type="number"
												inputMode="numeric"
												className="font-size-input"
												min={MIN_FONT_SIZE}
												max={MAX_FONT_SIZE}
												step={1}
												value={fontSizeDraft}
												aria-label={t("shell.fontSizePixels")}
												onChange={event => {
													// Typing is free-form: a half-typed number stays in the field and only an
													// in-range value is applied, so "18" is never read as "1".
													const typed = event.target.value;
													setFontSizeDraft(typed);
													const parsed = Number(typed);
													if (typed.trim() && parsed >= MIN_FONT_SIZE && parsed <= MAX_FONT_SIZE)
														setFontSize(parsed);
												}}
												onBlur={() => {
													const settled = clampFontSize(Number(fontSizeDraft));
													setFontSize(settled);
													setFontSizeDraft(String(settled));
													if (!writeFontSizePreference(settled)) setNotice(t("shell.fontSizeSaveFailed"));
												}}
											/>
											<Button
												aria-label={t("shell.fontSizeLarger")}
												disabled={fontSize >= MAX_FONT_SIZE}
												onClick={() => {
													const next = clampFontSize(fontSize + 1);
													setFontSize(next);
													setFontSizeDraft(String(next));
													if (!writeFontSizePreference(next)) setNotice(t("shell.fontSizeSaveFailed"));
												}}
											>
												+
											</Button>
											<span className="font-size-unit">{t("shell.fontSizeUnit")}</span>
										</div>
									</SettingsSection>
								</div>
								<div
									className="settings-panel"
									id={settingsPanelId(settingsPanelPrefix, "account")}
									role="tabpanel"
									aria-labelledby={settingsTabId(settingsPanelPrefix, "account")}
									hidden={settingsTab !== "account"}
								>
									<p className="settings-panel-hint">{t("shell.accountHint")}</p>
									{/* OAuthSettings renders its own heading and section frame. */}
									<OAuthSettings key={dialogGeneration.current} connected={connected} />
									<SettingsSection
										id={`${settingsPanelPrefix}-key`}
										title={t("shell.apiKey")}
										hint={t("shell.apiKeyHint")}
									>
										<form
											className="settings-form"
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
																? t("shell.apiKeySaved")
																: t("shell.apiKeySavedNoRefresh"),
														);
												});
											}}
										>
											<label htmlFor="provider">{t("shell.provider")}</label>
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
											<label htmlFor="api-key">{t("shell.apiKeyHidden")}</label>
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
												{t("shell.saveKey")}
											</Button>
										</form>
									</SettingsSection>
								</div>
								<div
									className="settings-panel"
									id={settingsPanelId(settingsPanelPrefix, "settings")}
									role="tabpanel"
									aria-labelledby={settingsTabId(settingsPanelPrefix, "settings")}
									hidden={settingsTab !== "settings"}
								>
									<SettingsSection
										id={`${settingsPanelPrefix}-runtime`}
										title={t("shell.safeSettings")}
										hint={t("shell.settingsHint")}
									>
										{settings === null ? (
											<p>{t("shell.loadingSettings")}</p>
										) : settings.length === 0 ? (
											<p>{t("shell.noExposedSettings")}</p>
										) : (
											<>
												<label htmlFor="setting-search">{t("shell.searchSettings")}</label>
												<input
													id="setting-search"
													value={settingFilter}
													placeholder={t("shell.searchSettingsPlaceholder")}
													onChange={event => setSettingFilter(event.target.value)}
												/>
												<p className="muted">
													{t("shell.settingsMatchCount", {
														count: filteredSettings.length,
														total: settings.length,
													})}
													{filteredSettings.length > 200 && t("shell.settingsLimitNotice")}
												</p>
												{filteredSettings.length === 0 && <p>{t("shell.noMatchingSettings")}</p>}
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
									</SettingsSection>
								</div>
								<div
									className="settings-panel"
									id={settingsPanelId(settingsPanelPrefix, "capabilities")}
									role="tabpanel"
									aria-labelledby={settingsTabId(settingsPanelPrefix, "capabilities")}
									hidden={settingsTab !== "capabilities"}
								>
									<SettingsSection
										id={`${settingsPanelPrefix}-capabilities`}
										title={t("shell.capabilityStatus")}
										hint={t("shell.capabilitiesHint")}
									>
										{!snapshot ? (
											<p role="status">{t("shell.capabilitiesLoading")}</p>
										) : snapshot.capabilities.length === 0 ? (
											<p>{t("shell.capabilitiesEmpty")}</p>
										) : (
											snapshot.capabilities.map(capability => (
												<div className="capability" key={capability.id}>
													<strong>{capability.label}</strong>
													<span>
														{capability.available ? t("shell.supported") : t("shell.unavailable")}
													</span>
													{capability.reason && <small>{capability.reason}</small>}
												</div>
											))
										)}
									</SettingsSection>
								</div>
							</div>
						</div>
					)}
					{dialog === "commands" && (
						<>
							<label htmlFor="command-search">{t("shell.searchCommands")}</label>
							<input id="command-search" value={filter} onChange={event => setFilter(event.target.value)} />
							<form
								className="command-run"
								onSubmit={event => {
									event.preventDefault();
									runCommand(commandInput);
								}}
							>
								<label htmlFor="command-input">{t("shell.runCommand")}</label>
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
									{t("shell.run")}
								</Button>
							</form>
							{scopeError(`command:${dialogOwner}`) && (
								<ErrorBanner>{scopeError(`command:${dialogOwner}`)}</ErrorBanner>
							)}
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
															(!!pending[selected] ||
																session.status === "running" ||
																session.status === "waiting"))))
											}
											onClick={command.action}
										>
											{command.label}
										</Button>
									))}
							</div>
							<h3>
								{t("shell.slashCommands")} {commandList.length > 0 && `(${commandList.length})`}
							</h3>
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
										<strong>
											{capability.label} · {t("shell.unavailable")}
										</strong>
										<small>{capability.reason || t("shell.sdkSupportPending")}</small>
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
							<p>{t("shell.loadingFullHistory")}</p>
						))}
					{dialog === "history" && history !== null && (
						<>
							<p className="muted">
								{t("shell.historyShown", { shown: history.messages.length, total: history.total })}
							</p>
							<div className="history-list">
								{history.messages.map(message => (
									<Message key={message.id} message={message} />
								))}
							</div>
							{history.truncated && (
								<Button disabled={pending[`history:${dialogOwner}`]} onClick={loadMoreHistory}>
									{t("shell.loadMoreHistory")}
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
							<label htmlFor="session-title">{t("shell.conversationName")}</label>
							<input id="session-title" value={editText} onChange={event => setEditText(event.target.value)} />
							<Button type="submit" disabled={!connected || pending[selected] || !editText.trim()}>
								{t("support.save")}
							</Button>
						</form>
					)}
					{dialog === "delete" && (
						<>
							<p>{t("shell.deleteConversationConfirm", { title: session?.title ?? "" })}</p>
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
								{t("shell.dialogDelete")}
							</Button>
						</>
					)}
					{dialog === "tools" && (
						<>
							{pending[toolsScope] ? (
								<p>{t("shell.loadingTools")}</p>
							) : toolNames.length === 0 ? (
								<p>{t("shell.noTools")}</p>
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
								{t("shell.saveTools")}
							</Button>
						</>
					)}
					{dialog === "goal" && (
						<>
							<label htmlFor="objective">{t("shell.objective")}</label>
							<textarea
								id="objective"
								rows={4}
								value={editText}
								onChange={event => setEditText(event.target.value)}
							/>
							<div className="actions">
								{(
									[
										["create", t("shell.goalCreate")],
										["get", t("shell.goalGet")],
										["resume", t("shell.goalResume")],
										["pause", t("shell.goalPause")],
										["complete", t("shell.goalComplete")],
										["drop", t("shell.goalDrop")],
									] as const
								)
									// The dialog mirrors the strip: only the operations the current goal state
									// allows, and none while a turn owns the session.
									.filter(([op]) => goalOperationAllowed(op, session))
									.map(([op, label]) => (
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
