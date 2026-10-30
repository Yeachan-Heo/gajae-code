import { Brain, ChevronDown } from "lucide-react";
import type { FocusEvent, KeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";
import type { DesktopThinking, DesktopThinkingLevel } from "../../desktop-host/src/protocol";
import { Button } from "./components";
import { t } from "./i18n";

export function ReasoningSelect({
	thinking,
	disabled,
	pending,
	onChange,
}: {
	thinking?: DesktopThinking;
	disabled?: boolean;
	pending?: boolean;
	onChange: (level: DesktopThinkingLevel) => void;
}) {
	const options = thinking?.options ?? [];
	const value = thinking?.level ?? "";
	const current = options.find(option => option.value === value);
	const unavailable = !thinking?.available || options.length === 0;
	const inactive = !!disabled || !!pending || unavailable;
	const fallbackLabel = pending
		? t("models.reasoningApplying")
		: unavailable
			? thinking?.mode === "always-on"
				? t("models.reasoningAlwaysOn")
				: t("models.reasoningNone")
			: value || t("models.modelDefault");
	const [open, setOpen] = useState(false);
	const [anchor, setAnchor] = useState<{ left: number; width: number; bottom: number }>();
	const control = useRef<HTMLDivElement>(null);
	const menu = useRef<HTMLUListElement>(null);

	// The composer pane scrolls and clips absolute children, so the menu is anchored
	// to the trigger in viewport coordinates and re-measured on every open.
	const openMenu = () => {
		const rect = control.current?.getBoundingClientRect();
		if (rect) setAnchor({ left: rect.left, width: rect.width, bottom: window.innerHeight - rect.top + 4 });
		setOpen(true);
	};
	useEffect(() => {
		if (inactive) setOpen(false);
	}, [inactive]);
	useEffect(() => {
		if (!open) return;
		const listener = (event: PointerEvent) => {
			if (event.target instanceof Node && control.current?.contains(event.target)) return;
			setOpen(false);
		};
		// Follow the trigger instead of closing: opening the menu can itself scroll
		// the composer, and a stale fixed position is worse than a moved anchor.
		const reposition = () => {
			const next = control.current?.getBoundingClientRect();
			if (!next || next.bottom < 0 || next.top > window.innerHeight) {
				setOpen(false);
				return;
			}
			setAnchor({ left: next.left, width: next.width, bottom: window.innerHeight - next.top + 4 });
		};
		document.addEventListener("pointerdown", listener);
		window.addEventListener("resize", reposition);
		window.addEventListener("scroll", reposition, true);
		return () => {
			document.removeEventListener("pointerdown", listener);
			window.removeEventListener("resize", reposition);
			window.removeEventListener("scroll", reposition, true);
		};
	}, [open]);
	useEffect(() => {
		if (!open) return;
		const listbox = menu.current;
		const selected = listbox?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]');
		(selected ?? listbox?.querySelector<HTMLButtonElement>('[role="option"]:not(:disabled)'))?.focus();
	}, [open]);

	function focusTrigger() {
		control.current?.querySelector<HTMLButtonElement>(".select-trigger")?.focus();
	}
	// React reports focusout here, so focus moving between the trigger and an option stays
	// inside the control and must not close the menu; only a real departure does.
	function handleBlur(event: FocusEvent<HTMLDivElement>) {
		const next = event.relatedTarget;
		if (next instanceof Node && control.current?.contains(next)) return;
		setOpen(false);
	}
	function handleMenuKeyDown(event: KeyboardEvent<HTMLUListElement>) {
		const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? [])];
		const active = document.activeElement;
		const index = active instanceof HTMLButtonElement ? buttons.indexOf(active) : -1;
		if (event.key === "Escape") {
			event.preventDefault();
			setOpen(false);
			focusTrigger();
			return;
		}
		if (event.key === "Enter" || event.key === " ") {
			if (index < 0) return;
			event.preventDefault();
			buttons[index].click();
			return;
		}
		if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || buttons.length === 0) return;
		event.preventDefault();
		const next =
			event.key === "Home"
				? 0
				: event.key === "End"
					? buttons.length - 1
					: Math.max(
							0,
							Math.min(
								buttons.length - 1,
								(index < 0 && event.key === "ArrowDown" ? -1 : Math.max(index, 0)) +
									(event.key === "ArrowDown" ? 1 : -1),
							),
						);
		buttons[next]?.focus();
	}

	return (
		<div className="reasoning-control" ref={control} onBlur={handleBlur}>
			<div className="select-control">
				<Button
					className="select-trigger"
					aria-haspopup="listbox"
					aria-expanded={open}
					aria-label={t("models.reasoningLevelFor", { level: current?.label ?? fallbackLabel })}
					title={thinking?.reason ?? t("models.reasoningLevelTitle")}
					disabled={inactive}
					onClick={() => (open ? setOpen(false) : openMenu())}
					onKeyDown={event => {
						if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
						event.preventDefault();
						if (!open) openMenu();
					}}
				>
					<Brain size={15} aria-hidden="true" />
					<span>{current?.label ?? fallbackLabel}</span>
					<ChevronDown size={13} aria-hidden="true" />
				</Button>
				{open && (
					<ul
						ref={menu}
						className="select-menu"
						role="listbox"
						aria-label={t("models.reasoningLevel")}
						style={
							anchor
								? {
										position: "fixed",
										left: anchor.left,
										width: anchor.width,
										bottom: anchor.bottom,
										top: "auto",
										right: "auto",
									}
								: undefined
						}
						onKeyDown={handleMenuKeyDown}
					>
						{!current && (
							<li role="presentation">
								<button
									type="button"
									className="button select-option"
									role="option"
									aria-selected={false}
									disabled
								>
									{fallbackLabel}
								</button>
							</li>
						)}
						{options.map(option => (
							<li role="presentation" key={option.value}>
								<button
									type="button"
									className="button select-option"
									role="option"
									aria-selected={option.value === value}
									title={option.description}
									onClick={() => {
										setOpen(false);
										onChange(option.value);
										focusTrigger();
									}}
								>
									{option.label}
									{option.description && <small>{option.description}</small>}
								</button>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}
