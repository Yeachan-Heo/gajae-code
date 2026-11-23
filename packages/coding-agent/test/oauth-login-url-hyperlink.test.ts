import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@gajae-code/coding-agent/config/settings";
import { SelectorController } from "@gajae-code/coding-agent/modes/controllers/selector-controller";
import { buildOAuthLoginAnchor, createOAuthUrlCopyLease } from "@gajae-code/coding-agent/modes/shared/oauth-url-copy";
import { setThemeInstance } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { type Component, Text } from "@gajae-code/tui";
import { MCPAddWizard } from "../src/modes/components/runtime-mcp-add-wizard";
import { MCPCommandController } from "../src/modes/controllers/runtime-mcp-command-controller";
import { loadTestTheme } from "./helpers/test-theme";

// A login URL is a single unbreakable token, so any pane narrower than the URL
// splits it across rows. The wrap layer re-opens the identical OSC 8 link on
// every fragment (#4711), but only for text that carries an anchor: the login
// row used to print the bare URL, so every wrapped fragment rendered as dead,
// unclickable text and the visible URL was the only affordance left.

const URL =
	"https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e" +
	"&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback" +
	"&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference" +
	"&code_challenge=VTR_ktTm5lthKdIfASwfdho91I8mCX4D_SLjbqnpSl4&code_challenge_method=S256" +
	"&state=4b0a9aff661f8634cd253475142f70f2";

/** Strip OSC and CSI escapes, leaving only visible text. */
function plainText(line: string): string {
	return line.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "");
}

/** Non-empty link targets opened on a row. */
function urisIn(line: string): string[] {
	return (line.match(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/gu) ?? [])
		.map(seq => seq.slice(5, seq.length - (seq.endsWith("\x07") ? 1 : 2)))
		.filter(uri => uri.length > 0);
}

/**
 * Rows a `Text` child produces at the given container width, dropping blank
 * rows. `Text` pads each row with a one-column margin; a URL carries no spaces,
 * so trimming the visible text recovers the fragment exactly.
 */
function rowsAt(content: string, width: number): string[] {
	return new Text(content, 1, 0).render(width).filter(row => plainText(row).trim() !== "");
}

/** Visible fragment on a row, with the component's padding margins removed. */
function fragment(row: string): string {
	return plainText(row).trim();
}

describe("OAuth login URL hyperlink anchor", () => {
	it("anchors the URL to itself so the visible text stays the URL", () => {
		const anchor = buildOAuthLoginAnchor(URL, URL, true);

		expect(plainText(anchor)).toBe(URL);
		expect(urisIn(anchor)).toEqual([URL]);
	});

	it("anchors a custom label to the same target", () => {
		const anchor = buildOAuthLoginAnchor(URL, "Click here to login", true);

		expect(plainText(anchor)).toBe("Click here to login");
		expect(urisIn(anchor)).toEqual([URL]);
	});

	it("keeps every fragment of the wrapped URL row clickable in a narrow pane", () => {
		// 100 columns is a routine tmux split; the URL is far longer than that.
		const rows = rowsAt(buildOAuthLoginAnchor(URL, URL, true), 100);

		expect(rows.length).toBeGreaterThan(1);
		for (const row of rows) expect(urisIn(row)).toEqual([URL]);
		expect(rows.map(fragment).join("")).toBe(URL);
	});

	it("survives the SGR styling the login row applies around the anchor", () => {
		const styled = `\x1b[2m${buildOAuthLoginAnchor(URL, URL, true)}\x1b[0m`;

		for (const width of [120, 100, 60, 40]) {
			const rows = rowsAt(styled, width);
			for (const row of rows) expect(urisIn(row)).toEqual([URL]);
			expect(rows.map(fragment).join("")).toBe(URL);
		}
	});

	it("leaves a URL that fits on one row as a single anchored fragment", () => {
		const rows = rowsAt(buildOAuthLoginAnchor(URL, URL, true), URL.length + 8);

		expect(rows).toHaveLength(1);
		expect(urisIn(rows[0]!)).toEqual([URL]);
		expect(fragment(rows[0]!)).toBe(URL);
	});

	it("omits OSC 8 when terminal hyperlink policy disables it", () => {
		expect(buildOAuthLoginAnchor(URL, URL, false)).toBe(URL);
		expect(buildOAuthLoginAnchor(URL, "Click here to login", false)).toBe("Click here to login");
	});
});

