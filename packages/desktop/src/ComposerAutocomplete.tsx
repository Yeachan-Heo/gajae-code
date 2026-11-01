import {
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import type { DesktopCompletionItem, DesktopCompletionResult } from "../../desktop-host/src/protocol";
import { t } from "./i18n";

export interface ComposerAutocompleteSource {
	/** A catalog session and its current rendered control generation. */
	owner: string;
	complete: (text: string, cursor: number) => Promise<DesktopCompletionResult>;
}

/** Only trigger discovery for command/file input, never ordinary prose or email addresses. */
export function hasComposerCompletionTrigger(text: string, cursor: number): boolean {
	const before = text.slice(0, cursor);
	const line = before.slice(before.lastIndexOf("\n") + 1);
	return (
		/(?:^|\s)\/[^\s]*$/.test(line) ||
		/^\s*\/[^\s]+[\t ].*$/.test(line) ||
		/(?:^|[\s=])@(?:"[^"]*|[^\s"]*)$/.test(line)
	);
}

interface CompletionState {
	key: string;
	status: "loading" | "ready" | "error";
	items: DesktopCompletionItem[];
	reason?: string;
}

export function useComposerAutocomplete({
	value,
	onChange,
	textarea,
	disabled,
	source,
}: {
	value: string;
	onChange: (value: string) => void;
	textarea: RefObject<HTMLTextAreaElement | null>;
	disabled?: boolean;
	source?: ComposerAutocompleteSource;
}) {
	const id = useId();
	const [cursor, setCursor] = useState(0);
	const [focused, setFocused] = useState(false);
	const [collapsed, setCollapsed] = useState(true);
	const [composing, setComposing] = useState(false);
	const [dismissed, setDismissed] = useState<string>();
	const [state, setState] = useState<CompletionState>();
	const [active, setActive] = useState(0);
	const [position, setPosition] = useState({ left: 8, bottom: 8, width: 0, maxHeight: 240 });
	const pendingCaret = useRef<{ owner: string | undefined; text: string; cursor: number } | undefined>(undefined);
	const complete = useRef(source?.complete);
	complete.current = source?.complete;
	const key = JSON.stringify([source?.owner, value, cursor]);
	const dismissalKey = JSON.stringify([source?.owner, value]);
	const current = useRef(key);
	current.current = key;
	const eligible =
		!!source &&
		focused &&
		collapsed &&
		!disabled &&
		!composing &&
		dismissed !== dismissalKey &&
		hasComposerCompletionTrigger(value, cursor);
	const visible = eligible && state?.key === key ? state : undefined;
	const selected = Math.min(active, Math.max(0, (visible?.items.length ?? 1) - 1));
	const trackSelection = () => {
		const input = textarea.current;
		if (!input) return;
		setCursor(input.selectionStart);
		setCollapsed(input.selectionStart === input.selectionEnd);
	};

	useEffect(() => {
		const input = textarea.current;
		if (!input) return;
		const select = () => {
			if (document.activeElement !== input) return;
			setCursor(input.selectionStart);
			setCollapsed(input.selectionStart === input.selectionEnd);
		};
		input.addEventListener("select", select);
		document.addEventListener("selectionchange", select);
		return () => {
			input.removeEventListener("select", select);
			document.removeEventListener("selectionchange", select);
		};
	}, [textarea]);

	useEffect(() => {
		if (!eligible) return;
		let cancelled = false;
		let deadline: number | undefined;
		const timer = window.setTimeout(() => {
			const input = textarea.current;
			const query = complete.current;
			if (
				!query ||
				!input ||
				input.disabled ||
				current.current !== key ||
				input.value !== value ||
				input.selectionStart !== cursor ||
				input.selectionEnd !== cursor
			)
				return;
			setState({ key, status: "loading", items: [] });
			deadline = window.setTimeout(() => {
				if (!cancelled && current.current === key) {
					cancelled = true;
					setState({ key, status: "error", items: [] });
				}
			}, 5000);
			void Promise.resolve()
				.then(() => query(value, cursor))
				.then(
					result => {
						window.clearTimeout(deadline);
						if (cancelled || current.current !== key) return;
						setActive(0);
						setState({ key, status: "ready", items: result.items, reason: result.reason });
					},
					() => {
						window.clearTimeout(deadline);
						if (!cancelled && current.current === key) setState({ key, status: "error", items: [] });
					},
				);
		}, 120);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
			window.clearTimeout(deadline);
		};
	}, [eligible, key, value, cursor, textarea]);

	useLayoutEffect(() => {
		const pending = pendingCaret.current;
		if (pending && pending.owner !== source?.owner) pendingCaret.current = undefined;
		if (!pending || pending.owner !== source?.owner || value !== pending.text || !textarea.current) return;
		pendingCaret.current = undefined;
		textarea.current.focus();
		textarea.current.setSelectionRange(pending.cursor, pending.cursor);
		setCursor(pending.cursor);
	}, [value, source?.owner, textarea]);

	useLayoutEffect(() => {
		if (!visible) return;
		const anchor = textarea.current?.closest(".composer");
		if (!anchor) return;
		const measure = () => {
			const rect = anchor.getBoundingClientRect();
			const top = Math.max(56, rect.top);
			setPosition({
				left: Math.max(8, rect.left),
				bottom: Math.max(8, window.innerHeight - top + 8),
				width: Math.max(0, Math.min(rect.width, window.innerWidth - 16)),
				maxHeight: Math.max(40, Math.min(240, top - 16)),
			});
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(anchor);
		window.addEventListener("resize", measure);
		window.addEventListener("scroll", measure, true);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", measure);
			window.removeEventListener("scroll", measure, true);
		};
	}, [!!visible, textarea]);

	useEffect(() => {
		if (visible?.items.length) document.getElementById(`${id}-${selected}`)?.scrollIntoView({ block: "nearest" });
	}, [id, selected, visible?.items, position.width, position.bottom, position.maxHeight]);

	const apply = (item: DesktopCompletionItem) => {
		const input = textarea.current;
		if (
			!visible ||
			!input ||
			current.current !== visible.key ||
			input.value !== value ||
			input.selectionStart !== cursor ||
			input.selectionEnd !== cursor
		)
			return;
		setDismissed(item.value.endsWith("/") ? undefined : JSON.stringify([source?.owner, item.text]));
		setState(undefined);
		pendingCaret.current = { owner: source?.owner, text: item.text, cursor: item.cursor };
		onChange(item.text);
		// A completion may only move the caret without changing the text.
		if (item.text === value) {
			pendingCaret.current = undefined;
			input.focus();
			input.setSelectionRange(item.cursor, item.cursor);
			setCursor(item.cursor);
		}
	};
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
		if (
			composing ||
			event.nativeEvent.isComposing ||
			event.keyCode === 229 ||
			!visible ||
			event.altKey ||
			event.ctrlKey ||
			event.metaKey
		)
			return false;
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			setDismissed(dismissalKey);
			setState(undefined);
			return true;
		}
		if (!visible.items.length || event.shiftKey) return false;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			setActive((selected + (event.key === "ArrowDown" ? 1 : -1) + visible.items.length) % visible.items.length);
			return true;
		}
		if (event.key === "Enter" || event.key === "Tab") {
			event.preventDefault();
			apply(visible.items[selected]);
			return true;
		}
		return false;
	};
	let popup: ReactNode = null;
	if (visible) {
		popup = createPortal(
			<div className="composer-completions" style={position}>
				{visible.status === "ready" && visible.items.length > 0 ? (
					<div id={id} role="listbox" aria-label={t("support.completionLabel")}>
						{visible.items.map((item, index) => (
							<button
								key={`${index}:${item.value}`}
								id={`${id}-${index}`}
								type="button"
								role="option"
								tabIndex={-1}
								title={item.description ? `${item.label}\n${item.description}` : item.label}
								aria-selected={selected === index}
								onPointerDown={event => event.preventDefault()}
								onClick={() => apply(item)}
							>
								<strong>{item.label}</strong>
								{item.description && <small>{item.description}</small>}
							</button>
						))}
					</div>
				) : (
					<p role="status">
						{visible.status === "loading"
							? t("support.completionLoading")
							: visible.status === "error"
								? t("support.completionError")
								: visible.reason || t("support.completionEmpty")}
					</p>
				)}
			</div>,
			document.body,
		);
	}
	return {
		popup,
		onKeyDown,
		onSelect: trackSelection,
		onFocus: () => {
			setFocused(true);
			trackSelection();
		},
		onBlur: () => setFocused(false),
		onCompositionStart: () => setComposing(true),
		onCompositionEnd: () => {
			setComposing(false);
			trackSelection();
		},
		aria: {
			"aria-autocomplete": source ? ("list" as const) : undefined,
			"aria-controls": visible?.items.length ? id : undefined,
			"aria-activedescendant": visible?.items.length ? `${id}-${selected}` : undefined,
		},
	};
}
