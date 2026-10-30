import { describe, expect, test } from "bun:test";
import { Children, isValidElement } from "react";
import type { ChangeEvent, FormEvent, KeyboardEvent, ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopBtwConversation, DesktopBtwTurn } from "../../desktop-host/src/btw-protocol";
import { BtwPanel, type BtwPanelProps } from "../src/BtwPanel";

function turn(overrides: Partial<DesktopBtwTurn> = {}): DesktopBtwTurn {
	return {
		turnId: "opaque:btw/turn <&> ?=29\nend",
		question: "Ask a question while the main work stays as it is.\n  Explain the frozen context.\n",
		answer: "A partial answer received so far.\n  English and TypeScript notes\n",
		status: "running",
		answerTruncated: false,
		...overrides,
	};
}

function conversation(turns: DesktopBtwTurn[] = [turn()]): DesktopBtwConversation {
	return { conversationId: "opaque-conversation", sessionGeneration: 17, revision: 3, turns };
}

function props(overrides: Partial<BtwPanelProps> = {}): BtwPanelProps {
	return {
		conversation: null,
		draft: "  Follow-up question.\n  Keep the existing draft.\n",
		disabled: false,
		pending: false,
		onDraftChange: () => { throw new Error("Rendering must not change the draft"); },
		onSend: () => { throw new Error("Rendering must not send a question"); },
		onCancel: () => { throw new Error("Rendering must not cancel a turn"); },
		...overrides,
	};
}

function render(overrides: Partial<BtwPanelProps> = {}): string {
	return renderToStaticMarkup(<BtwPanel {...props(overrides)} />);
}

function button(html: string, label: string): string {
	const result = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/gu)]
		.find(match => match[0].endsWith(`${label}</button>`));
	if (!result) throw new Error(`Missing button: ${label}`);
	return result[0];
}

interface PanelNodeProps {
	children?: ReactNode;
	onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
	onChange?: (event: ChangeEvent<HTMLTextAreaElement>) => void;
	onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
	onClick?: () => void;
}

// Match the existing OperatorPanel SSR presentation-tree approach. Handler invocation
// proves callback wiring, not mounted browser keyboard, focus or transport behavior.
function capture(overrides: Partial<BtwPanelProps>): ReactNode {
	const captured: { tree: ReactNode } = { tree: null };
	function Harness() {
		captured.tree = BtwPanel(props(overrides));
		return captured.tree;
	}
	renderToStaticMarkup(<Harness />);
	return captured.tree;
}

function node(tree: ReactNode, predicate: (element: ReactElement<PanelNodeProps>) => boolean): ReactElement<PanelNodeProps> {
	let found: ReactElement<PanelNodeProps> | undefined;
	function visit(children: ReactNode) {
		Children.forEach(children, child => {
			if (found || !isValidElement<PanelNodeProps>(child)) return;
			if (predicate(child)) found = child;
			else visit(child.props.children);
		});
	}
	visit(tree);
	if (!found) throw new Error("Missing presentation node");
	return found;
}

function submit(tree: ReactNode): boolean {
	let prevented = false;
	const handler = node(tree, element => element.type === "form").props.onSubmit;
	if (!handler) throw new Error("Missing submit handler");
	handler({ preventDefault: () => { prevented = true; } } as FormEvent<HTMLFormElement>);
	return prevented;
}

function change(tree: ReactNode, value: string) {
	const handler = node(tree, element => element.type === "textarea").props.onChange;
	if (!handler) throw new Error("Missing change handler");
	handler({ target: { value } } as ChangeEvent<HTMLTextAreaElement>);
}

function key(tree: ReactNode, options: { key?: string; metaKey?: boolean; ctrlKey?: boolean; composing?: boolean } = {}): boolean {
	let prevented = false;
	const handler = node(tree, element => element.type === "textarea").props.onKeyDown;
	if (!handler) throw new Error("Missing keyboard handler");
	handler({
		key: options.key ?? "Enter",
		metaKey: options.metaKey ?? false,
		ctrlKey: options.ctrlKey ?? false,
		nativeEvent: { isComposing: options.composing ?? false },
		preventDefault: () => { prevented = true; },
	} as KeyboardEvent<HTMLTextAreaElement>);
	return prevented;
}

