import { describe, expect, it } from "bun:test";
import { parseHTML } from "linkedom";
import { OAuthCallbackFlow, type OAuthCallbackFlowOptions } from "../src/utils/oauth/callback-server";
import templateHtml from "../src/utils/oauth/oauth.html" with { type: "text" };
import type { OAuthCredentials } from "../src/utils/oauth/types";

const EXPECTED_STATE = "expected-state";
const TEMPLATE_HTML = templateHtml as unknown as string;

class TestCallbackFlow extends OAuthCallbackFlow {
	constructor(port: number, options: Partial<OAuthCallbackFlowOptions> = {}) {
		const flowOptions: OAuthCallbackFlowOptions = {
			preferredPort: port,
			callbackHostname: "127.0.0.1",
			callbackBindHostname: "127.0.0.1",
			...options,
		};
		const authUrl = Promise.withResolvers<string>();
		super({ onAuth: ({ url }) => authUrl.resolve(url) }, flowOptions);
		this.authUrl = authUrl.promise;
	}

	readonly authUrl: Promise<string>;

	override generateState(): string {
		return EXPECTED_STATE;
	}

	async generateAuthUrl(_state: string, redirectUri: string): Promise<{ url: string }> {
		return { url: redirectUri };
	}

	async exchangeToken(code: string): Promise<OAuthCredentials> {
		return { access: `access-${code}`, refresh: "refresh-token", expires: 1 };
	}
}

async function availablePort(): Promise<number> {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
	const port = server.port;
	server.stop(true);
	if (port === undefined) throw new Error("Bun did not assign a loopback port");
	return port;
}

function readServerState(html: string): Record<string, unknown> {
	const document = parseHTML(html).document;
	const serverStates = document.querySelectorAll('script#server-state[type="application/json"]');
	expect(serverStates).toHaveLength(1);
	expect(document.querySelectorAll("script")).toHaveLength(TEMPLATE_HTML.match(/<script(?:\s|>)/g)?.length ?? 0);
	expect(html.match(/<script(?:\s|>)/g)).toHaveLength(TEMPLATE_HTML.match(/<script(?:\s|>)/g)?.length ?? 0);
	expect(html.match(/<\/script>/g)).toHaveLength(TEMPLATE_HTML.match(/<\/script>/g)?.length ?? 0);
	expect(document.querySelector("[data-marker='GJC_SCRIPT_DATA_MARKER']")).toBeNull();
	return JSON.parse(serverStates[0]?.textContent ?? "") as Record<string, unknown>;
}

async function runCallback(
	params: URLSearchParams,
	options: Partial<OAuthCallbackFlowOptions> = {},
): Promise<{ response: Response; html: string; outcome: OAuthCredentials | Error }> {
	const flow = new TestCallbackFlow(await availablePort(), options);
	const login = flow.login().catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
	if (!params.has("state")) params.set("state", EXPECTED_STATE);
	const callbackUrl = new URL(await flow.authUrl);
	callbackUrl.search = params.toString();
	const response = await fetch(callbackUrl);
	const html = await response.text();
	const outcome = await login;
	return { response, html, outcome };
}

