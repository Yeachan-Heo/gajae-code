import { useCallback, useEffect, useRef, useState } from "react";
import type {
	DesktopCommand,
	DesktopCommandResult,
	DesktopDiff,
	DesktopFrame,
	DesktopHistory,
	DesktopMethod,
	DesktopSession,
	DesktopSetting,
	DesktopSnapshot,
} from "../../desktop-host/src/protocol";
import { request, selectProject, subscribe } from "./bridge";
import { Button, Composer, ErrorBanner, Message, Modal, QuestionCard, SessionRow, SettingField } from "./components";
import { OAuthSettings } from "./OAuthSettings";
import "./styles.css";

type Dialog = "settings" | "commands" | "history" | "rename" | "delete" | "tools" | "goal" | "result" | null;
const textOf = (value: unknown) =>
	typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "결과 없음");

export default function App() {
	const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null);
	const [selected, setSelected] = useState("");
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
	const [deliverAs, setDeliverAs] = useState<"steer" | "followUp">("steer");
	const commandInputRef = useRef<HTMLInputElement>(null);
	const conversation = useRef<HTMLDivElement>(null);
	const follow = useRef(true);
	const session = snapshot?.sessions.find(item => item.id === selected);
	const project = snapshot?.projects.find(item => item.id === session?.projectId);
	const connected = snapshot !== null && !fatal;
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
			}
			if (event.type === "snapshot") setSnapshot(event.snapshot);
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
	}, []);
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
					? "API 키를 저장하지 못했습니다. 제공자와 키를 확인한 뒤 다시 입력하세요."
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
		setSettingFilter("");
		void run(`settings:${sessionId}:${generation}`, async () => {
			const value = await request<DesktopSetting[]>("settings.get", sessionId ? { sessionId } : {});
			if (dialogGeneration.current === generation) setSettings(value);
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
	const send = () => {
		if (!session || !connected) return;
		const sessionId = session.id;
		const text = drafts[sessionId] || "";
		if (!text.trim()) return;
		const queued = session.status === "running" || session.status === "waiting";
		void run(sessionId, async () => {
			const result = await request<{ queued?: boolean }>("prompt", {
				sessionId,
				text,
				...(queued ? { deliverAs } : {}),
			});
			setDrafts(previous => (previous[sessionId] === text ? { ...previous, [sessionId]: "" } : previous));
			if (result?.queued) setNotice("실행 중인 작업에 대기열로 추가했습니다.");
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
	const openHistory = () => {
		const sessionId = selected;
		const generation = setDialog("history");
		setHistory(null);
		void run(`history:${sessionId}`, async () => {
			const value = await request<DesktopHistory>("history.get", { sessionId, offset: 0, limit: 500 });
			if (dialogGeneration.current === generation) setHistory(value);
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
	const commands: { label: string; action: () => void; needsSession?: boolean }[] = [
		{
			label: "프로젝트 열기",
			action: () => {
				closeDialog();
				void openProject();
			},
		},
		{ label: "설정 및 기능 지원 현황", action: openSettings },
		{
			label: "대화 분기 (fork)",
			needsSession: true,
			action: () => {
				closeDialog();
				void call("session.fork", { sessionId: selected });
			},
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
					const value = await request<unknown>("session.export", { sessionId: selected });
					setResult(textOf(value));
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
				<strong>Gajae Code</strong>
			</header>
			<Button disabled={!connected || pending.global} onClick={() => void openProject()}>
				프로젝트 열기 / 추가
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
								＋
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
					설정
				</Button>
				<Button onClick={() => setDialog("commands")}>명령 ⌘K</Button>
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
							<Button
								disabled={!connected}
								onClick={() => {
									setEditText(session.title);
									setDialog("rename");
								}}
							>
								이름 변경
							</Button>
							<Button disabled={!connected} onClick={() => setDialog("delete")}>
								삭제
							</Button>
							<Button aria-pressed={review} disabled={!connected} onClick={() => setReview(!review)}>
								변경 검토
							</Button>
							<Button disabled={!connected} onClick={openHistory}>
								전체 기록
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
								<p className="muted">최근 기록만 표시합니다. 위의 ‘전체 기록’에서 모두 확인할 수 있습니다.</p>
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
							].map(scope => errors[scope] && <ErrorBanner key={scope}>{errors[scope]}</ErrorBanner>)}
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
			{dialog && (
				<Modal
					title={
						{
							settings: "설정",
							commands: "명령",
							history: "전체 기록",
							rename: "대화 이름 변경",
							delete: "대화 삭제",
							tools: "활성 도구",
							goal: "목표 관리",
							result: "요청 결과",
						}[dialog]
					}
					onClose={closeDialog}
				>
					{[settingsScope, authScope, toolsScope, "goal", selected].map(
						scope => errors[scope] && <ErrorBanner key={scope}>{errors[scope]}</ErrorBanner>,
					)}
					{notice && <p role="status">{notice}</p>}
					{dialog === "settings" && (
						<>
							<section>
								<h3>현재 대화 모델</h3>
								<label htmlFor="model">모델</label>
								<select
									id="model"
									value={session?.model || ""}
									disabled={!session || !connected || pending[selected]}
									onChange={event =>
										void call("model.set", { sessionId: dialogOwner, modelId: event.target.value })
									}
								>
									<option value="" disabled>
										{session ? "모델 선택" : "대화를 먼저 선택하세요"}
									</option>
									{snapshot?.models.map(model => (
										<option key={model.id} value={model.id}>
											{model.provider} · {model.name}
										</option>
									))}
								</select>
							</section>
							<OAuthSettings key={dialogGeneration.current} connected={connected} />
							<form
								onSubmit={event => {
									event.preventDefault();
									const secret = key;
									const generation = dialogGeneration.current;
									setKey("");
									void run(`auth:${dialogOwner}:${generation}`, async () => {
										await request("auth.setKey", { provider, key: secret });
										if (dialogGeneration.current === generation) setNotice("API 키를 저장했습니다.");
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
									{[...new Set(snapshot?.models.map(model => model.provider))].map(name => (
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
													(!session || !!pending[selected] || session.status === "running"))
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
									.filter(command =>
										`${command.name} ${command.description}`.toLowerCase().includes(filter.toLowerCase()),
									)
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
					{dialog === "history" &&
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
		</div>
	);
}
