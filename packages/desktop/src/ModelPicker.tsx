import { ChevronDown, Cpu, RefreshCw, Search, Star } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useEffect, useId, useRef, useState } from "react";
import type {
	DesktopModelProfile,
	DesktopModelRoleId,
	DesktopModelRolePreference,
} from "../../desktop-host/src/preferences-protocol";
import type { DesktopModel } from "../../desktop-host/src/protocol";
import { Button, Modal } from "./components";

export type PickerModelRole = "default" | "executor" | "planner" | "critic" | "architect";
type PickerTab = "presets" | "models";
const TAB_ORDER: PickerTab[] = ["presets", "models"];
const ROLE_ORDER: PickerModelRole[] = ["default", "executor", "planner", "critic", "architect"];
const ROLE_LABELS: Record<PickerModelRole, string> = {
	default: "Default",
	executor: "Executor",
	planner: "Planner",
	critic: "Critic",
	architect: "Architect",
};
const PROFILE_ROLE_LABELS: Record<DesktopModelRoleId, string> = { ...ROLE_LABELS, image: "Image" };
const FAVORITES_KEY = "gjc.desktop.model-favorites";

function searchTerms(query: string): string[] {
	return query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
}

function matchesTerms(text: string, terms: string[]): boolean {
	return terms.every(term => text.includes(term));
}

export function filterDesktopModels(models: DesktopModel[], query: string): DesktopModel[] {
	const terms = searchTerms(query);
	return models.filter(model => matchesTerms(`${model.provider} ${model.name} ${model.id}`.toLowerCase(), terms));
}

function filterProfiles(profiles: DesktopModelProfile[], query: string): DesktopModelProfile[] {
	const terms = searchTerms(query);
	return profiles.filter(profile =>
		matchesTerms(
			[profile.id, profile.name, ...profile.roles.map(role => role.model ?? "")].join(" ").toLowerCase(),
			terms,
		),
	);
}

function profileRoleEntries(profile: DesktopModelProfile): { id: DesktopModelRoleId; label: string; model: string }[] {
	return profile.roles.flatMap(role =>
		role.model ? [{ id: role.id, label: PROFILE_ROLE_LABELS[role.id], model: role.model }] : [],
	);
}

function readFavorites(): { ids: string[]; error: boolean } {
	try {
		const raw = localStorage.getItem(FAVORITES_KEY);
		if (raw === null) return { ids: [], error: false };
		const value: unknown = JSON.parse(raw);
		if (!Array.isArray(value)) return { ids: [], error: true };
		const ids = value.filter((id): id is string => typeof id === "string" && /^[^/\s]+\/\S+$/u.test(id));
		return { ids: [...new Set(ids)], error: ids.length !== value.length };
	} catch {
		return { ids: [], error: true };
	}
}

function focusFirstHit(list: HTMLUListElement | null) {
	list?.querySelector<HTMLButtonElement>(".model-option-hit:not(:disabled)")?.focus();
}

function navigateList(event: KeyboardEvent<HTMLUListElement>) {
	if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
	const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".model-option-hit:not(:disabled)")];
	const active = document.activeElement;
	const index = active instanceof HTMLButtonElement ? buttons.indexOf(active) : -1;
	if (index < 0) return;
	event.preventDefault();
	const next =
		event.key === "Home"
			? 0
			: event.key === "End"
				? buttons.length - 1
				: Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
	buttons[next]?.focus();
}

export interface ModelPickerProps {
	models: DesktopModel[];
	selectedId?: string;
	disabled?: boolean;
	pending?: boolean;
	/** A model or reasoning request is already applying; dispatch would be refused. */
	applying?: boolean;
	onSelect: (modelId: string) => void;
	onConfigureProviders?: () => void;
	roles?: DesktopModelRolePreference[];
	profiles?: DesktopModelProfile[];
	onAssign?: (role: PickerModelRole, modelId: string | null) => void;
	onApplyProfile?: (profileId: string) => void;
	onRefresh?: () => void;
	refreshing?: boolean;
	/** Profile and role preferences need a settled session; model and reasoning picks are deferred instead. */
	busy?: boolean;
}

