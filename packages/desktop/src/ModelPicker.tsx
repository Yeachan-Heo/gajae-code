import { Check, ChevronDown, Cpu, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DesktopModel } from "../../desktop-host/src/protocol";
import { Button, Modal } from "./components";

const PAGE_SIZE = 80;

export function filterDesktopModels(models: DesktopModel[], query: string): DesktopModel[] {
	const terms = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
	return models.filter(model => {
		const text = `${model.provider} ${model.name} ${model.id}`.toLowerCase();
		return terms.every(term => text.includes(term));
	});
}

export function ModelPicker({
	models,
	selectedId,
	disabled,
	pending,
	onSelect,
	onConfigureProviders,
}: {
	models: DesktopModel[];
	selectedId?: string;
	disabled?: boolean;
	pending?: boolean;
	onSelect: (modelId: string) => void;
	onConfigureProviders?: () => void;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [limit, setLimit] = useState(PAGE_SIZE);
	const input = useRef<HTMLInputElement>(null);
	const results = useRef<HTMLUListElement>(null);
	const current = models.find(model => model.id === selectedId);
	const filtered = filterDesktopModels(models, query);
	const visible = filtered.slice(0, limit);

	useEffect(() => {
		if (open) input.current?.focus();
	}, [open]);
	useEffect(() => {
		// A session switch must never leave a picker attached to the previous owner.
		setOpen(false);
	}, [selectedId]);

	return (
		<>
			<Button
				className="model-trigger"
				aria-label={`모델 선택: ${current?.name ?? "선택되지 않음"}`}
				aria-haspopup="dialog"
				aria-expanded={open}
				disabled={disabled || pending}
				title={current?.id ?? "사용 가능한 모델 선택"}
				onClick={() => {
					setQuery("");
					setLimit(PAGE_SIZE);
					setOpen(true);
				}}
			>
				<Cpu size={15} aria-hidden="true" />
				<span>{pending ? "모델 적용 중…" : (current?.name ?? "모델 선택")}</span>
				<ChevronDown size={13} aria-hidden="true" />
			</Button>
			{open && (
				<Modal title="모델 선택" className="model-dialog" onClose={() => setOpen(false)}>
					<p className="muted">등록·연결된 제공자에서 이 대화에 사용할 수 있는 모델만 표시합니다.</p>
					<label className="model-search">
						<span className="sr-only">모델 또는 제공자 검색</span>
						<Search size={16} aria-hidden="true" />
						<input
							ref={input}
							value={query}
							placeholder="모델 이름, 제공자 또는 ID 검색"
							onChange={event => {
								setQuery(event.target.value);
								setLimit(PAGE_SIZE);
							}}
							onKeyDown={event => {
								if (event.key === "ArrowDown") {
									event.preventDefault();
									results.current?.querySelector<HTMLButtonElement>("button")?.focus();
								}
							}}
						/>
					</label>
					<p className="muted" role="status">{filtered.length}개 모델{visible.length < filtered.length ? ` · ${visible.length}개 표시` : ""}</p>
					{filtered.length === 0 ? (
						<div className="empty model-empty">{models.length === 0 ? "사용 가능한 모델이 없습니다. 설정에서 제공자를 추가하거나 계정을 연결하세요." : "일치하는 모델이 없습니다. 다른 이름이나 제공자를 검색하세요."}</div>
					) : (
						<ul
							ref={results}
							className="model-result-list"
							aria-label="모델 검색 결과"
							onKeyDown={event => {
								if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
								const buttons = [...(results.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
								const index = buttons.findIndex(button => button === document.activeElement);
								if (index < 0) return;
								event.preventDefault();
								const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
								buttons[next]?.focus();
							}}
						>
							{visible.map(model => (
								<li key={model.id}>
									<Button
										className="model-option"
										aria-pressed={selectedId === model.id}
										disabled={disabled || pending}
										onClick={() => {
											onSelect(model.id);
											setOpen(false);
										}}
									>
										<span className="model-option-main"><strong>{model.name}</strong><small>{model.provider} · {model.id}</small></span>
										{selectedId === model.id && <Check size={16} aria-hidden="true" />}
									</Button>
								</li>
							))}
						</ul>
					)}
					{visible.length < filtered.length && <Button onClick={() => setLimit(previous => previous + PAGE_SIZE)}>모델 더 보기</Button>}
					{onConfigureProviders && <div className="model-provider-actions"><Button disabled={disabled || pending} onClick={() => { setOpen(false); onConfigureProviders(); }}>제공자 추가·연결</Button></div>}
				</Modal>
			)}
		</>
	);
}
