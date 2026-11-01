// Public GLM ZCode OAuth entry points. Spawned with a controlled cwd so a
// project `.env` is parsed at env-module load.
import { GlmZcodeOAuthFlow, refreshGlmZcodeToken } from "@gajae-code/ai/utils/oauth/glm-zcode";

const fetches: string[] = [];
const fetchImpl = (async (input: string | URL | Request) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
	fetches.push(url);
	return new Response("probe", { status: 400 });
}) as typeof fetch;

const flow = new GlmZcodeOAuthFlow({ onAuth() {}, onPrompt: async () => "" }, { fetch: fetchImpl });
const { url } = await flow.generateAuthUrl("state-1", "zcode://oauth/callback");
const clientId = new URL(url).searchParams.get("client_id");
const brokerAt = fetches.length;
try {
	await flow.exchangeToken("code", "state-1", "zcode://oauth/callback");
} catch {
	// A broker refusal still records the URL that received the code.
}
const loginAt = fetches.length;
try {
	await refreshGlmZcodeToken({ access: "a", refresh: "upstream-token", expires: 1 }, { fetch: fetchImpl });
} catch {
	// A login refusal still records the URL that received the refresh token.
}
console.log(
	JSON.stringify({
		authorize: url,
		clientId,
		broker: fetches[brokerAt] ?? null,
		login: fetches[loginAt] ?? null,
	}),
);