describe("OAuthCallbackFlow callback script data", () => {
	it.each([
		"</script>",
		"</SCRIPT>",
		"</ScRiPt>",
	])("keeps the %s terminator inside exact error JSON data", async terminator => {
		const injected = `${terminator}<script data-marker=GJC_SCRIPT_DATA_MARKER>GJC_INJECTED_SCRIPT_NODE</script>`;
		const { response, html, outcome } = await runCallback(
			new URLSearchParams({ error: "access_denied", error_description: injected }),
		);

		expect(response.status).toBe(500);
		expect(response.headers.get("content-type")).toBe("text/html");
		expect(html).not.toContain("<script data-marker=GJC_SCRIPT_DATA_MARKER>");
		expect(html).toContain(`${terminator.replace("<", "\\u003c")}\\u003cscript data-marker=GJC_SCRIPT_DATA_MARKER>`);
		expect(readServerState(html)).toEqual({ ok: false, error: `Authorization failed: ${injected}` });
		expect(outcome).toBeInstanceOf(Error);
		expect((outcome as Error).message).toBe(`Authorization failed: ${injected}`);
	});

	it("escapes JavaScript line separators without changing provider-controlled values", async () => {
		const injected = "before\u2028middle\u2029after";
		const { response, html, outcome } = await runCallback(
			new URLSearchParams({ error: "access_denied", error_description: injected }),
		);

		expect(response.status).toBe(500);
		expect(response.headers.get("content-type")).toBe("text/html");
		expect(html).not.toContain("\u2028");
		expect(html).not.toContain("\u2029");
		expect(html).toContain("before\\u2028middle\\u2029after");
		expect(readServerState(html)).toEqual({ ok: false, error: `Authorization failed: ${injected}` });
		expect(outcome).toBeInstanceOf(Error);
		expect((outcome as Error).message).toBe(`Authorization failed: ${injected}`);
	});

	it.each([
		["matched substring", "$&"],
		["literal dollar", "$$"],
		["prefix", "$`"],
		["suffix", "$'"],
	])("keeps replacement metasequence %s as exact JSON data", async (_name, metasequence) => {
		const injected = `${metasequence}</ScRiPt><script data-marker=GJC_SCRIPT_DATA_MARKER>GJC_INJECTED_SCRIPT_NODE</script>`;
		const { response, html, outcome } = await runCallback(
			new URLSearchParams({ error: "access_denied", error_description: injected }),
		);

		expect(response.status).toBe(500);
		expect(response.headers.get("content-type")).toBe("text/html");
		expect(html).not.toContain("<script data-marker=GJC_SCRIPT_DATA_MARKER>");
		expect(readServerState(html)).toEqual({ ok: false, error: `Authorization failed: ${injected}` });
		expect(outcome).toBeInstanceOf(Error);
		expect((outcome as Error).message).toBe(`Authorization failed: ${injected}`);
	});

	it.each([
		{
			name: "ordinary provider error",
			params: new URLSearchParams({ error: "access_denied", error_description: "The user denied access" }),
			state: { ok: false, error: "Authorization failed: The user denied access" },
			message: "Authorization failed: The user denied access",
		},
		{
			name: "missing authorization code",
			params: new URLSearchParams({ state: EXPECTED_STATE }),
			state: { ok: false, error: "Missing authorization code" },
			message: "Missing authorization code",
		},
		{
			name: "empty authorization code",
			params: new URLSearchParams({ code: "", state: EXPECTED_STATE }),
			state: { ok: false, error: "Missing authorization code" },
			message: "Missing authorization code",
		},
		{
			name: "state mismatch",
			params: new URLSearchParams({ code: "auth-code", state: "wrong-state" }),
			state: { ok: false, error: "State mismatch - possible CSRF attack" },
			message: "State mismatch - possible CSRF attack",
		},
	])("preserves the $name response contract", async ({ params, state, message }) => {
		const { response, html, outcome } = await runCallback(params);

		expect(response.status).toBe(500);
		expect(readServerState(html)).toEqual(state);
		expect(outcome).toBeInstanceOf(Error);
		expect((outcome as Error).message).toBe(message);
	});

	it("preserves issuer validation precedence and generic failure text", async () => {
		const { response, html, outcome } = await runCallback(
			new URLSearchParams({
				code: "auth-code",
				state: EXPECTED_STATE,
				iss: "https://attacker.example",
				error: "access_denied",
				error_description: "provider-controlled detail",
			}),
			{ expectedIssuer: "https://issuer.example" },
		);

		expect(response.status).toBe(500);
		expect(readServerState(html)).toEqual({ ok: false, error: "Authorization response issuer mismatch" });
		expect(outcome).toBeInstanceOf(Error);
		expect((outcome as Error).message).toBe("Authorization response issuer mismatch");
	});

	it("preserves the required issuer failure when iss is missing", async () => {
		const { response, html, outcome } = await runCallback(
			new URLSearchParams({ code: "auth-code", state: EXPECTED_STATE }),
			{ expectedIssuer: "https://issuer.example", issuerResponseIssSupported: true },
		);

		expect(response.status).toBe(500);
		expect(readServerState(html)).toEqual({
			ok: false,
			error: "Authorization response missing required issuer (iss)",
		});
		expect(outcome).toBeInstanceOf(Error);
		expect((outcome as Error).message).toBe("Authorization response missing required issuer (iss)");
	});

	it("preserves successful callback status, JSON, and token exchange", async () => {
		const code = "auth</ScRiPt>code";
		const { response, html, outcome } = await runCallback(new URLSearchParams({ code, state: EXPECTED_STATE }));

		expect(response.status).toBe(200);
		expect(html).not.toContain(code);
		expect(readServerState(html)).toEqual({ ok: true, code, state: EXPECTED_STATE });
		expect(outcome).toEqual({ access: `access-${code}`, refresh: "refresh-token", expires: 1 });
	});

	it("does not cancel an in-flight login when an error callback has the wrong state", async () => {
		const flow = new TestCallbackFlow(await availablePort());
		let settled = false;
		const login = flow.login().then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		const callbackUrl = new URL(await flow.authUrl);
		callbackUrl.search = new URLSearchParams({
			error: "access_denied",
			error_description: "attacker-controlled detail",
			state: "wrong-state",
		}).toString();
		const response = await fetch(callbackUrl);
		await new Promise(resolve => setTimeout(resolve, 30));
		expect(response.status).toBe(400);
		expect(await response.text()).toBe("State mismatch");
		expect(settled).toBe(false);

		const correlated = new URL(callbackUrl);
		correlated.search = new URLSearchParams({
			error: "access_denied",
			error_description: "the user denied access",
			state: EXPECTED_STATE,
		}).toString();
		const correlatedResponse = await fetch(correlated);
		expect(correlatedResponse.status).toBe(500);
		await login;
		expect(settled).toBe(true);
	});
});
