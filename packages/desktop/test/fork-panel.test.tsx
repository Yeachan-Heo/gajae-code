import { describe, expect, test } from "bun:test";
import { Children, isValidElement } from "react";
import type { ChangeEvent, ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopHistory } from "../../desktop-host/src/protocol";
import { ForkPanel, type ForkPanelProps } from "../src/ForkPanel";

const wholeCopy = "Copy the whole conversation (fork without a selection)";
const selectedFork = "Fork before the selected message";
const loadMore = "Load the next 500";
const duplicateText = "Duplicate user message\n  Whitespace is preserved too.";

function history(overrides: Partial<DesktopHistory> = {}): DesktopHistory {
	return {
		sessionId: "source-session",
		total: 5,
		offset: 0,
		truncated: false,
		messages: [
			{ id: "display-first", entryId: "entry:first", role: "user", text: duplicateText },
			{ id: "display-assistant", entryId: "entry:not-user", role: "assistant", text: "Response that cannot be selected" },
			{ id: "display-unpersisted", role: "user", text: "Message without a persisted entryId" },
			{ id: "display-second", entryId: "entry:second/日本語", role: "user", text: duplicateText },
			{ id: "display-empty", entryId: "entry:empty", role: "user", text: "" },
		],
		...overrides,
	};
}

function props(overrides: Partial<ForkPanelProps> = {}): ForkPanelProps {
	return {
		history: history(),
		selectedEntryId: "entry:first",
		pending: false,
		disabled: false,
		onSelect: () => { throw new Error("Rendering must not select an entry"); },
		onFork: () => { throw new Error("Rendering must not fork a conversation"); },
		onLoadMore: () => { throw new Error("Rendering must not request more history"); },
		...overrides,
	};
}

function render(overrides: Partial<ForkPanelProps> = {}): string {
	return renderToStaticMarkup(<ForkPanel {...props(overrides)} />);
}

function button(html: string, label: string): string {
	const found = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/gu)]
		.find(match => match[0].endsWith(`${label}</button>`));
	if (!found) throw new Error(`Missing button: ${label}`);
	return found[0];
}

interface PanelNodeProps {
	children?: ReactNode;
	value?: string;
	readOnly?: boolean;
	disabled?: boolean;
	id?: string;
	"aria-describedby"?: string;
	onChange?: (event: ChangeEvent<HTMLSelectElement>) => void;
	onClick?: () => void;
}

// Existing desktop SSR presentation-tree pattern: hooks run in a real render.
// Handler calls prove wiring/guards, not mounted native-select, focus or SDK behavior.
function capture(overrides: Partial<ForkPanelProps> = {}): ReactNode {
	const captured: { tree: ReactNode } = { tree: null };
	function Harness() {
		captured.tree = ForkPanel(props(overrides));
		return captured.tree;
	}
	renderToStaticMarkup(<Harness />);
	return captured.tree;
}

function nodes(tree: ReactNode, predicate: (element: ReactElement<PanelNodeProps>) => boolean): ReactElement<PanelNodeProps>[] {
	const found: ReactElement<PanelNodeProps>[] = [];
	function visit(children: ReactNode) {
		Children.forEach(children, child => {
			if (!isValidElement<PanelNodeProps>(child)) return;
			if (predicate(child)) found.push(child);
			visit(child.props.children);
		});
	}
	visit(tree);
	return found;
}

function node(tree: ReactNode, predicate: (element: ReactElement<PanelNodeProps>) => boolean): ReactElement<PanelNodeProps> {
	const found = nodes(tree, predicate)[0];
	if (!found) throw new Error("Missing presentation node");
	return found;
}

function change(tree: ReactNode, value: string) {
	const handler = node(tree, element => element.type === "select").props.onChange;
	if (!handler) throw new Error("Missing selection handler");
	handler({ target: { value } } as ChangeEvent<HTMLSelectElement>);
}

function click(tree: ReactNode, label: string) {
	const handler = node(tree, element => element.props.children === label).props.onClick;
	if (!handler) throw new Error(`Missing click handler: ${label}`);
	handler();
}

