import { ChevronDown, ChevronRight, Cpu, RefreshCw, Search, Star } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useEffect, useId, useRef, useState } from "react";
import type {
	DesktopModelProfile,
	DesktopModelRoleId,
	DesktopModelRolePreference,
} from "../../desktop-host/src/preferences-protocol";
import type { DesktopModel } from "../../desktop-host/src/protocol";
import { Button, Modal } from "./components";
import { t } from "./i18n";

export type PickerModelRole = "default" | "executor" | "planner" | "critic" | "architect";
type PickerTab = "presets" | "models";
const TAB_ORDER: PickerTab[] = ["presets", "models"];
const ROLE_ORDER: PickerModelRole[] = ["default", "executor", "planner", "critic", "architect"];
const ROLE_LABELS: Record<PickerModelRole, () => string> = {
	default: () => t("models.roleDefault"),
	executor: () => t("models.roleExecutor"),
	planner: () => t("models.rolePlanner"),
	critic: () => t("models.roleCritic"),
	architect: () => t("models.roleArchitect"),
};
const PROFILE_ROLE_LABELS: Record<DesktopModelRoleId, () => string> = {
	...ROLE_LABELS,
	image: () => t("models.roleImage"),
};
const FAVORITES_KEY = "gjc.desktop.model-favorites";
const PRESET_FAVORITES_KEY = "gjc.desktop.preset-favorites";

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
		role.model ? [{ id: role.id, label: PROFILE_ROLE_LABELS[role.id](), model: role.model }] : [],
	);
}

function readFavorites(key: string, pattern: RegExp): { ids: string[]; error: boolean } {
	try {
		const raw = localStorage.getItem(key);
		if (raw === null) return { ids: [], error: false };
		const value: unknown = JSON.parse(raw);
		if (!Array.isArray(value)) return { ids: [], error: true };
		const ids = value.filter((id): id is string => typeof id === "string" && pattern.test(id));
		return { ids: [...new Set(ids)], error: ids.length !== value.length };
	} catch {
		return { ids: [], error: true };
	}
}

