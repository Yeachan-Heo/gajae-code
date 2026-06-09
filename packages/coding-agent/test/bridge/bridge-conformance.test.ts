import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { BRIDGE_CLIENT_COMMAND_TYPES } from "../../../bridge-client/src/commands";
import { createBridgeFetchHandler } from "../../src/modes/bridge/bridge-mode";
import { BridgeExtensionUIContext, type BridgeUiRequestPayload } from "../../src/modes/bridge/bridge-ui-context";
import { BridgeEventStream } from "../../src/modes/bridge/event-stream";
import { AGENT_SESSION_EVENT_TYPES, BRIDGE_PROTOCOL_VERSION } from "../../src/modes/shared/agent-wire/protocol";
import {
	BRIDGE_COMMAND_SCOPES,
	MANDATORY_FLOOR_COMMAND_SCOPES,
	RPC_COMMAND_TYPES,
	scopeForRpcCommand,
} from "../../src/modes/shared/agent-wire/scopes";
import { UiRequestBroker } from "../../src/modes/shared/agent-wire/ui-request-broker";
import type { uiUnsupported } from "../../src/modes/shared/agent-wire/ui-result";

describe("bridge protocol conformance", () => {
	it("AC-1/AC-9: has a finite full-surface event and command catalog", () => {
		expect(AGENT_SESSION_EVENT_TYPES).toContain("agent_start");
		expect(AGENT_SESSION_EVENT_TYPES).toContain("message_update");
		expect(AGENT_SESSION_EVENT_TYPES).toContain("goal_updated");
		expect(new Set(AGENT_SESSION_EVENT_TYPES).size).toBe(AGENT_SESSION_EVENT_TYPES.length);
		expect(RPC_COMMAND_TYPES).toContain("prompt");
		expect(RPC_COMMAND_TYPES).toContain("bash");
		expect(RPC_COMMAND_TYPES).toContain("login");
		expect(new Set(RPC_COMMAND_TYPES).size).toBe(RPC_COMMAND_TYPES.length);
		expect([...BRIDGE_CLIENT_COMMAND_TYPES].sort()).toEqual([...RPC_COMMAND_TYPES].sort());
	});

	it("AC-3/AC-6: REST commands require auth, scopes, and idempotency", async () => {
		let calls = 0;
		const handle = createBridgeFetchHandler({
			sessionId: "sess-1",
			token: "secret",
			commandScopes: ["prompt"],
			endpointMatrix: { commands: true },
			idempotencyCache: new Map(),
			commandDispatcher: async command => {
				calls += 1;
				return { id: command.id, type: "response", command: "prompt", success: true };
			},
		});
		const endpoint = "https://bridge.test/v1/sessions/sess-1/commands";
		expect(
			(
				await handle(
					new Request(endpoint, {
						method: "POST",
						body: JSON.stringify({ id: "1", type: "prompt", message: "hi" }),
					}),
				)
			).status,
		).toBe(401);
		expect(
			(
				await handle(
					new Request(endpoint, {
						method: "POST",
						headers: { Authorization: "Bearer secret" },
						body: JSON.stringify({ id: "2", type: "bash", command: "echo hi" }),
					}),
				)
			).status,
		).toBe(403);
		const request = () =>
			new Request(endpoint, {
				method: "POST",
				headers: { Authorization: "Bearer secret", "Idempotency-Key": "idem" },
				body: JSON.stringify({ id: "3", type: "prompt", message: "hi" }),
			});
		expect((await handle(request())).status).toBe(200);
		expect((await handle(request())).status).toBe(200);
		expect(calls).toBe(1);
	});

	it("AC-4/AC-5: distinguishes core elicitation from unsupported local-only UI", async () => {
		const emitted: BridgeUiRequestPayload[] = [];
		const broker = new UiRequestBroker<BridgeUiRequestPayload, ReturnType<typeof uiUnsupported>>({
			emitRequest: (_id, request) => emitted.push(request),
		});
		const ui = new BridgeExtensionUIContext({ broker: broker as never, emit: payload => emitted.push(payload) });
		void ui.select("Pick", ["A"]);
		ui.setWidget("local", (() => ({ render: () => [], invalidate: () => {} })) as never);
		expect(emitted[0]).toEqual({ kind: "select", title: "Pick", options: ["A"], timeout: undefined });
		expect(emitted[1]).toEqual({
			kind: "unsupported",
			capability: "ui.widget.component",
			reason: "Component factory widgets are local-only and not serializable",
		});
	});

	it("AC-7: event stream frames carry protocol version, session_id, and seq", async () => {
		const stream = new BridgeEventStream();
		stream.publish({
			protocol_version: BRIDGE_PROTOCOL_VERSION,
			session_id: "sess-1",
			seq: 7,
			frame_id: "frame-7",
			type: "event",
			payload: { event_type: "agent_start", event: { type: "agent_start" } },
		});
		const response = stream.response(0);
		const reader = response.body?.getReader();
		if (!reader) throw new Error("missing stream body");
		const chunk = await reader.read();
		await reader.cancel();
		const text = new TextDecoder().decode(chunk.value);
		expect(text).toContain('"protocol_version":2');
		expect(text).toContain('"session_id":"sess-1"');
		expect(text).toContain('"seq":7');
	});

	it("compliance floor remains events + prompt", () => {
		expect(MANDATORY_FLOOR_COMMAND_SCOPES).toEqual(["prompt"]);
	});
});
const REPO_ROOT = join(import.meta.dir, "../../../..");

