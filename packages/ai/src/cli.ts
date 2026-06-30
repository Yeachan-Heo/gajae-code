#!/usr/bin/env bun
import * as readline from "node:readline";
import { AuthStorage, SqliteAuthCredentialStore } from "./auth-storage";
import { getOAuthProviders } from "./utils/oauth";
import type { OAuthProvider } from "./utils/oauth/types";

const PROVIDERS = getOAuthProviders();

function prompt(rl: readline.Interface, question: string): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const input = process.stdin as NodeJS.ReadStream;
	const supportsRawMode = input.isTTY && typeof input.setRawMode === "function";
	const wasRaw = supportsRawMode ? input.isRaw : false;
	let settled = false;

	const cleanup = () => {
		rl.off("SIGINT", onSigint);
		if (supportsRawMode) {
			input.off("keypress", onKeypress);
			input.setRawMode?.(wasRaw);
		}
	};

	const finish = (result: () => void) => {
		if (settled) return;
		settled = true;
		cleanup();
		result();
	};

	const cancel = () => {
		finish(() => reject(new Error("Login cancelled")));
	};

	const onSigint = () => {
		cancel();
	};

	const onKeypress = (_str: string, key: readline.Key) => {
		if (key.name === "escape" || (key.ctrl && key.name === "c")) {
			cancel();
			rl.close();
		}
	};

	if (supportsRawMode) {
		readline.emitKeypressEvents(input, rl);
		input.setRawMode(true);
		input.on("keypress", onKeypress);
	}

	rl.once("SIGINT", onSigint);
	rl.question(question, answer => {
		finish(() => resolve(answer));
	});
	return promise;
}