const MODEL_FAVORITE = /^[^/\s]+\/\S+$/u;
const PRESET_FAVORITE = /^[^/\s]+$/u;

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
	/** The catalog is still arriving, so the trigger names the state instead of a model. */
	loading?: boolean;
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
	loading = false,
}: ModelPickerProps) {
	const tabId = useId();
	const [open, setOpen] = useState(false);
	const [tab, setTab] = useState<PickerTab>("models");
	const [modelQuery, setModelQuery] = useState("");
	const [presetQuery, setPresetQuery] = useState("");
	const [choice, setChoice] = useState<string | null>(null);
	const [favorites, setFavorites] = useState(() => readFavorites(FAVORITES_KEY, MODEL_FAVORITE));
	const [presetFavorites, setPresetFavorites] = useState(() => readFavorites(PRESET_FAVORITES_KEY, PRESET_FAVORITE));
	const [expandedGroups, setExpandedGroups] = useState<string[]>([]);
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
	// Preset providers mirror the terminal: one collapsed header per family, expanded on demand.
	// A search expands every group, so a match is never hidden behind a collapsed header.
	const searchingPresets = presetQuery.trim().length > 0;
	const presetGroups = ((): [string, DesktopModelProfile[]][] => {
		const groups = new Map<string, DesktopModelProfile[]>();
		for (const profile of filteredProfiles) {
			const key = profile.group ?? t("models.presetGroupOther");
			const members = groups.get(key);
			if (members) members.push(profile);
			else groups.set(key, [profile]);
		}
		return [...groups.entries()].sort((left, right) => left[0].localeCompare(right[0]));
	})();
	const groupOpen = (group: string) => searchingPresets || expandedGroups.includes(group);
	const toggleGroup = (group: string) =>
		setExpandedGroups(previous =>
			previous.includes(group) ? previous.filter(item => item !== group) : [...previous, group],
		);

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
	function togglePresetFavorite(id: string) {
		const next = presetFavorites.ids.includes(id)
			? presetFavorites.ids.filter(item => item !== id)
			: [...presetFavorites.ids, id];
		try {
			localStorage.setItem(PRESET_FAVORITES_KEY, JSON.stringify(next));
			setPresetFavorites({ ids: next, error: false });
		} catch {
			setPresetFavorites({ ids: next, error: true });
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
				aria-label={t("models.triggerLabel", {
					model: loading ? t("models.loadingModels") : (current?.name ?? selectedId ?? t("models.notSelected")),
				})}
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-busy={loading || undefined}
				disabled={disabled || pending || applying}
				title={
					loading ? t("models.loadingModels") : (current?.id ?? selectedId ?? t("models.triggerFallbackTitle"))
				}
				onClick={openDialog}
			>
				<Cpu size={15} aria-hidden="true" />
				<span>
					{loading
						? t("models.loadingModels")
						: pending
							? t("models.applyingModel")
							: (current?.name ?? selectedId ?? t("models.selectModel"))}
				</span>
				<ChevronDown size={13} aria-hidden="true" />
			</Button>
			{open && (
				<Modal title={t("models.selectModel")} className="model-dialog" onClose={closeDialog}>
					<div
						className="model-tabs"
						role="tablist"
						aria-label={t("models.tabsLabel")}
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
							{t("models.tabPresets")}
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
							{t("models.tabModels")}
						</Button>
					</div>
					{applying && (
						<p className="model-busy-reason muted" role="status">
							{t("models.applyingSelection")}
						</p>
					)}
					{tab === "presets" ? (
						<div role="tabpanel" id={`${tabId}-presets-panel`} aria-labelledby={`${tabId}-presets-tab`}>
							<div className="model-toolbar">
								<label className="model-search">
									<span className="sr-only">{t("models.searchPresets")}</span>
									<Search size={16} aria-hidden="true" />
									<input
										ref={presetInput}
										value={presetQuery}
										placeholder={t("models.searchPresetsPlaceholder")}
										onChange={event => setPresetQuery(event.target.value)}
										onKeyDown={event => {
											if (event.key !== "ArrowDown") return;
											event.preventDefault();
											focusFirstHit(presetResults.current);
										}}
									/>
								</label>
								<Button
									className="model-refresh"
									aria-label={t("models.refreshPresets")}
									title={t("models.refreshPresets")}
									disabled={!onRefresh || !!refreshing}
									onClick={() => onRefresh?.()}
								>
									<RefreshCw aria-hidden="true" />
								</Button>
							</div>
							<p className="muted" role="status">
								{t("models.presetCount", { count: filteredProfiles.length })}
							</p>
							{presetFavorites.error && (
								<p className="model-favorites-error" role="alert">
									{t("models.presetFavoritesError")}
								</p>
							)}
							{profileList.length === 0 ? (
								<div className="empty model-empty">{t("models.noPresets")}</div>
							) : filteredProfiles.length === 0 ? (
								<div className="empty model-empty">{t("models.noPresetMatches")}</div>
							) : (
								<ul className="preset-group-list" aria-label={t("models.presetResults")}>
									{presetGroups.map(([group, members]) => {
										const expanded = groupOpen(group);
										return (
											<li className="preset-group" key={group}>
												<Button
													className="preset-group-head"
													aria-expanded={expanded}
													onClick={() => toggleGroup(group)}
												>
													<ChevronRight
														className="disclosure-chevron"
														size={14}
														aria-hidden="true"
														data-open={expanded || undefined}
													/>
													<strong>{group}</strong>
													<small>
														{members.length === 1
															? t("models.presetGroupCountOne")
															: t("models.presetGroupCount", { count: members.length })}
													</small>
												</Button>
												{expanded && (
													<ul
														ref={presetResults}
														className="model-result-list"
														aria-label={t("models.presetResults")}
														onKeyDown={navigateList}
													>
														{members.map(profile => {
															const entries = profileRoleEntries(profile);
															return (
																<li className="model-result-row" key={profile.id}>
																	<div
																		className="model-option"
																		aria-current={profile.active ? "true" : undefined}
																	>
																		<Button
																			className="model-option-hit"
																			aria-label={t("models.applyPreset", { name: profile.name })}
																			disabled={!onApplyProfile || applying}
																			onClick={() => {
																				if (!onApplyProfile) return;
																				onApplyProfile(profile.id);
																				closeDialog();
																			}}
																		>
																			<span className="model-option-main">
																				<strong>{profile.name}</strong>
																				{(profile.active || profile.default) && (
																					<small>
																						{profile.active ? t("models.active") : ""}
																						{profile.active && profile.default ? " · " : ""}
																						{profile.default ? t("models.defaultProfile") : ""}
																					</small>
																				)}
																				{entries.length > 0 && (
																					<span className="preset-roles">
																						{entries.map(entry => (
																							<span key={entry.id}>
																								· {entry.label} {entry.model}
																							</span>
																						))}
																					</span>
																				)}
																			</span>
																		</Button>
																		<Button
																			className="model-favorite"
																			aria-label={t("models.starPreset", { name: profile.name })}
																			aria-pressed={presetFavorites.ids.includes(profile.id)}
																			onClick={() => togglePresetFavorite(profile.id)}
																		>
																			<Star
																				size={16}
																				aria-hidden="true"
																				fill={
																					presetFavorites.ids.includes(profile.id)
																						? "currentColor"
																						: "none"
																				}
																			/>
																		</Button>
																	</div>
																</li>
															);
														})}
													</ul>
												)}
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
										{t("models.back")}
									</button>
									<p>
										{t("models.chooseRole", {
											name: models.find(model => model.id === choice)?.name ?? choice,
										})}
									</p>
									<p className="muted">{t("models.roleScope")}</p>
									<div className="model-role-list">
										{ROLE_ORDER.map(role => {
											const preference = roleFor(role);
											const fixtureDefault = role === "default" && !onAssign && !roles;
											const available = fixtureDefault || (!!onAssign && !!preference?.canApply.available);
											const reason = preference?.canApply.reason ?? t("models.roleUnavailable");
											const assigned = matches(role, choice);
											// Default selects this conversation's model, which the renderer defers; only role
											// preference writes need a settled session.
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
														disabled={!available || applying}
														onClick={() => {
															if (onAssign) onAssign(role, choice);
															else if (fixtureDefault) onSelect(choice);
															closeDialog();
														}}
													>
														{ROLE_LABELS[role]()}
														{assigned ? ` · ${t("models.active")}` : ""}
													</Button>
													{!available && <small className="model-role-reason">{reason}</small>}
													{role !== "default" && assigned && preference?.configured && (
														<Button
															className="model-role-clear"
															disabled={!canClear || applying}
															title={
																preference.canClear.reason ??
																(!canClear ? t("models.overrideNotClearable") : undefined)
															}
															onClick={() => {
																if (canClear) {
																	onAssign?.(role, null);
																	closeDialog();
																}
															}}
														>
															{t("models.clearOverride")}
														</Button>
													)}
												</div>
											);
										})}
									</div>
									<Button className="model-role-cancel" onClick={closeDialog}>
										{t("models.cancel")}
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
												{ROLE_LABELS[role]()} · {roleFor(role)?.model?.name ?? t("models.unavailableModel")}
											</span>
											<Button
												className="model-role-unavailable-clear"
												disabled={!onAssign || applying}
												onClick={() => {
													onAssign?.(role, null);
													setOpen(false);
												}}
											>
												{t("models.clearOverride")}
											</Button>
										</div>
									))}
									<div className="model-toolbar">
										<label className="model-search">
											<span className="sr-only">{t("models.searchModels")}</span>
											<Search size={16} aria-hidden="true" />
											<input
												ref={modelInput}
												value={modelQuery}
												placeholder={t("models.searchModelsPlaceholder")}
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
											aria-label={t("models.refreshModels")}
											title={t("models.refreshModels")}
											disabled={!onRefresh || !!refreshing}
											onClick={() => onRefresh?.()}
										>
											<RefreshCw aria-hidden="true" />
										</Button>
									</div>
									<p className="muted" role="status">
										{t("models.modelCount", { count: filtered.length })}
									</p>
									{favorites.error && (
										<p className="model-favorites-error" role="alert">
											{t("models.favoritesError")}
										</p>
									)}
									{filtered.length === 0 ? (
										<div className="empty model-empty">
											{models.length === 0
												? refreshing
													? t("models.loadingModels")
													: t("models.noModels")
												: t("models.noModelMatches")}
										</div>
									) : (
										<ul
											ref={results}
											className="model-result-list"
											aria-label={t("models.modelResults")}
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
																				{ROLE_LABELS[role]()}
																			</span>
																		))}
																	</span>
																</span>
																{selected && (
																	<span className="sr-only">{t("models.selectedModel")}</span>
																)}
															</Button>
															<Button
																className="model-favorite"
																aria-label={t("models.starModel", { name: model.name })}
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
												{t("models.configureProviders")}
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
