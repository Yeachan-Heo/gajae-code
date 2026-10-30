import { Check, ChevronDown, Cpu, Search, Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DesktopModelRolePreference } from "../../desktop-host/src/preferences-protocol";
import type { DesktopModel } from "../../desktop-host/src/protocol";
import { Button, Modal } from "./components";

export type PickerModelRole = "default" | "executor" | "planner" | "critic" | "architect";
const ROLE_ORDER: PickerModelRole[] = ["default", "executor", "planner", "critic", "architect"];
const ROLE_LABELS: Record<PickerModelRole, string> = {
	default: "Default",
	executor: "Executor",
	planner: "Planner",
	critic: "Critic",
	architect: "Architect",
};
const FAVORITES_KEY = "gjc.desktop.model-favorites";

export function filterDesktopModels(models: DesktopModel[], query: string): DesktopModel[] {
	const terms = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
	return models.filter(model => {
		const text = `${model.provider} ${model.name} ${model.id}`.toLowerCase();
		return terms.every(term => text.includes(term));
	});
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

export function ModelPicker({
	models,
	selectedId,
	disabled,
	pending,
	onSelect,
	onConfigureProviders,
	roles,
	onAssign,
}: {
	models: DesktopModel[];
	selectedId?: string;
	disabled?: boolean;
	pending?: boolean;
	onSelect: (modelId: string) => void;
	onConfigureProviders?: () => void;
	roles?: DesktopModelRolePreference[];
	onAssign?: (role: PickerModelRole, modelId: string | null) => void;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [choice, setChoice] = useState<string | null>(null);
	const [favorites, setFavorites] = useState(readFavorites);
	const input = useRef<HTMLInputElement>(null);
	const results = useRef<HTMLUListElement>(null);
	const back = useRef<HTMLButtonElement>(null);
	const restoreId = useRef<string | null>(null);
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
	const filtered = filterDesktopModels(models, query)
		.map((model, index) => ({ model, index }))
		.sort(
			(a, b) =>
				rank(a.model.id) - rank(b.model.id) ||
				Number(favorites.ids.includes(b.model.id)) - Number(favorites.ids.includes(a.model.id)) ||
				a.index - b.index,
		)
		.map(item => item.model);

	useEffect(() => {
		if (!open) return;
		if (choice) back.current?.focus();
		else if (restoreId.current) {
			const id = restoreId.current;
			restoreId.current = null;
			const button = [...(results.current?.querySelectorAll<HTMLButtonElement>(".model-option") ?? [])].find(
				item => item.dataset.modelId === id,
			);
			(button ?? input.current)?.focus();
		} else input.current?.focus();
	}, [open, choice]);
	useEffect(() => {
		setOpen(false);
		setChoice(null);
	}, [selectedId]);
	useEffect(() => {
		if (disabled || pending) {
			setOpen(false);
			setChoice(null);
		}
	}, [disabled, pending]);
	useEffect(() => {
		if (choice && !models.some(model => model.id === choice)) setChoice(null);
	}, [models, choice]);

	function toggleFavorite(id: string) {
		const ids = favorites.ids.includes(id) ? favorites.ids.filter(item => item !== id) : [...favorites.ids, id];
		try {
			localStorage.setItem(FAVORITES_KEY, JSON.stringify(ids));
			setFavorites({ ids, error: false });
		} catch {
			setFavorites({ ids, error: true });
		}
	}
	function returnToList() {
		restoreId.current = choice;
		setChoice(null);
	}

	return (
		<>
			<Button
				className="model-trigger"
				aria-label={`모델 선택: ${current?.name ?? selectedId ?? "선택되지 않음"}`}
				aria-haspopup="dialog"
				aria-expanded={open && !disabled && !pending}
				disabled={disabled || pending}
				title={current?.id ?? selectedId ?? "사용 가능한 모델 선택"}
				onClick={() => {
					setQuery("");
					setChoice(null);
					setOpen(true);
				}}
			>
				<Cpu size={15} aria-hidden="true" />
				<span>{pending ? "모델 적용 중…" : (current?.name ?? selectedId ?? "모델 선택")}</span>
				<ChevronDown size={13} aria-hidden="true" />
			</Button>
			{open && !disabled && !pending && (
				<Modal
					title="모델 선택"
					className="model-dialog"
					onClose={() => {
						setOpen(false);
						setChoice(null);
					}}
				>
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
												disabled={!available}
												onClick={() => {
													if (onAssign) onAssign(role, choice);
													else if (fixtureDefault) onSelect(choice);
													setOpen(false);
													setChoice(null);
												}}
											>
												{ROLE_LABELS[role]}
												{assigned ? " · 현재 적용" : ""}
											</Button>
											{!available && <small className="model-role-reason">{reason}</small>}
											{role !== "default" && assigned && preference?.configured && (
												<Button
													className="model-role-clear"
													disabled={!canClear}
													title={
														preference.canClear.reason ??
														(!canClear ? "이 역할의 재정의를 해제할 수 없습니다." : undefined)
													}
													onClick={() => {
														if (canClear) {
															onAssign?.(role, null);
															setOpen(false);
															setChoice(null);
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
							<Button
								className="model-role-cancel"
								onClick={() => {
									setOpen(false);
									setChoice(null);
								}}
							>
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
									(!selected || !models.some(model => model.id === `${selected.provider}/${selected.id}`))
								);
							}).map(role => (
								<div className="model-role-row" key={role}>
									<span>
										{ROLE_LABELS[role]} · {roleFor(role)?.model?.name ?? "사용할 수 없는 모델"}
									</span>
									<Button
										className="model-role-unavailable-clear"
										disabled={!onAssign}
										onClick={() => {
											onAssign?.(role, null);
											setOpen(false);
										}}
									>
										재정의 해제
									</Button>
								</div>
							))}
							<label className="model-search">
								<span className="sr-only">모델 또는 제공자 검색</span>
								<Search size={16} aria-hidden="true" />
								<input
									ref={input}
									value={query}
									placeholder="모델 이름, 제공자 또는 ID 검색"
									onChange={event => setQuery(event.target.value)}
									onKeyDown={event => {
										if (event.key === "ArrowDown") {
											event.preventDefault();
											results.current?.querySelector<HTMLButtonElement>(".model-option")?.focus();
										}
									}}
								/>
							</label>
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
										? "사용 가능한 모델이 없습니다. 설정에서 제공자를 추가하거나 계정을 연결하세요."
										: "일치하는 모델이 없습니다. 다른 이름이나 제공자를 검색하세요."}
								</div>
							) : (
								<ul
									ref={results}
									className="model-result-list"
									aria-label="모델 검색 결과"
									onKeyDown={event => {
										if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
										const buttons = [
											...(results.current?.querySelectorAll<HTMLButtonElement>(".model-option") ?? []),
										];
										const active = document.activeElement;
										const index = active instanceof HTMLButtonElement ? buttons.indexOf(active) : -1;
										if (index < 0) return;
										event.preventDefault();
										const next =
											event.key === "Home"
												? 0
												: event.key === "End"
													? buttons.length - 1
													: Math.max(
															0,
															Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)),
														);
										buttons[next]?.focus();
									}}
								>
									{filtered.map(model => (
										<li className="model-result-row" key={model.id}>
											<Button
												className="model-option"
												data-model-id={model.id}
												aria-pressed={selectedId === model.id}
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
																{role !== "default" && !roleFor(role)?.canClear.available
																	? " · 상속"
																	: ""}
															</span>
														))}
													</span>
												</span>
												{selectedId === model.id && <Check size={16} aria-hidden="true" />}
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
										</li>
									))}
								</ul>
							)}
							{onConfigureProviders && (
								<div className="model-provider-actions">
									<Button
										onClick={() => {
											setOpen(false);
											onConfigureProviders();
										}}
									>
										제공자 추가·연결
									</Button>
								</div>
							)}
						</>
					)}
				</Modal>
			)}
		</>
	);
}
