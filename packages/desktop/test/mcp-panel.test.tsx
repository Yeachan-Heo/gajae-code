import { describe, expect, test } from "bun:test";
import { Children, isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopMcpAction, DesktopMcpRef, DesktopMcpServer, DesktopMcpSnapshot } from "../../desktop-host/src/mcp-protocol";
import { McpPanel, type McpPanelProps } from "../src/McpPanel";

function server(overrides: Partial<DesktopMcpServer> = {}): DesktopMcpServer {
	return {
		ref: { key: "opaque:!/$ <&> ?=29\nend", connectionGeneration: "connection-private", sessionGeneration: 17 },
		label: "MCP server 1",
		state: "connected",
		transport: "stdio",
		sharing: "shared",
		toolCount: 7,
		controls: ["suspend", "reconnect"],
		...overrides,
	};
}

function snapshot(overrides: Partial<DesktopMcpSnapshot> = {}): DesktopMcpSnapshot {
	return {
		connectionGeneration: "connection-private",
		sessionGeneration: 17,
		available: true,
		scope: "factory_manager_may_be_shared",
		servers: [server()],
		truncated: false,
		...overrides,
	};
}

function props(overrides: Partial<McpPanelProps> = {}): McpPanelProps {
	return {
		snapshot: snapshot(),
		onRefresh: () => { throw new Error("Rendering must not read manager state"); },
		onOperate: () => { throw new Error("Rendering must not mutate manager state"); },
		...overrides,
	};
}

function render(overrides: Partial<McpPanelProps> = {}): string {
	return renderToStaticMarkup(<McpPanel {...props(overrides)} />);
}

function buttons(html: string): string[] {
	return html.match(/<button\b[^>]*>[\s\S]*?<\/button>/gu) ?? [];
}

function button(html: string, label: string): string {
	const result = buttons(html).find(value => value.endsWith(`${label}</button>`));
	if (!result) throw new Error(`Missing button: ${label}`);
	return result;
}

interface PanelNodeProps {
	children?: ReactNode;
	onClick?: () => void;
}

// These captured handlers prove presentation callback wiring only, not mounted
// DOM interaction, IPC delivery, SDK effects, or remote/resource settlement.
function capture(overrides: Partial<McpPanelProps>): ReactNode {
	const captured: { tree: ReactNode } = { tree: null };
	function Harness() {
		captured.tree = McpPanel(props(overrides));
		return captured.tree;
	}
	renderToStaticMarkup(<Harness />);
	return captured.tree;
}

function click(tree: ReactNode, label: string) {
	let target: ReactElement<PanelNodeProps> | undefined;
	function visit(children: ReactNode) {
		Children.forEach(children, child => {
			if (target || !isValidElement<PanelNodeProps>(child)) return;
			if (child.props.children === label && child.props.onClick) target = child;
			else visit(child.props.children);
		});
	}
	visit(tree);
	if (!target?.props.onClick) throw new Error(`Missing handler: ${label}`);
	target.props.onClick();
}