async function readDoc(relativePath: string): Promise<string> {
	return Bun.file(join(REPO_ROOT, relativePath)).text();
}

// Candidate capability list requested at handshake to observe the server's
// negotiated capability set. This is test/maintenance context, not the public
// contract: the assertions below are grounded in handler-observed handshake
// values (accepted_capabilities + frame_types).
const CANDIDATE_CAPABILITIES = [
	"events",
	"prompt",
	"permission",
	"elicitation",
	"ui.declarative",
	"host_tools",
	"host_uri",
];

async function observeHandshake(): Promise<{ accepted_capabilities: string[]; frame_types: string[] }> {
	const handle = createBridgeFetchHandler({
		sessionId: "sess-1",
		token: "secret",
		commandScopes: BRIDGE_COMMAND_SCOPES,
		endpointMatrix: { events: true, commands: true },
	});
	const response = await handle(
		new Request("https://bridge.test/v1/handshake", {
			method: "POST",
			headers: { Authorization: "Bearer secret" },
			body: JSON.stringify({
				protocol_version_range: { min: 1, max: 2 },
				capabilities: CANDIDATE_CAPABILITIES,
				requested_scopes: [...BRIDGE_COMMAND_SCOPES],
			}),
		}),
	);
	return (await response.json()) as { accepted_capabilities: string[]; frame_types: string[] };
}