export function ModelPicker({
	models,
	selectedId,
	disabled,
	pending,
	applying = false,
	onSelect,
	onConfigureProviders,
	roles,
	profiles,
	onAssign,
	onApplyProfile,
	onRefresh,
	refreshing,
	busy = false,
}: ModelPickerProps) {
	const tabId = useId();
	const busyReasonId = useId();
	const [open, setOpen] = useState(false);
	const [tab, setTab] = useState<PickerTab>("models");
	const [modelQuery, setModelQuery] = useState("");
	const [presetQuery, setPresetQuery] = useState("");
	const [choice, setChoice] = useState<string | null>(null);
	const [favorites, setFavorites] = useState(readFavorites);
	const modelInput = useRef<HTMLInputElement>(null);
	const presetInput = useRef<HTMLInputElement>(null);
	const tabs = useRef<HTMLDivElement>(null);
	const results = useRef<HTMLUListElement>(null);
	const presetResults = useRef<HTMLUListElement>(null);
	const back = useRef<HTMLButtonElement>(null);
	const restoreId = useRef<string | null>(null);
	const focusSearch = useRef(false);
	const profileList = profiles ?? [];
	const current = models.find(model => model.id === selectedId);
	const roleFor = (id: PickerModelRole): DesktopModelRolePreference | undefined => roles?.find(role => role.id === id);
	const matches = (role: PickerModelRole, modelId: string): boolean => {
		if (role === "default") return selectedId === modelId;
		const model = roleFor(role)?.model;
		return !!model && `${model.provider}/${model.id}` === modelId;
	};
	const rank = (id: string) => {
		const index = ROLE_ORDER.findIndex(role => matches(role, id));
		return index < 0 ? ROLE_ORDER.length : index;
	};
	const filtered = filterDesktopModels(models, modelQuery)
		.map((model, index) => ({ model, index }))
		.sort(
			(a, b) =>
				rank(a.model.id) - rank(b.model.id) ||
				Number(favorites.ids.includes(b.model.id)) - Number(favorites.ids.includes(a.model.id)) ||
				a.index - b.index,
		)
		.map(item => item.model);
	const filteredProfiles = filterProfiles(profileList, presetQuery);

	useEffect(() => {
		if (!open) return;
		if (choice) {
			back.current?.focus();
			return;
		}
		if (restoreId.current) {
			const id = restoreId.current;
			const button = [...(results.current?.querySelectorAll<HTMLButtonElement>(".model-option-hit") ?? [])].find(
				item => item.dataset.modelId === id,
			);
			if (button) {
				restoreId.current = null;
				button.focus();
				return;
			}
		}
		if (!focusSearch.current) return;
		focusSearch.current = false;
		(tab === "presets" ? presetInput : modelInput).current?.focus();
	}, [open, choice, tab]);
	useEffect(() => {
		setOpen(false);
		setChoice(null);
		restoreId.current = null;
		focusSearch.current = false;
	}, [selectedId]);
	useEffect(() => {
		if (choice && !models.some(model => model.id === choice)) {
			focusSearch.current = true;
			setChoice(null);
		}
	}, [models, choice]);

	function toggleFavorite(id: string) {
		const next = favorites.ids.includes(id) ? favorites.ids.filter(item => item !== id) : [...favorites.ids, id];
		try {
			localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
			setFavorites({ ids: next, error: false });
		} catch {
			setFavorites({ ids: next, error: true });
		}
	}
	function closeDialog() {
		setOpen(false);
		setChoice(null);
		restoreId.current = null;
		focusSearch.current = false;
	}
	function openDialog() {
		setModelQuery("");
		setPresetQuery("");
		setChoice(null);
		restoreId.current = null;
		focusSearch.current = true;
		setTab(selectedId ? "models" : profileList.length > 0 ? "presets" : "models");
		setOpen(true);
	}
	function showTab(next: PickerTab) {
		focusSearch.current = false;
		if (next === "presets" && choice) {
			restoreId.current = choice;
			setChoice(null);
		}
		setTab(next);
	}
	function handleTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		event.preventDefault();
		const index = TAB_ORDER.indexOf(tab);
		const next = TAB_ORDER[(index + (event.key === "ArrowRight" ? 1 : -1) + TAB_ORDER.length) % TAB_ORDER.length];
		const buttons = [...(tabs.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])];
		showTab(next);
		buttons[TAB_ORDER.indexOf(next)]?.focus();
	}
	function returnToList() {
		restoreId.current = choice;
		focusSearch.current = false;
		setChoice(null);
	}

	return (
		<>
			<Button
				className="model-trigger"
				aria-label={`모델 선택: ${current?.name ?? selectedId ?? "선택되지 않음"}`}
				aria-haspopup="dialog"
				aria-expanded={open}
				disabled={disabled || pending || applying}
				title={current?.id ?? selectedId ?? "사용 가능한 모델 선택"}
				onClick={openDialog}
			>
				<Cpu size={15} aria-hidden="true" />
				<span>{pending ? "모델 적용 중…" : (current?.name ?? selectedId ?? "모델 선택")}</span>
				<ChevronDown size={13} aria-hidden="true" />
			</Button>
			{open && (
				<Modal title="모델 선택" className="model-dialog" onClose={closeDialog}>
					<div
						className="model-tabs"
						role="tablist"
						aria-label="모델 선택 탭"
						ref={tabs}
						onKeyDown={handleTabKeyDown}
					>
						<Button
							role="tab"
							id={`${tabId}-presets-tab`}
							className="model-tab"
							aria-selected={tab === "presets"}
							aria-controls={tab === "presets" ? `${tabId}-presets-panel` : undefined}
							tabIndex={tab === "presets" ? 0 : -1}
							onClick={() => showTab("presets")}
						>
							프리셋
						</Button>
						<Button
							role="tab"
							id={`${tabId}-models-tab`}
							className="model-tab"
							aria-selected={tab === "models"}
							aria-controls={tab === "models" ? `${tabId}-models-panel` : undefined}
							tabIndex={tab === "models" ? 0 : -1}
							onClick={() => showTab("models")}
						>
							모델
						</Button>
					</div>
					{busy && (
						<p className="model-busy-reason muted" id={busyReasonId}>
							작업이 끝난 뒤 프로필을 변경할 수 있습니다.
						</p>
					)}
					{applying && (
						<p className="model-busy-reason muted" role="status">
							선택한 설정을 적용하는 중…
						</p>
					)}
					{tab === "presets" ? (
						<div role="tabpanel" id={`${tabId}-presets-panel`} aria-labelledby={`${tabId}-presets-tab`}>
							<div className="model-toolbar">
								<label className="model-search">
									<span className="sr-only">프리셋 검색</span>
									<Search size={16} aria-hidden="true" />
									<input
										ref={presetInput}
										value={presetQuery}
										placeholder="프리셋 이름 검색"
										onChange={event => setPresetQuery(event.target.value)}
										onKeyDown={event => {
											if (event.key !== "ArrowDown") return;
											event.preventDefault();
											focusFirstHit(presetResults.current);
										}}
									/>
								</label>
							</div>
							<p className="muted" role="status">
								{filteredProfiles.length}개 프리셋
							</p>
							{profileList.length === 0 ? (
								<div className="empty model-empty">사용 가능한 프리셋이 없습니다.</div>
							) : filteredProfiles.length === 0 ? (
								<div className="empty model-empty">
									일치하는 프리셋이 없습니다. 다른 이름이나 모델을 검색하세요.
								</div>
							) : (
								<ul
									ref={presetResults}
									className="model-result-list"
									aria-label="프리셋 검색 결과"
									onKeyDown={navigateList}
								>
									{filteredProfiles.map(profile => {
										const entries = profileRoleEntries(profile);
										return (
											<li className="model-result-row" key={profile.id}>
												<div className="model-option" aria-current={profile.active ? "true" : undefined}>
													<Button
														className="model-option-hit"
														aria-label={`${profile.name} 프로필을 이 대화에 적용`}
														aria-describedby={busy ? busyReasonId : undefined}
														disabled={!onApplyProfile || busy || applying}
														onClick={() => {
															if (!onApplyProfile || busy) return;
															onApplyProfile(profile.id);
															closeDialog();
														}}
													>
														<span className="model-option-main">
															<strong>{profile.name}</strong>
															<small>
																{profile.source === "builtin" ? "내장" : "설정"}
																{profile.active ? " · 현재 적용" : ""}
																{profile.default ? " · 기본 프로필" : ""}
															</small>
															{entries.length > 0 && (
																<span className="preset-roles">
																	{entries.map(entry => (
																		<span key={entry.id}>
																			{entry.label} {entry.model}
																		</span>
																	))}
																</span>
															)}
														</span>
													</Button>
												</div>
											</li>
										);
									})}
								</ul>
							)}
						</div>
					) : (
						<div role="tabpanel" id={`${tabId}-models-panel`} aria-labelledby={`${tabId}-models-tab`}>
							{choice ? (
								<div className="model-role-choice">
									<button type="button" ref={back} className="button model-role-back" onClick={returnToList}>
										뒤로
									</button>
									<p>역할 선택: {models.find(model => model.id === choice)?.name ?? choice}</p>
									<p className="muted">Default: 공통 설정 · 나머지 역할: 현재 대화</p>
									<div className="model-role-list">
										{ROLE_ORDER.map(role => {
											const preference = roleFor(role);
											const fixtureDefault = role === "default" && !onAssign && !roles;
											const available = fixtureDefault || (!!onAssign && !!preference?.canApply.available);
											const reason = preference?.canApply.reason ?? "이 역할은 사용할 수 없습니다.";
											const assigned = matches(role, choice);
											// Default selects this conversation's model, which the renderer defers; only role
											// preference writes need a settled session.
											const preferenceBlocked = busy && role !== "default";
											const canClear =
												role !== "default" &&
												assigned &&
												preference?.configured &&
												!!onAssign &&
												!!preference.canClear.available;
											return (
												<div className="model-role-row" key={role}>
													<Button
														className="model-role-option"
														aria-describedby={preferenceBlocked ? busyReasonId : undefined}
														disabled={!available || preferenceBlocked || applying}
														onClick={() => {
															if (onAssign) onAssign(role, choice);
															else if (fixtureDefault) onSelect(choice);
															closeDialog();
														}}
													>
														{ROLE_LABELS[role]}
														{assigned ? " · 현재 적용" : ""}
													</Button>
													{!available && <small className="model-role-reason">{reason}</small>}
													{role !== "default" && assigned && preference?.configured && (
														<Button
															className="model-role-clear"
															aria-describedby={busy ? busyReasonId : undefined}
															disabled={!canClear || busy || applying}
															title={
																preference.canClear.reason ??
																(!canClear ? "이 역할의 재정의를 해제할 수 없습니다." : undefined)
															}
															onClick={() => {
																if (canClear && !busy) {
																	onAssign?.(role, null);
																	closeDialog();
																}
															}}
														>
															재정의 해제
														</Button>
													)}
												</div>
											);
										})}
									</div>
									<Button className="model-role-cancel" onClick={closeDialog}>
										취소
									</Button>
								</div>
							) : (
								<>
									{ROLE_ORDER.filter(role => {
										const preference = roleFor(role);
										const selected = preference?.model;
										return (
											role !== "default" &&
											preference?.canClear.available &&
											(!selected ||
												!models.some(model => model.id === `${selected.provider}/${selected.id}`))
										);
									}).map(role => (
										<div className="model-role-row" key={role}>
											<span>
												{ROLE_LABELS[role]} · {roleFor(role)?.model?.name ?? "사용할 수 없는 모델"}
											</span>
											<Button
												className="model-role-unavailable-clear"
												aria-describedby={busy ? busyReasonId : undefined}
												disabled={!onAssign || busy || applying}
												onClick={() => {
													if (busy) return;
													onAssign?.(role, null);
													setOpen(false);
												}}
											>
												재정의 해제
											</Button>
										</div>
									))}
									<div className="model-toolbar">
										<label className="model-search">
											<span className="sr-only">모델 또는 제공자 검색</span>
											<Search size={16} aria-hidden="true" />
											<input
												ref={modelInput}
												value={modelQuery}
												placeholder="모델 이름, 제공자 또는 ID 검색"
												onChange={event => setModelQuery(event.target.value)}
												onKeyDown={event => {
													if (event.key !== "ArrowDown") return;
													event.preventDefault();
													focusFirstHit(results.current);
												}}
											/>
										</label>
										<Button
											className="model-refresh"
											aria-label="모델 목록 새로고침"
											title="모델 목록 새로고침"
											disabled={!onRefresh || !!refreshing}
											onClick={() => onRefresh?.()}
										>
											<RefreshCw aria-hidden="true" />
										</Button>
									</div>
									<p className="muted" role="status">
										{filtered.length}개 모델
									</p>
									{favorites.error && (
										<p className="model-favorites-error" role="alert">
											즐겨찾기를 저장하거나 불러오지 못했습니다. 모델 선택은 계속할 수 있습니다.
										</p>
									)}
									{filtered.length === 0 ? (
										<div className="empty model-empty">
											{models.length === 0
												? refreshing
													? "모델 목록을 불러오는 중…"
													: "사용 가능한 모델이 없습니다. 설정에서 제공자를 추가하거나 계정을 연결하세요."
												: "일치하는 모델이 없습니다. 다른 이름이나 제공자를 검색하세요."}
										</div>
									) : (
										<ul
											ref={results}
											className="model-result-list"
											aria-label="모델 검색 결과"
											onKeyDown={navigateList}
										>
											{filtered.map(model => {
												const selected = selectedId === model.id;
												return (
													<li className="model-result-row" key={model.id}>
														<div className="model-option" aria-current={selected ? "true" : undefined}>
															<Button
																className="model-option-hit"
																data-model-id={model.id}
																onClick={() => setChoice(model.id)}
															>
																<span className="model-option-main">
																	<strong>{model.name}</strong>
																	<small>
																		{model.provider} · {model.id}
																	</small>
																	<span className="model-role-tags">
																		{ROLE_ORDER.filter(role => matches(role, model.id)).map(role => (
																			<span className="model-role-tag" key={role}>
																				{ROLE_LABELS[role]}
																			</span>
																		))}
																	</span>
																</span>
																{selected && <span className="sr-only">현재 선택됨</span>}
															</Button>
															<Button
																className="model-favorite"
																aria-label={`${model.name} 즐겨찾기`}
																aria-pressed={favorites.ids.includes(model.id)}
																onClick={() => toggleFavorite(model.id)}
															>
																<Star
																	size={16}
																	aria-hidden="true"
																	fill={favorites.ids.includes(model.id) ? "currentColor" : "none"}
																/>
															</Button>
														</div>
													</li>
												);
											})}
										</ul>
									)}
									{onConfigureProviders && (
										<div className="model-provider-actions">
											<Button
												onClick={() => {
													closeDialog();
													onConfigureProviders();
												}}
											>
												제공자 추가·연결
											</Button>
										</div>
									)}
								</>
							)}
						</div>
					)}
				</Modal>
			)}
		</>
	);
}