describe("desktop MCP manager presentation", () => {
	test("renders each actual manager state, transport, sharing and tool count without inventing controls", () => {
		const cases: { state: DesktopMcpServer["state"]; label: string; transport: DesktopMcpServer["transport"]; sharing: DesktopMcpServer["sharing"]; sharingLabel: string }[] = [
			{ state: "connected", label: "Manager connected", transport: "stdio", sharing: "shared", sharingLabel: "Shared" },
			{ state: "connecting", label: "Manager connecting", transport: "http", sharing: "per-session", sharingLabel: "Per session" },
			{ state: "disconnected", label: "Manager disconnected", transport: "sse", sharing: "unknown", sharingLabel: "Unknown" },
			{ state: "suspended", label: "Manager suspended", transport: "unknown", sharing: "shared", sharingLabel: "Shared" },
			{ state: "unknown", label: "Unknown", transport: "unknown", sharing: "unknown", sharingLabel: "Unknown" },
		];
		for (const [index, value] of cases.entries()) {
			const html = render({ snapshot: snapshot({ servers: [server({ ...value, toolCount: index, controls: [] })] }) });
			expect(html).toContain(`data-state="${value.state}"`);
			expect(html).toContain(`<dt>Manager state</dt><dd>${value.label}</dd>`);
			expect(html).not.toContain(`(${value.state})`);
			expect(html).toContain(`<dt>Transport</dt><dd>${value.transport === "unknown" ? "Unknown" : value.transport}</dd>`);
			expect(html).toContain(`<dt>Sharing</dt><dd>${value.sharingLabel}</dd>`);
			expect(html).not.toContain(`(${value.sharing})`);
			expect(html).toContain(`<dt>Manager tool count</dt><dd>${index}</dd>`);
			expect(html).toContain("No controls provided · Read only");
			expect(buttons(html)).toHaveLength(1);
		}
	});

	test("uses only advertised actions even when state would suggest different capabilities", () => {
		for (const [action, label] of [["suspend", "Pause connection"], ["resume", "Resume connection"], ["reconnect", "Reconnect"]] as const) {
			const html = render({ snapshot: snapshot({ servers: [server({ state: "connected", controls: [action] })] }) });
			expect(buttons(html)).toHaveLength(2);
			expect(button(html, label)).not.toContain('disabled=""');
			expect(html).not.toContain("No controls provided");
		}
		const html = render();
		expect(buttons(html)).toHaveLength(3);
		expect(button(html, "Pause connection")).not.toContain('disabled=""');
		expect(button(html, "Reconnect")).not.toContain('disabled=""');
		expect(html).not.toMatch(/>Resume connection<\/button>/u);
		expect(html).not.toMatch(/>(?:Delete|Terminate remote session|Change settings|Synchronize tools)<\/button>/u);
	});

	test("passes the exact original reference object and advertised action without rewriting opaque identifiers", () => {
		const ref = server().ref;
		const calls: { ref: DesktopMcpRef; action: DesktopMcpAction }[] = [];
		const tree = capture({
			snapshot: snapshot({ servers: [server({ ref, controls: ["resume"] })] }),
			onOperate: (value, action) => calls.push({ ref: value, action }),
		});
		expect(calls).toEqual([]);
		click(tree, "Resume connection");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.ref).toBe(ref);
		expect(calls[0]?.action).toBe("resume");
	});

	test("busy blocks mutations but leaves read refresh and manager information available", () => {
		const html = render({ busy: true });
		expect(button(html, "Pause connection")).toContain('disabled=""');
		expect(button(html, "Reconnect")).toContain('disabled=""');
		expect(button(html, "Refresh status")).not.toContain('disabled=""');
		expect(html).toContain("Manager tool count</dt><dd>7");
		expect(html).toContain("Status reads are separate");
		let reads = 0;
		const tree = capture({ busy: true, onRefresh: () => { reads++; } });
		click(tree, "Pause connection");
		click(tree, "Reconnect");
		click(tree, "Refresh status");
		expect(reads).toBe(1);
	});

	test("pending locks callbacks and labels retained data as last received rather than current or successful", () => {
		const html = render({ pending: true });
		expect(html).toContain('aria-busy="true"');
		expect(html).toContain("Waiting for the connection or a request");
		expect(html).toContain("The manager information below is the last received and does not certify the current state.");
		expect(buttons(html)).toHaveLength(3);
		for (const value of buttons(html)) expect(value).toContain('disabled=""');
		const tree = capture({ pending: true });
		for (const label of ["Refresh status", "Pause connection", "Reconnect"]) click(tree, label);
		expect(html).not.toContain("Change completed");
	});

	test("distinguishes missing, unavailable and available empty snapshots, with refresh still possible", () => {
		const missing = render({ snapshot: null });
		expect(missing).toContain("No MCP manager information was received.");
		expect(missing).toContain("This does not mean no servers are connected.");
		const unavailable = render({ snapshot: snapshot({ available: false, error: { code: "unavailable", message: "Captured manager unavailable" } }) });
		expect(unavailable).toContain("The captured MCP manager cannot be queried or controlled.");
		expect(unavailable).toContain("unavailable:");
		expect(unavailable).toContain("Captured manager unavailable");
		expect(unavailable).not.toContain("MCP server 1");
		const empty = render({ snapshot: snapshot({ servers: [] }) });
		expect(empty).toContain("No servers are shown in the received manager list.");
		expect(empty).toContain("Servers shown: 0");
		for (const html of [missing, unavailable, empty]) {
			expect(buttons(html)).toHaveLength(1);
			expect(button(html, "Refresh status")).not.toContain('disabled=""');
		}
		let reads = 0;
		click(capture({ snapshot: null, onRefresh: () => { reads++; } }), "Refresh status");
		expect(reads).toBe(1);
	});

	test("qualifies manager scope and unknown effects without certifying remote cleanup or registry synchronization", () => {
		const html = render({
			error: "Operation result not received",
			snapshot: snapshot({ error: { code: "unknown_effect", message: "Completion was not proven" } }),
		});
		expect(html.match(/role="alert"/gu)).toHaveLength(2);
		expect(html).toContain("Operation result not received");
		expect(html).toContain("unknown_effect:");
		expect(html).toContain("Completion was not proven");
		expect(html).toContain("The effect of the change was not confirmed. Refresh the status before retrying.");
		expect(html).toContain("factory manager captured when the session was created");
		expect(html).toContain("may be shared with other sessions");
		expect(html).toContain("Connected, resumed and reconnected mean only the manager connection and its tool catalog.");
		expect(html).toContain("They do not guarantee remote session termination, resource settlement or cleanup, or session tool registry synchronization.");
		expect(html).toContain("Cleanup is not certified.");
		expect(html).not.toContain("not_certified");
		expect(html).not.toContain("Success");
		expect(html).not.toContain("Resource cleanup completed");
		const failed = render({ snapshot: snapshot({ error: { code: "backend_failure", message: "SDK operation failed" } }) });
		expect(failed).toContain("SDK operation failed");
		expect(failed).toContain("The effect of the change was not confirmed.");
	});

	test("bounds server lists and label text, preserves host truncation and does not split surrogate pairs", () => {
		const long = render({ snapshot: snapshot({ servers: [server({ label: `${"日".repeat(127)}😀private-tail` })], truncated: true }) });
		expect(long).toContain("日".repeat(127));
		expect(long).not.toContain("😀");
		expect(long).not.toContain("\uD83D");
		expect(long).not.toContain("private-tail");
		expect(long).toContain("content truncated");
		expect(long).toContain("The displayed count is not the total number of servers.");
		const many = render({ snapshot: snapshot({ servers: Array.from({ length: 101 }, (_, index) => server({
			ref: { key: `opaque-${index}`, connectionGeneration: "connection-private", sessionGeneration: 17 },
			label: `Limited server ${index}`,
			controls: [],
		})) }) });
		expect(many.match(/class="mcp-server"/gu)).toHaveLength(100);
		expect(many).toContain("Servers shown: 100");
		expect(many).toContain("Limited server 99");
		expect(many).not.toContain("Limited server 100");
		expect(many).toContain("Some servers were omitted by the display limit.");
		expect(render()).not.toContain("Some servers were omitted by the display limit.");
	});

	test("renders strings inertly and never exposes refs, SDK targets or extra configuration fields", () => {
		const hostile = '<script>alert(1)</script><img src="https://invalid.test/private" onerror="alert(2)">';
		const extra = {
			...server({ label: hostile }),
			target: { binding: "private-binding", name: "private-configured-name" },
			config: { endpoint: "https://secret.example/api", token: "private-token" },
		};
		const html = render({ snapshot: snapshot({ servers: [extra] }), error: hostile });
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&lt;img");
		expect(html).not.toContain("<script");
		expect(html).not.toContain("<img");
		expect(html).not.toContain("<a ");
		expect(html).not.toContain("<iframe");
		for (const secret of ["opaque:", "connection-private", "sessionGeneration", "private-binding", "private-configured-name", "https://secret.example/api", "private-token"]) {
			expect(html).not.toContain(secret);
		}
		expect(html).toContain("Original configuration, addresses and credentials are not shown.");
		const boundedError = render({ error: `${"x".repeat(1024)}private-error-tail` });
		expect(boundedError).not.toContain("private-error-tail");
		expect(boundedError).toContain("content truncated");
	});
});
