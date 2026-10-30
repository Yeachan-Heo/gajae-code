import { describe, expect, test } from "bun:test";
import { Children, isValidElement } from "react";
import type { ChangeEvent, FormEvent, ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopOperatorOperation, DesktopOperatorStatus } from "../../desktop-host/src/operator-protocol";
import { OperatorPanel, type OperatorPanelProps } from "../src/OperatorPanel";

function operation(overrides: Partial<DesktopOperatorOperation> = {}): DesktopOperatorOperation {
	return {
		operationId: "opaque:!/$ <&> ?=29\nend",
		connectionGeneration: "connection-fixture",
		sessionGeneration: 17,
		kind: "bash",
		excludeFromContext: false,
		status: "running",
		output: "Actual host output\nsecond line",
		outputTruncated: false,
		liveOutput: "redacted",
		...overrides,
	};
}

function props(overrides: Partial<OperatorPanelProps> = {}): OperatorPanelProps {
	return {
		value: "!! printf 'hello'\n  printf 'next'\n",
		operation: null,
		onChange: () => { throw new Error("Rendering must not change a draft"); },
		onExecute: () => { throw new Error("Rendering must not execute"); },
		onAbort: () => { throw new Error("Rendering must not cancel"); },
		onFold: () => { throw new Error("Rendering must not fold a tool"); },
		onRefresh: () => { throw new Error("Rendering must not refresh"); },
		...overrides,
	};
}

function render(overrides: Partial<OperatorPanelProps> = {}): string {
	return renderToStaticMarkup(<OperatorPanel {...props(overrides)} />);
}

function button(html: string, label: string): string {
	const result = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/gu)]
		.find(match => match[0].endsWith(`${label}</button>`));
	if (!result) throw new Error(`Missing button: ${label}`);
	return result[0];
}

interface PanelNodeProps {
	children?: ReactNode;
	type?: string;
	onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
	onChange?: (event: ChangeEvent<HTMLTextAreaElement>) => void;
	onClick?: () => void;
}

