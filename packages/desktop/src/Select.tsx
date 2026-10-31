import { ChevronDown } from "lucide-react";
import type { FocusEvent, KeyboardEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

export interface SelectOption {
	value: string;
	label: string;
	description?: string;
}

/**
 * The app's single dropdown. The settings panels used native `<select>` elements, which
 * rendered a macOS menu that matched neither the surface styling nor the keyboard model of
 * the composer's reasoning control, so every choice list now goes through this control.
 */
export function Select({
	value,
	options,
	onChange,
	disabled,
	ariaLabel,
	ariaLabelledby,
	title,
	icon,
	triggerClassName = "",
	placeholder,
}: {
	value: string;
	options: SelectOption[];
	onChange: (value: string) => void;
	disabled?: boolean;
	/** Announced for the control when no visible label names it. */
	ariaLabel: string;
	/** Ids of the caller's visible label nodes; these win over ariaLabel. */
	ariaLabelledby?: string;
	title?: string;
	icon?: ReactNode;
	triggerClassName?: string;
	/** Shown when no option matches the value, so an unset choice is not an empty trigger. */
	placeholder?: string;
}) {
	const [open, setOpen] = useState(false);
	const [anchor, setAnchor] = useState<{ left: number; width: number; bottom: number }>();
	const control = useRef<HTMLDivElement>(null);
	const menu = useRef<HTMLUListElement>(null);
	/** A press while the menu is open closes it on pointerdown; the click that follows must not
	 * reopen it, in either order the host may dispatch those events. */
	const closedByPress = useRef(false);
	const current = options.find(option => option.value === value);
	const shown = current?.label ?? placeholder ?? value;

	// Menus inside a scrolling pane are clipped by it, so they are anchored to the trigger in
	// viewport coordinates and re-measured on every open and on pane movement.
	const openMenu = () => {
		const rect = control.current?.getBoundingClientRect();
		if (rect) setAnchor({ left: rect.left, width: rect.width, bottom: window.innerHeight - rect.top + 4 });
		setOpen(true);
	};
	useEffect(() => {
		if (disabled) setOpen(false);
	}, [disabled]);
	useEffect(() => {
		if (!open) return;
		const listener = (event: PointerEvent) => {
			if (event.target instanceof Node && control.current?.contains(event.target)) return;
			setOpen(false);
		};
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
		<div className="select-control" ref={control} onBlur={handleBlur}>
			<button
				type="button"
				className={`button select-trigger ${triggerClassName}`.trim()}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-label={ariaLabel}
				aria-labelledby={ariaLabelledby}
				title={title}
				disabled={disabled}
				onPointerDown={() => {
					// Every press re-records the state, so a press that never produced a click (drag
					// away, context menu) cannot swallow the next one.
					closedByPress.current = open;
					if (open) setOpen(false);
				}}
				onClick={() => {
					if (closedByPress.current) {
						closedByPress.current = false;
						setOpen(false);
						return;
					}
					if (open) setOpen(false);
					else openMenu();
				}}
				onKeyDown={event => {
					if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
					event.preventDefault();
					if (!open) openMenu();
				}}
			>
				{icon}
				<span>{shown}</span>
				<ChevronDown size={13} aria-hidden="true" />
			</button>
			{open && (
				<ul
					ref={menu}
					className="select-menu"
					role="listbox"
					aria-label={ariaLabel}
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
	);
}
