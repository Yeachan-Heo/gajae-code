// Prints the Foundry TLS material `buildAnthropicClientOptions()` actually
// installs. Spawned with a controlled cwd so a planted project `.env` is what
// this process loads.
import * as fs from "node:fs";
import * as os from "node:os";
import * as tls from "node:tls";
import { buildAnthropicClientOptions } from "@gajae-code/ai/providers/anthropic";
import type { Model } from "@gajae-code/ai/types";

const model: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

function envValue(name: string): string | null {
	const value = process.env[name];
	return value === undefined ? null : value;
}

interface TlsShape {
	serverName?: string;
	ca?: string | string[];
	cert?: string;
	key?: string;
}

const drop = process.env.GJC_FOUNDRY_TLS_PROBE_DROP;
if (drop === "unlink") {
	fs.rmSync(".env", { force: true });
} else if (drop === "chdir") {
	process.chdir(os.tmpdir());
}

const env = {
	NODE_EXTRA_CA_CERTS: envValue("NODE_EXTRA_CA_CERTS"),
	CLAUDE_CODE_CLIENT_CERT: envValue("CLAUDE_CODE_CLIENT_CERT"),
	CLAUDE_CODE_CLIENT_KEY: envValue("CLAUDE_CODE_CLIENT_KEY"),
};

try {
	const options = buildAnthropicClientOptions({
		model,
		apiKey: "foundry-token",
		extraBetas: [],
		stream: true,
		interleavedThinking: false,
		dynamicHeaders: {},
	});
	const tlsOptions = (options.fetchOptions as { tls?: TlsShape } | undefined)?.tls;
	let extraCa: string | null = null;
	const ca = tlsOptions?.ca;
	if (typeof ca === "string") {
		extraCa = ca;
	} else if (Array.isArray(ca) && ca.length > tls.rootCertificates.length) {
		extraCa = ca[ca.length - 1] ?? null;
	}
	console.log(
		JSON.stringify({
			error: null,
			serverName: tlsOptions?.serverName ?? null,
			extraCa,
			cert: tlsOptions?.cert ?? null,
			key: tlsOptions?.key ?? null,
			env,
		}),
	);
} catch (error) {
	console.log(
		JSON.stringify({
			error: error instanceof Error ? error.message : String(error),
			serverName: null,
			extraCa: null,
			cert: null,
			key: null,
			env,
		}),
	);
}