/** Drive the login flow far enough to capture what `onAuth` renders. */
async function renderLoginRows(
	url: string,
): Promise<{ rendered: Component[]; pendingUrls: Array<string | undefined> }> {
	const rendered: Component[] = [];
	const pendingUrls: Array<string | undefined> = [];
	const authStorage = {
		listCredentialInventory: () => [],
		listCredentialRemovalTargets: () => [],
		login: async (_provider: string, callbacks: { onAuth: (info: { url: string }) => void }) => {
			callbacks.onAuth({ url });
			// Abort after the URL is on screen; the rows under test are already
			// rendered and the success path needs the full session/registry graph.
			throw new Error("login aborted by test");
		},
	};
	const ctx = {
		ui: { requestRender: () => {}, setFocus: () => {} },
		chatContainer: { addChild: (child: Component) => rendered.push(child) },
		editorContainer: { clear: () => {}, detachChild: () => {}, addChild: () => {} },
		editor: {},
		keybindings: { getDisplayString: () => "Alt+Shift+K" },
		showStatus: () => {},
		showError: () => {},
		beginOAuthUrlForCopy: (next: string) => {
			pendingUrls.push(next);
			return () => pendingUrls.push(undefined);
		},
		hasOAuthUrlForCopy: () => false,
		copyOAuthUrl: async () => {},
		openInBrowser: () => {},
		oauthManualInput: { waitForInput: async () => "", clear: () => {} },
		session: { modelRegistry: { authStorage, getModelProfiles: () => new Map() } },
	} as unknown as InteractiveModeContext;

	await new SelectorController(ctx).showOAuthSelector("login", "anthropic");
	return { rendered, pendingUrls };
}

describe("OAuth login row emission", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		settings.override("tui.hyperlinks", "always");
		const theme = await loadTestTheme();
		setThemeInstance(theme);
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	it("renders the login URL as an anchored row whose every narrow-pane fragment is clickable", async () => {
		const { rendered, pendingUrls } = await renderLoginRows(URL);

		const urlRow = rendered.find(child => child instanceof Text && plainText(child.getText()) === URL);
		expect(urlRow).toBeDefined();

		const rows = (urlRow as Text).render(100).filter(row => plainText(row).trim() !== "");
		expect(rows.length).toBeGreaterThan(1);
		for (const row of rows) expect(urisIn(row)).toEqual([URL]);
		expect(rows.map(fragment).join("")).toBe(URL);
		expect(pendingUrls).toEqual([URL, undefined]);
		const guidance = rendered.find(
			child => child instanceof Text && plainText(child.getText()).includes("Copy OAuth URL"),
		);
		expect(guidance && plainText((guidance as Text).getText())).toContain("Alt+Shift+K");
	});

	it("leaves the adjacent short-label link row pointing at the same target", async () => {
		const { rendered } = await renderLoginRows(URL);

		const labelRow = rendered.find(
			child => child instanceof Text && plainText(child.getText()) === "Click here to login",
		);
		expect(labelRow).toBeDefined();
		expect(urisIn((labelRow as Text).getText())).toEqual([URL]);

		// The short label fits any sane pane, so it stays one row and keeps the
		// click affordance the URL row cannot offer to a terminal without OSC 8.
		const rows = (labelRow as Text).render(100).filter(row => plainText(row).trim() !== "");
		expect(rows).toHaveLength(1);
		expect(urisIn(rows[0]!)).toEqual([URL]);
	});
});