describe("desktop controlled fork body", () => {
	test("only persisted user entries become numbered native options and duplicate text keeps distinct canonical identities", () => {
		const tree = capture({ selectedEntryId: "entry:second/日本語" });
		const options = nodes(tree, element => element.type === "option");
		expect(options.map(option => option.props.value)).toEqual(["", "entry:first", "entry:second/日本語", "entry:empty"]);
		const html = render({ selectedEntryId: "entry:second/日本語" });
		expect(html).toContain('value="entry:second/日本語" selected=""');
		expect(html).toContain(`1. ${duplicateText}`);
		expect(html).toContain(`2. ${duplicateText}`);
		expect(html).toContain("3. User message without text");
		for (const excluded of ["display-first", "display-second", "display-assistant", "display-unpersisted", "entry:not-user", "Response that cannot be selected", "Message without a persisted entryId"]) {
			expect(html).not.toContain(excluded);
		}
	});

	test("reports canonical selection without branching and forks only via the explicit selected-entry action", () => {
		const selections: string[] = [];
		const forks: Array<string | undefined> = [];
		const callbacks = { onSelect: (entryId: string) => selections.push(entryId), onFork: (entryId?: string) => forks.push(entryId) };
		const tree = capture(callbacks);
		change(tree, "entry:second/日本語");
		expect(selections).toEqual(["entry:second/日本語"]);
		expect(forks).toEqual([]);
		// Selection is owned by the parent: the old render still targets its old ID.
		click(tree, selectedFork);
		click(capture({ ...callbacks, selectedEntryId: "entry:second/日本語" }), selectedFork);
		expect(forks).toEqual(["entry:first", "entry:second/日本語"]);
		change(tree, "");
		for (const invalid of ["display-second", "entry:not-user", "unknown-entry"]) change(tree, invalid);
		expect(selections).toEqual(["entry:second/日本語", ""]);
	});

	test("whole-copy omits entry identity even with a selected message or history not yet loaded", () => {
		const forks: Array<string | undefined> = [];
		for (const value of [history(), null]) {
			click(capture({ history: value, onFork: entryId => forks.push(entryId) }), wholeCopy);
			expect(button(render({ history: value }), wholeCopy)).not.toContain('disabled=""');
		}
		expect(forks).toEqual([undefined, undefined]);
	});

	test("missing, unknown, display-only and non-user selections cannot branch or expose an unrelated preview", () => {
		const forks: Array<string | undefined> = [];
		for (const selectedEntryId of ["", "unknown-entry", "display-first", "entry:not-user"]) {
			const tree = capture({ selectedEntryId, onFork: entryId => forks.push(entryId) });
			expect(button(render({ selectedEntryId }), selectedFork)).toContain('disabled=""');
			expect(node(tree, element => element.type === "textarea").props.value).toBe("");
			expect(node(tree, element => element.type === "select").props.value).toBe("");
			click(tree, selectedFork);
		}
		expect(forks).toEqual([]);
		const emptyText = render({ selectedEntryId: "entry:empty" });
		expect(button(emptyText, selectedFork)).not.toContain('disabled=""');
		click(capture({ selectedEntryId: "entry:empty", onFork: entryId => forks.push(entryId) }), selectedFork);
		expect(forks).toEqual(["entry:empty"]);
	});

	test("read-only preview preserves inert text and explicitly associates truncation without treating display text as the fork payload", () => {
		const text = '<script>alert("fixture")</script>\n  日本語 / 中文\n';
		const value = history({ messages: [{ id: "display-truncated", entryId: "entry:truncated", role: "user", text, truncated: true }] });
		const forks: Array<string | undefined> = [];
		const tree = capture({ history: value, selectedEntryId: "entry:truncated", onFork: entryId => forks.push(entryId) });
		const preview = node(tree, element => element.type === "textarea");
		expect(preview.props.value).toBe(text);
		expect(preview.props.readOnly).toBe(true);
		expect(preview.props.disabled).not.toBe(true);
		expect(preview.props.onChange).toBeUndefined();
		const notice = node(tree, element => element.props.id === preview.props["aria-describedby"]);
		expect(notice.type).toBe("p");
		const html = render({ history: value, selectedEntryId: "entry:truncated" });
		expect(html).toContain("the displayed text is not the complete original");
		expect(html).toContain("original selected text returned by the SDK");
		expect(html).toContain("&lt;script&gt;alert(&quot;fixture&quot;)&lt;/script&gt;\n  日本語 / 中文\n");
		expect(html).not.toContain("<script");
		click(tree, selectedFork);
		expect(forks).toEqual(["entry:truncated"]);
		expect(render()).not.toContain("the displayed text is not the complete original");
	});

	test("pending and disconnected guard every action and selection but leave the selected preview inspectable", () => {
		for (const state of [{ pending: true }, { disabled: true }]) {
			const calls: string[] = [];
			const options = {
				...state,
				history: history({ truncated: true }),
				onSelect: (entryId: string) => calls.push(entryId),
				onFork: (entryId?: string) => calls.push(entryId ?? "whole"),
				onLoadMore: () => calls.push("load"),
			};
			const html = render(options);
			for (const label of [wholeCopy, selectedFork, loadMore]) expect(button(html, label)).toContain('disabled=""');
			expect(html.match(/<select\b[^>]*>/u)?.[0]).toContain('disabled=""');
			expect(html.match(/<textarea\b[^>]*>/u)?.[0]).not.toContain('disabled=""');
			const tree = capture(options);
			expect(node(tree, element => element.type === "textarea").props.value).toBe(duplicateText);
			change(tree, "entry:second/日本語");
			for (const label of [wholeCopy, selectedFork, loadMore]) click(tree, label);
			expect(calls).toEqual([]);
		}
	});

	test("pagination is explicit and controlled while loading/errors and empty results stay distinct", () => {
		let loads = 0;
		const value = history({ truncated: true });
		const tree = capture({ history: value, onLoadMore: () => { loads++; } });
		click(tree, loadMore);
		expect(loads).toBe(1);
		expect(render({ history: value })).toContain(loadMore);
		expect(render()).not.toContain(loadMore);
		const empty = render({ history: history({ total: 0, messages: [] }), selectedEntryId: "" });
		expect(empty).toContain("The loaded history has no user messages to fork from.");
		expect(button(empty, selectedFork)).toContain('disabled=""');
		const loading = render({ history: null, selectedEntryId: "" });
		expect(loading).not.toContain("no user messages to fork from");
		expect(loading).not.toContain("Loading");
		expect(loading).not.toContain('role="alert"');
		expect(loading).not.toContain("<dialog");
	});

	test("multiple bodies keep select and preview label associations unique", () => {
		const html = renderToStaticMarkup(<><ForkPanel {...props()} /><ForkPanel {...props()} /></>);
		const labels = [...html.matchAll(/<label for="([^"]+)">([^<]+)<\/label>/gu)];
		expect(labels.map(match => match[2])).toEqual([
			"User message to fork from", "Selected message preview (read only)",
			"User message to fork from", "Selected message preview (read only)",
		]);
		expect(new Set(labels.map(match => match[1])).size).toBe(4);
		for (const match of labels) expect(html).toContain(`id="${match[1]}"`);
	});
});