describe("bridge docs conformance (anti-drift)", () => {
	it("docs/bridge.md cites protocol version, experimental status, and handshake", async () => {
		const doc = await readDoc("docs/bridge.md");
		expect(doc).toContain(`BRIDGE_PROTOCOL_VERSION`);
		expect(doc).toContain(String(BRIDGE_PROTOCOL_VERSION));
		expect(doc.toLowerCase()).toContain("experimental");
		expect(doc).toContain("/v1/handshake");
	});

	it("docs/bridge.md documents every command type and scope, plus the prompt floor", async () => {
		const doc = await readDoc("docs/bridge.md");
		for (const command of RPC_COMMAND_TYPES) {
			// Assert the exact catalog row `| `command` | `scope` |` so a row removal or a
			// wrong scope mapping is caught even for short/duplicated tokens (e.g. `prompt`).
			expect(doc).toContain(`| \`${command}\` | \`${scopeForRpcCommand(command)}\` |`);
		}
		for (const scope of BRIDGE_COMMAND_SCOPES) {
			expect(doc).toContain(`\`${scope}\``);
		}
		expect(doc).toContain(MANDATORY_FLOOR_COMMAND_SCOPES[0] as string);
		expect(doc.toLowerCase()).toContain("floor");
	});

	it("docs/environment-variables.md documents the GJC_BRIDGE vars and scopes", async () => {
		const doc = await readDoc("docs/environment-variables.md");
		for (const variable of [
			"GJC_BRIDGE_TOKEN",
			"GJC_BRIDGE_TLS_CERT",
			"GJC_BRIDGE_TLS_KEY",
			"GJC_BRIDGE_HOST",
			"GJC_BRIDGE_PORT",
			"GJC_BRIDGE_SCOPES",
		]) {
			expect(doc).toContain(variable);
		}
		for (const scope of BRIDGE_COMMAND_SCOPES) {
			expect(doc).toContain(`\`${scope}\``);
		}
	});

	it("docs/bridge.md documents every handshake-negotiated capability and frame type", async () => {
		const doc = await readDoc("docs/bridge.md");
		const { accepted_capabilities, frame_types } = await observeHandshake();
		expect(accepted_capabilities.length).toBeGreaterThan(0);
		expect(frame_types.length).toBeGreaterThan(0);
		for (const capability of accepted_capabilities) {
			expect(doc).toContain(`\`${capability}\``);
		}
		for (const frameType of frame_types) {
			expect(doc).toContain(`\`${frameType}\``);
		}
	});

	it("docs/bridge.md documents the unsupported local-only UI capabilities the context emits", async () => {
		const doc = await readDoc("docs/bridge.md");
		const emitted: BridgeUiRequestPayload[] = [];
		const broker = new UiRequestBroker<BridgeUiRequestPayload, ReturnType<typeof uiUnsupported>>({
			emitRequest: () => {},
		});
		const ui = new BridgeExtensionUIContext({ broker: broker as never, emit: payload => emitted.push(payload) });
		ui.onTerminalInput((() => {}) as never);
		ui.setWidget("k", (() => ({ render: () => [], invalidate: () => {} })) as never);
		ui.setFooter((() => ({})) as never);
		ui.setHeader((() => ({})) as never);
		ui.setEditorComponent((() => ({})) as never);
		ui.setToolsExpanded(true);
		try {
			ui.getEditorText();
		} catch {}
		try {
			await ui.custom();
		} catch {}
		const capabilities = new Set(
			emitted
				.filter(payload => payload.kind === "unsupported")
				.map(payload => (payload as { capability: string }).capability),
		);
		for (const capability of [
			"ui.terminal_input",
			"ui.widget.component",
			"ui.footer.component",
			"ui.header.component",
			"ui.custom.component",
			"ui.editor.get_text",
			"ui.editor.component",
			"ui.tools_expanded",
		]) {
			expect(capabilities.has(capability)).toBe(true);
			expect(doc).toContain(`\`${capability}\``);
		}
		const themeResult = await ui.setTheme("x");
		expect(themeResult.success).toBe(false);
		expect(doc).toContain("Theme switching");
	});

	it("docs/bridge.md documents transport, replay, idempotency, single-session, and SDK posture", async () => {
		const doc = await readDoc("docs/bridge.md");
		expect(doc).toContain("one live");
		expect(doc).toContain("session_id");
		expect(doc).toContain("/healthz");
		expect(doc).toContain("replay_window_exceeded");
		expect(doc).toContain("last_seq");
		expect(doc).toContain("Idempotency-Key");
		expect(doc).toContain("Promise<unknown>");
	});

	it("changelogs label the bridge protocol/SDK experimental", async () => {
		const codingAgentChangelog = await readDoc("packages/coding-agent/CHANGELOG.md");
		const bridgeClientChangelog = await readDoc("packages/bridge-client/CHANGELOG.md");
		expect(codingAgentChangelog.toLowerCase()).toContain("experimental");
		expect(bridgeClientChangelog.toLowerCase()).toContain("experimental");
	});
});