// Capture the presentation tree inside a real SSR render (including useId).
// Invoking these handlers tests callback wiring only, not mounted DOM or SDK behavior.
function capture(overrides: Partial<OperatorPanelProps>): ReactNode {
	const captured: { tree: ReactNode } = { tree: null };
	function Harness() {
		captured.tree = OperatorPanel(props(overrides));
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

function click(tree: ReactNode, label: string) {
	const handler = node(tree, element => element.props.children === label).props.onClick;
	if (!handler) throw new Error(`Missing click handler: ${label}`);
	handler();
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

describe("desktop operator panel presentation", () => {
	test("labels a multiline draft, explains all prefixes and never executes during SSR", () => {
		const html = render();
		expect(html).toMatch(/<label for="[^"]+">Shell command \/ Python code<\/label>/u);
		expect(html).toMatch(/<textarea[^>]*aria-describedby="[^"]+"[^>]*rows="3"/u);
		expect(html).toContain("!! printf &#x27;hello&#x27;\n  printf &#x27;next&#x27;\n");
		expect(html).toContain("<code>!</code> shell");
		expect(html).toContain("<code>!!</code> shell (excluded from model context)");
		expect(html).toContain("<code>$</code> Python");
		expect(html).toContain("<code>$$</code> Python (excluded from model context)");
		expect(html).toContain("Enter inserts a line break; submit only with the run button.");
		expect(html).toContain("This is not a message to the model.");
		expect(html).toContain("No run information has been received yet.");
		expect(html).not.toContain("succeeded");
		expect(html).not.toContain("onkeydown");
		expect(button(html, "Run")).toContain('type="submit"');
		expect(button(html, "Run")).not.toContain('disabled=""');
	});

	test("preserves every exact operator string and only submits through the explicit form handler", () => {
		for (const text of ["! echo a\n echo b\n", "!!  printf '!$'  ", "$ print('hello')\n", "$$ x = 1\nprint(x)\n"]) {
			const changes: string[] = [];
			const executions: string[] = [];
			const tree = capture({ value: text, onChange: value => changes.push(value), onExecute: value => executions.push(value) });
			expect(executions).toEqual([]);
			change(tree, text);
			expect(changes).toEqual([text]);
			expect(executions).toEqual([]);
			expect(submit(tree)).toBe(true);
			expect(executions).toEqual([text]);
		}
	});

	test("addresses abort and read refresh with the exact opaque operation ID and keeps fold separate", () => {
		const value = operation();
		const aborts: string[] = [];
		const reads: string[] = [];
		let folds = 0;
		const tree = capture({ operation: value, onAbort: id => aborts.push(id), onRefresh: id => reads.push(id), onFold: () => { folds++; } });
		click(tree, "Request cancellation");
		click(tree, "Refresh run details");
		click(tree, "Fold the current foreground tool");
		expect(aborts).toEqual([value.operationId]);
		expect(reads).toEqual([value.operationId]);
		expect(folds).toBe(1);
		const html = render({ operation: value });
		expect(html).toContain("opaque:!/$ &lt;&amp;&gt; ?=29\nend");
		expect(html).toContain("current foreground tool");
		expect(html).toContain("It does not fold shell commands you ran directly with ! or !!.");
		expect(button(html, "Run")).toContain('disabled=""');
		for (const label of ["Request cancellation", "Refresh run details", "Fold the current foreground tool"]) {
			expect(button(html, label)).not.toContain('disabled=""');
			expect(button(html, label)).toContain('type="button"');
		}
	});

	test("blocks all mutations and read requests while pending or disabled without clearing draft/output", () => {
		for (const state of [{ pending: true }, { disabled: true }]) {
			const overrides = { operation: operation(), ...state };
			const html = render(overrides);
			for (const label of ["Run", "Request cancellation", "Refresh run details", "Fold the current foreground tool"]) {
				expect(button(html, label)).toContain('disabled=""');
			}
			expect(html).toMatch(/<textarea[^>]*disabled=""/u);
			expect(html).toContain("Actual host output");
			expect(html).toContain("!! printf");
			const tree = capture(overrides);
			expect(submit(tree)).toBe(true);
			change(tree, "! must not change");
			click(tree, "Request cancellation");
			click(tree, "Refresh run details");
			click(tree, "Fold the current foreground tool");
		}
		expect(render({ pending: true })).toContain('aria-busy="true"');
		expect(render({ pending: true })).toContain("This does not mean the run finished.");
		expect(render({ disabled: true })).toContain("Controls are unavailable on the current connection or session.");
		for (const value of ["", " \n\t"]) {
			expect(button(render({ value }), "Run")).toContain('disabled=""');
			expect(submit(capture({ value }))).toBe(true);
		}
	});

	test("busy blocks only new execution while preserving editing, abort, detail and foreground-tool fold", () => {
		for (const value of [null, operation(), operation({ status: "completed", exitCode: 0 })]) {
			const overrides = { busy: true, operation: value };
			const html = render(overrides);
			expect(button(html, "Run")).toContain('disabled=""');
			expect(button(html, "Fold the current foreground tool")).not.toContain('disabled=""');
			expect(html).not.toMatch(/<textarea[^>]*disabled=""/u);
			expect(html).toContain('aria-busy="false"');
			if (value?.status === "running") {
				expect(button(html, "Request cancellation")).not.toContain('disabled=""');
				expect(html).not.toContain("Another session is working or waiting for input");
			} else {
				expect(html).toContain("Another session is working or waiting for input, so a new direct run cannot start. Tool folding and run detail reads are separate controls.");
			}
			if (value) expect(button(html, "Refresh run details")).not.toContain('disabled=""');
			const changes: string[] = [];
			const aborts: string[] = [];
			const reads: string[] = [];
			let folds = 0;
			const tree = capture({ ...overrides, onChange: text => changes.push(text), onAbort: id => aborts.push(id), onRefresh: id => reads.push(id), onFold: () => { folds++; } });
			expect(submit(tree)).toBe(true);
			change(tree, "$$ print('preserved')\n");
			click(tree, "Fold the current foreground tool");
			if (value) {
				click(tree, "Refresh run details");
				click(tree, "Request cancellation");
			}
			expect(changes).toEqual(["$$ print('preserved')\n"]);
			expect(folds).toBe(1);
			expect(reads).toEqual(value ? [value.operationId] : []);
			expect(aborts).toEqual(value?.status === "running" ? [value.operationId] : []);
		}
		for (const state of [{ pending: true }, { disabled: true }]) {
			const html = render({ busy: true, operation: operation(), ...state });
			for (const label of ["Run", "Request cancellation", "Refresh run details", "Fold the current foreground tool"]) {
				expect(button(html, label)).toContain('disabled=""');
			}
		}
	});

	test("keeps cancel_requested distinct from cancelled and only offers abort for running", () => {
		const states: DesktopOperatorStatus[] = ["cancel_requested", "completed", "cancelled", "failed"];
		for (const status of states) {
			const html = render({ operation: operation({ status }) });
			expect(html).toContain(`data-status="${status}"`);
			expect(html).toContain(`(${status})`);
			expect(button(html, "Request cancellation")).toContain('disabled=""');
			expect(button(html, "Refresh run details")).not.toContain('disabled=""');
			expect(button(html, "Fold the current foreground tool")).not.toContain('disabled=""');
			click(capture({ operation: operation({ status }) }), "Request cancellation");
			if (status === "cancel_requested") {
				expect(button(html, "Run")).toContain('disabled=""');
				expect(html).toContain("Cancellation requested · Exit not confirmed");
				expect(html).not.toContain("Cancelled");
				expect(submit(capture({ operation: operation({ status }) }))).toBe(true);
			} else {
				expect(button(html, "Run")).not.toContain('disabled=""');
				const executions: string[] = [];
				const reads: string[] = [];
				const value = operation({ status });
				const tree = capture({ operation: value, onExecute: text => executions.push(text), onRefresh: id => reads.push(id) });
				expect(submit(tree)).toBe(true);
				click(tree, "Refresh run details");
				expect(executions).toEqual([props().value]);
				expect(reads).toEqual([value.operationId]);
			}
			expect(html).not.toContain("Resource cleanup complete");
		}
	});

	test("preserves explicit cancellation despite its nonzero exit or termination signal", () => {
		for (const result of [{ exitCode: 130 }, { signal: "SIGTERM" }, { exitCode: 137, signal: "SIGKILL" }]) {
			const html = render({ operation: operation({ status: "cancelled", ...result }) });
			expect(html).toContain("Cancelled (cancelled)");
			expect(html).not.toContain('data-failed="true"');
			expect(html).not.toContain(" · Failed");
			expect(html).not.toContain("succeeded");
			if (result.exitCode !== undefined) expect(html).toContain(`<dt>Exit code</dt><dd>${result.exitCode}</dd>`);
			if (result.signal !== undefined) expect(html).toContain(`<dt>Exit signal</dt><dd>${result.signal}</dd>`);
		}
		const error = render({ operation: operation({ status: "cancelled", exitCode: 130, error: { code: "redaction_failed", message: "Output redaction failed" } }) });
		expect(error).toContain("Cancelled (cancelled)");
		expect(error).toContain("redaction_failed: Output redaction failed");
		expect(error).toContain('role="alert"');
	});

	test("never presents a completed nonzero exit, signal or operation error as success", () => {
		const nonzero = render({ operation: operation({ status: "completed", exitCode: 7 }) });
		expect(nonzero).toContain("Run ended (completed) · Failed");
		expect(nonzero).toContain("<dt>Exit code</dt><dd>7</dd>");
		expect(nonzero).toContain('data-failed="true"');
		const signal = render({ operation: operation({ status: "completed", signal: "SIGTERM" }) });
		expect(signal).toContain("<dt>Exit signal</dt><dd>SIGTERM</dd>");
		expect(signal).toContain('data-failed="true"');
		const error = render({ operation: operation({ status: "failed", error: { code: "backend_failure", message: "Actual SDK error" } }), error: "Detail read failed" });
		expect(error).toContain("backend_failure: Actual SDK error");
		expect(error).toContain("Detail read failed");
		expect(error.match(/role="alert"/gu)).toHaveLength(2);
		for (const html of [nonzero, signal, error, render({ operation: operation({ status: "completed", output: "", exitCode: 0 }) }), render({ operation: operation({ status: "completed", output: "" }) })]) {
			expect(html).not.toContain("succeeded");
			expect(html).not.toContain("Run succeeded");
		}
		expect(render({ operation: operation({ status: "completed" }) })).toContain("<dt>Exit code</dt><dd>Not provided</dd>");
	});

	test("distinguishes withheld status-only updates from redacted output and allows actual final output", () => {
		for (const status of ["running", "cancel_requested"] as const) {
			const html = render({ operation: operation({ status, liveOutput: "withheld", output: "must remain withheld" }) });
			expect(html).toContain("Live output withheld · Receiving status only.");
			expect(html).toContain("No output content is shown right now.");
			expect(html).not.toContain("must remain withheld");
			expect(html).not.toContain("<pre");
		}
		const final = render({ operation: operation({ status: "completed", liveOutput: "withheld", output: "Actual final result", exitCode: 0 }) });
		expect(final).toContain("Live output was withheld.");
		expect(final).toContain("Actual final result</pre>");
		const redacted = render({ operation: operation({ output: "token=[REDACTED]" }) });
		expect(redacted).toContain("This output is redacted");
		expect(redacted).toContain("token=[REDACTED]</pre>");
		const empty = render({ operation: operation({ output: "" }) });
		expect(empty).toContain("No output was provided. Status information is not output.");
		expect(empty).not.toContain("<pre");
	});

	test("renders bounded inert output, host truncation and actual context exclusion without HTML interpretation", () => {
		const hostile = '<script>alert(1)</script><img src=x onerror="alert(2)">';
		const html = render({ operation: operation({ kind: "python", excludeFromContext: true, output: hostile, outputTruncated: true }) });
		expect(html).toContain("Python · Running");
		expect(html).toContain("Excluded from model context</p>");
		expect(html).toContain('class="bounded-output operator-output"');
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&lt;img");
		expect(html).not.toContain("<script");
		expect(html).not.toContain("<img");
		expect(html).toContain("The shown output is not complete.");
		expect(render({ operation: operation() })).toContain("Included in model context</p>");
		const bounded = render({ operation: operation({ output: `omitted prefix${"x".repeat(20_000)}tail` }) });
		expect(bounded).not.toContain("omitted prefix");
		expect(bounded).not.toContain("x".repeat(16_385));
		expect(bounded).toContain("tail</pre>");
		expect(bounded).toContain("Some content is omitted because of the output limit.");
	});
});