async function login(provider: OAuthProvider): Promise<void> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	const promptFn = (msg: string) => prompt(rl, `${msg} `);
	const store = await SqliteAuthCredentialStore.open();
	const storage = new AuthStorage(store);
	await storage.reload();

	try {
		await storage.login(provider, {
			onAuth(info) {
				const { url, instructions } = info;
				console.log(`\nOpen this URL in your browser:\n${url}`);
				if (instructions) console.log(instructions);
				console.log();
			},
			onProgress(message) {
				console.log(message);
			},
			onPrompt(p) {
				return promptFn(`${p.message}${p.placeholder ? ` (${p.placeholder})` : ""}:`);
			},
		});
		console.log(`\nCredentials saved to ~/.gjc/agent/agent.db`);
	} finally {
		store.close();
		rl.close();
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const command = args[0];

	if (!command || command === "help" || command === "--help" || command === "-h") {
		console.log(`Usage: bunx @gajae-code/ai <command> [provider]

Commands:
  login [provider]  Login to a provider
  logout [provider] Logout from a provider
  status            Show logged-in providers
  list              List available providers

Providers:
  anthropic         Anthropic
  github-copilot    GitHub Copilot
  google-gemini-cli Google Gemini CLI
  google-antigravity Antigravity (Gemini 3, Anthropic, GPT-OSS)
  openai-codex      OpenAI code provider (ChatGPT Plus/Pro)
  kimi-code         Kimi Code
  kilo              Kilo Gateway
  kagi              Kagi
  tavily            Tavily
  zai               Z.AI (GLM Coding Plan)
  glm-zcode         GLM ZCode OAuth (unofficial, opt-in; at your own risk)
  deepseek          DeepSeek
  deepinfra         DeepInfra
  xai               xAI
  nanogpt           NanoGPT
  minimax-code      MiniMax Coding Plan (International)
  minimax-code-cn   MiniMax Coding Plan (China)
  cursor            Cursor (Anthropic, GPT, etc.)
  zenmux            ZenMux
  ollama-cloud      Ollama Cloud

Examples:
  bunx @gajae-code/ai login              # interactive provider selection
  bunx @gajae-code/ai login anthropic    # login to specific provider
  bunx @gajae-code/ai logout anthropic   # logout from specific provider
  bunx @gajae-code/ai status             # show logged-in providers
  bunx @gajae-code/ai list               # list providers
`);
		return;
	}

	if (command === "status") {
		const storage = await SqliteAuthCredentialStore.open();
		try {
			const providers = storage.listProviders();
			if (providers.length === 0) {
				console.log("No credentials stored.");
				console.log(`Use 'bunx @gajae-code/ai login' to authenticate.`);
			} else {
				console.log("Logged-in providers:\n");
				for (const provider of providers) {
					const oauth = storage.getOAuth(provider);
					if (oauth) {
						const expires = new Date(oauth.expires);
						const expired = Date.now() >= oauth.expires;
						const status = expired ? "(expired)" : `(expires ${expires.toLocaleString()})`;
						console.log(`  ${provider.padEnd(20)} ${status}`);
						continue;
					}
					const apiKey = storage.getApiKey(provider);
					if (apiKey) {
						console.log(`  ${provider.padEnd(20)} (api key)`);
					}
				}
			}
		} finally {
			storage.close();
		}
		return;
	}

	if (command === "list") {
		console.log("Available providers:\n");
		for (const p of PROVIDERS) {
			console.log(`  ${p.id.padEnd(20)} ${p.name}`);
		}
		return;
	}

	if (command === "logout") {
		let provider = args[1] as OAuthProvider | undefined;
		const storage = await SqliteAuthCredentialStore.open();

		try {
			if (!provider) {
				const providers = storage.listProviders();
				if (providers.length === 0) {
					console.log("No credentials stored.");
					return;
				}

				const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
				console.log("Select a provider to logout:\n");
				for (let i = 0; i < providers.length; i++) {
					console.log(`  ${i + 1}. ${providers[i]}`);
				}
				console.log();

				const choice = await prompt(rl, `Enter number (1-${providers.length}): `);
				rl.close();

				const index = parseInt(choice, 10) - 1;
				if (index < 0 || index >= providers.length) {
					console.error("Invalid selection");
					process.exit(1);
				}
				provider = providers[index] as OAuthProvider;
			}
			if (!provider) {
				console.error("No provider selected");
				process.exit(1);
			}

			const oauth = storage.getOAuth(provider);
			const apiKey = storage.getApiKey(provider);
			if (!oauth && !apiKey) {
				console.error(`Not logged in to ${provider}`);
				process.exit(1);
			}

			storage.deleteProvider(provider);
			console.log(`Logged out from ${provider}`);
		} finally {
			storage.close();
		}
		return;
	}

	if (command === "login") {
		let provider = args[1] as OAuthProvider | undefined;

		if (!provider) {
			const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
			console.log("Select a provider:\n");
			for (let i = 0; i < PROVIDERS.length; i++) {
				console.log(`  ${i + 1}. ${PROVIDERS[i].name}`);
			}
			console.log();

			const choice = await prompt(rl, `Enter number (1-${PROVIDERS.length}): `);
			rl.close();

			const index = parseInt(choice, 10) - 1;
			if (index < 0 || index >= PROVIDERS.length) {
				console.error("Invalid selection");
				process.exit(1);
			}
			provider = PROVIDERS[index].id as OAuthProvider;
		}
		if (!provider) {
			console.error("No provider selected");
			process.exit(1);
		}

		if (!PROVIDERS.some(p => p.id === provider)) {
			console.error(`Unknown provider: ${provider}`);
			console.error(`Use 'bunx @gajae-code/ai list' to see available providers`);
			process.exit(1);
		}

		console.log(`Logging in to ${provider}…`);
		await login(provider);
		return;
	}

	console.error(`Unknown command: ${command}`);
	console.error(`Use 'bunx @gajae-code/ai --help' for usage`);
	process.exit(1);
}

main().catch(err => {
	console.error("Error:", err.message);
	process.exit(1);
});