function cancel(tree: ReactNode) {
	const handler = node(tree, element => element.props.children === "Request side chat stop").props.onClick;
	if (!handler) throw new Error("Missing side-turn cancel handler");
	handler();
}

describe("desktop BTW side-chat presentation", () => {
	test("explains frozen text-only isolation and provides a labeled controlled draft without owning a dialog", () => {
		for (const value of [null, conversation([])]) {
			const html = render({ conversation: value });
			expect(html).toContain("A text-only side chat");
			expect(html).toContain("context frozen when it started");
			expect(html).toContain("It does not use tools");
			expect(html).toContain("not written to the main conversation");
			expect(html).toContain("composer stay separate");
			expect(html).toContain("No side chat yet.");
			expect(html).toMatch(/<label for="[^"]+">Side chat question<\/label>/u);
			expect(html).toMatch(/<textarea[^>]*aria-describedby="[^"]+"[^>]*rows="3"/u);
			expect(html).toContain(props().draft);
			expect(html).toContain("Enter for a new line");
			expect(html).not.toContain("<dialog");
			expect(html).not.toContain("Request side chat stop");
			expect(button(html, "Send side chat")).not.toContain('disabled=""');
		}
	});

	test("renders ordered question and answer text inertly with original whitespace and explicit truncation", () => {
		const hostile = '<script>alert("fixture")</script>\n  <img src=x onerror=alert(1)>\n';
		const html = render({ conversation: conversation([
			turn({ turnId: "first", status: "completed" }),
			turn({ turnId: "second", question: "Second question\n  indented", answer: hostile, status: "cancelled", answerTruncated: true }),
		]) });
		expect(html).toContain('class="btw-history" role="region" aria-label="Side chat questions and answers" tabindex="0"');
		expect(html).toContain('class="btw-turn-list"');
		expect(html).toContain(turn().question);
		expect(html).toContain(turn().answer);
		expect(html.indexOf(turn().question)).toBeLessThan(html.indexOf("Second question"));
		expect(html).toContain("&lt;script&gt;alert(&quot;fixture&quot;)&lt;/script&gt;\n  &lt;img");
		expect(html).not.toContain("<script");
		expect(html).not.toContain("<img");
		expect(html).toContain("Cancelled · received answer kept");
		expect(html).toContain("The answer shown is not complete");
		expect(html).not.toContain("Request side chat stop");
		expect(button(html, "Send side chat")).not.toContain('disabled=""');
	});

	test("submits the exact draft without clearing it and reports edits without mutating controlled text", () => {
		const changes: string[] = [];
		const sends: string[] = [];
		const draft = "  Original draft\n    Keep the whitespace.\n";
		const tree = capture({ draft, onDraftChange: value => changes.push(value), onSend: value => sends.push(value) });
		expect(submit(tree)).toBe(true);
		expect(sends).toEqual([draft]);
		expect(changes).toEqual([]);
		const edited = "\n  Next question draft";
		change(tree, edited);
		expect(changes).toEqual([edited]);
		expect(sends).toEqual([draft]);
		expect(render({ draft })).toContain(draft);
		expect(render({ draft: edited })).toContain(edited);
	});

	test("reserves ordinary Enter for newline and submits Meta/Ctrl+Enter only outside IME composition", () => {
		for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
			const sends: string[] = [];
			const tree = capture({ onSend: value => sends.push(value) });
			expect(key(tree)).toBe(false);
			expect(key(tree, { ...modifier, key: "Escape" })).toBe(false);
			expect(key(tree, { ...modifier, composing: true })).toBe(false);
			expect(sends).toEqual([]);
			expect(key(tree, modifier)).toBe(true);
			expect(sends).toEqual([props().draft]);
		}
	});

	test("blocks blank, pending, disconnected and active-turn sends without discarding editable drafts", () => {
		const cases: Partial<BtwPanelProps>[] = [
			{ draft: " \n\t " },
			{ pending: true },
			{ disabled: true },
			{ conversation: conversation() },
			{ conversation: conversation([turn({ status: "cancel_requested" })]) },
		];
		for (const state of cases) {
			const changes: string[] = [];
			const sends: string[] = [];
			const tree = capture({ ...state, onDraftChange: value => changes.push(value), onSend: value => sends.push(value) });
			const html = render(state);
			expect(button(html, "Send side chat")).toContain('disabled=""');
			expect(submit(tree)).toBe(true);
			expect(key(tree, { metaKey: true })).toBe(false);
			expect(key(tree, { ctrlKey: true })).toBe(false);
			expect(sends).toEqual([]);
			change(tree, "Draft to keep\n  follow-up question");
			expect(changes).toEqual(["Draft to keep\n  follow-up question"]);
			expect(html.match(/<textarea[^>]*>/u)?.[0]).not.toContain('disabled=""');
		}
		expect(render({ pending: true })).toContain("Waiting for a response");
		expect(render({ disabled: true })).toContain("The connection or session is unavailable");
		expect(render({ disabled: true })).toContain(props().draft);
	});

	test("targets only the active side-turn ID and never presents a stop request as confirmed cancellation", () => {
		const active = turn();
		const value = conversation([turn({ turnId: "completed-side-turn", status: "completed" }), active]);
		const cancellations: string[] = [];
		const tree = capture({ conversation: value, onCancel: id => cancellations.push(id) });
		cancel(tree);
		expect(cancellations).toEqual([active.turnId]);
		const html = render({ conversation: conversation() });
		expect(button(html, "Request side chat stop")).not.toContain('disabled=""');
		expect(html).toContain("only to this side chat response");
		expect(html).toContain("does not guarantee an immediate exit");
		for (const state of [{ pending: true }, { disabled: true }, { conversation: conversation([turn({ status: "cancel_requested" })]) }]) {
			const locked = { conversation: conversation(), ...state };
			expect(button(render(locked), "Request side chat stop")).toContain('disabled=""');
			cancel(capture(locked));
		}
		const cancelling = render({ conversation: conversation([turn({ status: "cancel_requested" })]) });
		expect(cancelling).toContain("Stop requested · waiting for exit");
		expect(cancelling).not.toContain("Cancelled ·");
		expect(cancelling).toContain(active.answer);
	});

	test("exposes each terminal result, preserves partial failures and re-enables follow-up without inventing output", () => {
		for (const [status, label] of [["completed", "Responded"], ["cancelled", "Cancelled · received answer kept"], ["failed", "Response failed"]] as const) {
			const html = render({ conversation: conversation([turn({ status })]) });
			expect(html).toContain(`data-status="${status}"`);
			expect(html).toContain(`role="status">${label}</p>`);
			expect(html).toContain(turn().answer);
			expect(html).not.toContain("Request side chat stop");
			expect(button(html, "Send side chat")).not.toContain('disabled=""');
			const sends: string[] = [];
			submit(capture({ conversation: conversation([turn({ status })]), onSend: value => sends.push(value) }));
			expect(sends).toEqual([props().draft]);
		}
		const failed = render({ conversation: conversation([turn({ status: "failed", error: { code: "provider_failure", message: "The response connection dropped.\n  Received content is kept." } })]) });
		expect(failed).toContain('role="alert"');
		expect(failed).toContain("provider_failure: The response connection dropped.\n  Received content is kept.");
		expect(failed).toContain(turn().answer);
		const empty = render({ conversation: conversation([turn({ status: "cancelled", answer: "" })]) });
		expect(empty).toContain("No answer yet.");
		expect(empty).not.toContain('aria-label="Side chat answer"');
		expect(empty).not.toContain("Responded");
	});
});