describe("OAuth URL copy lease wiring", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		settings.override("tui.hyperlinks", "always");
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	it("replaces and releases the pending URL lease for controller auth callbacks", () => {
		const pendingUrls: Array<string | undefined> = [];
		const lease = createOAuthUrlCopyLease({
			beginOAuthUrlForCopy: (url: string) => {
				pendingUrls.push(url);
				return () => pendingUrls.push(undefined);
			},
		});

		lease.replace("https://example.test/oauth/one");
		lease.replace("https://example.test/oauth/two");
		lease.release();
		lease.release();

		expect(pendingUrls).toEqual([
			"https://example.test/oauth/one",
			undefined,
			"https://example.test/oauth/two",
			undefined,
		]);
	});

	it("registers and releases the lease through the runtime MCP OAuth controller", async () => {
		const pendingUrls: Array<string | undefined> = [];
		const storedCredentials: unknown[] = [];
		const chatChildren: Component[] = [];
		const ctx = {
			keybindings: { getDisplayString: () => "Alt+Shift+U" },
			beginOAuthUrlForCopy: (url: string) => {
				pendingUrls.push(url);
				return () => pendingUrls.push(undefined);
			},
			chatContainer: { addChild: (child: Component) => chatChildren.push(child) },
			ui: { requestRender: () => {} },
			showError: () => {},
			session: { modelRegistry: { authStorage: { set: async (value: unknown) => storedCredentials.push(value) } } },
		} as unknown as InteractiveModeContext;
		const controller = new MCPCommandController(ctx);
		const authUrl = "https://auth.example.test/authorize?client_id=test-client";

		await controller.handleOAuthFlow(
			"https://mcp.example.test",
			authUrl,
			"https://auth.example.test/token",
			"test-client",
			"",
			"",
			undefined,
			undefined,
			undefined,
			undefined,
			(config, callbacks) => ({
				resolvedClientId: config.clientId,
				registeredClientSecret: undefined,
				login: async () => {
					callbacks.onAuth({ url: authUrl });
					return { access: "access", refresh: "refresh", expires: 1 };
				},
			}),
			() => {},
		);

		expect(pendingUrls).toEqual([authUrl, undefined]);
		expect(storedCredentials).toHaveLength(1);
		const runtimeUrlRow = chatChildren.find(
			(child): child is Text => child instanceof Text && plainText(child.getText()).includes(authUrl),
		);
		expect(runtimeUrlRow).toBeDefined();
		const runtimeRows = rowsAt(runtimeUrlRow!.getText(), 40);
		expect(runtimeRows.length).toBeGreaterThan(1);
		for (const row of runtimeRows) expect(urisIn(row)).toEqual([authUrl]);

		await expect(
			controller.handleOAuthFlow(
				"https://mcp.example.test",
				authUrl,
				"https://auth.example.test/token",
				"test-client",
				"",
				"",
				undefined,
				undefined,
				undefined,
				undefined,
				(_config, callbacks) => ({
					resolvedClientId: "test-client",
					registeredClientSecret: undefined,
					login: async () => {
						callbacks.onAuth({ url: authUrl });
						throw new Error("cancelled");
					},
				}),
				() => {},
			),
		).rejects.toThrow("OAuth authentication failed: cancelled");

		expect(pendingUrls).toEqual([authUrl, undefined, authUrl, undefined]);
	});

	it("aborts the pending flow and releases its URL lease exactly once", async () => {
		const pendingUrls: Array<string | undefined> = [];
		const ctx = {
			keybindings: { getDisplayString: () => "Ctrl+C" },
			beginOAuthUrlForCopy: (url: string) => {
				pendingUrls.push(url);
				return () => pendingUrls.push(undefined);
			},
			chatContainer: { addChild: () => {} },
			ui: { requestRender: () => {} },
			showError: () => {},
			session: { modelRegistry: { authStorage: { set: async () => {} } } },
		} as unknown as InteractiveModeContext;
		const controller = new MCPCommandController(ctx);
		const abortController = new AbortController();
		const authUrl = "https://auth.example.test/authorize?client_id=abort-test";
		const entered = Promise.withResolvers<void>();

		const operation = controller.handleOAuthFlow(
			"https://mcp.example.test",
			authUrl,
			"https://auth.example.test/token",
			"test-client",
			"",
			"",
			undefined,
			undefined,
			undefined,
			undefined,
			(config, callbacks) => ({
				resolvedClientId: config.clientId,
				registeredClientSecret: undefined,
				login: async () => {
					callbacks.onAuth({ url: authUrl });
					entered.resolve();
					const { promise: aborted, reject } = Promise.withResolvers<never>();
					callbacks.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
					await aborted;
					throw new Error("unreachable");
				},
			}),
			() => {},
			abortController.signal,
		);

		await entered.promise;
		abortController.abort(new Error("wizard cancelled"));
		await expect(operation).rejects.toThrow("aborted");
		expect(pendingUrls).toEqual([authUrl, undefined]);
	});

	it("ignores a late auth callback after the flow has settled", async () => {
		const pendingUrls: Array<string | undefined> = [];
		const ctx = {
			keybindings: { getDisplayString: () => "Alt+Shift+U" },
			beginOAuthUrlForCopy: (url: string) => {
				pendingUrls.push(url);
				return () => pendingUrls.push(undefined);
			},
			chatContainer: { addChild: () => {} },
			ui: { requestRender: () => {} },
			showError: () => {},
			session: { modelRegistry: { authStorage: { set: async () => {} } } },
		} as unknown as InteractiveModeContext;
		const controller = new MCPCommandController(ctx);
		const authUrl = "https://auth.example.test/authorize?client_id=late-test";

		await expect(
			controller.handleOAuthFlow(
				"https://mcp.example.test",
				authUrl,
				"https://auth.example.test/token",
				"test-client",
				"",
				"",
				undefined,
				undefined,
				undefined,
				undefined,
				(config, callbacks) => ({
					resolvedClientId: config.clientId,
					registeredClientSecret: undefined,
					login: async () => {
						callbacks.onAuth({ url: authUrl });
						setTimeout(() => callbacks.onAuth({ url: "https://auth.example.test/late" }), 0);
						throw new Error("settled");
					},
				}),
				() => {},
			),
		).rejects.toThrow("settled");

		await Bun.sleep(0);
		expect(pendingUrls).toEqual([authUrl, undefined]);
	});

	it("installs an interrupt listener for non-wizard OAuth flows", async () => {
		let listener: ((data: string) => { consume: boolean } | undefined) | undefined;
		const pendingUrls: Array<string | undefined> = [];
		const ctx = {
			keybindings: { getDisplayString: () => "Alt+Shift+U" },
			beginOAuthUrlForCopy: (url: string) => {
				pendingUrls.push(url);
				return () => pendingUrls.push(undefined);
			},
			chatContainer: { addChild: () => {} },
			ui: {
				requestRender: () => {},
				addInputListener: (callback: typeof listener) => {
					listener = callback;
					return () => {};
				},
			},
			showError: () => {},
			session: { modelRegistry: { authStorage: { set: async () => {} } } },
		} as unknown as InteractiveModeContext;
		const controller = new MCPCommandController(ctx);
		const authUrl = "https://auth.example.test/authorize?client_id=interrupt-test";
		const operation = controller.handleOAuthFlow(
			"https://mcp.example.test",
			authUrl,
			"https://auth.example.test/token",
			"test-client",
			"",
			"",
			undefined,
			undefined,
			undefined,
			undefined,
			(config, callbacks) => ({
				resolvedClientId: config.clientId,
				registeredClientSecret: undefined,
				login: async () => {
					callbacks.onAuth({ url: authUrl });
					const signal = callbacks.signal;
					if (!signal) throw new Error("missing cancellation signal");
					const { promise: aborted, reject } = Promise.withResolvers<never>();
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					return await aborted;
				},
			}),
			() => {},
		);

		await Bun.sleep(0);
		expect(listener?.("\x03")).toEqual({ consume: true });
		await expect(operation).rejects.toThrow("OAuth authentication failed: OAuth flow cancelled");
		expect(pendingUrls).toEqual([authUrl, undefined]);
	});

	it("routes the command-palette chord through a focused MCP wizard", () => {
		let receivedKey = "";
		const wizard = new MCPAddWizard(
			() => {},
			() => {},
			undefined,
			undefined,
			undefined,
			keyData => {
				receivedKey = keyData;
				return true;
			},
		);

		wizard.handleInput("\x10");

		expect(receivedKey).toBe("\x10");
		wizard.dispose();
	});
});
