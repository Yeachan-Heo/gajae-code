#!/usr/bin/env bun
/**
 * Reference CLI for the Gajae-Code SDK Telegram client.
 *
 * Bridges a running GJC session's notification endpoint to a Telegram bot so you
 * can answer asks / see idle pings from your phone — no RPC mode required. This
 * is an EXAMPLE/template (the SDK contract is in `docs/sdk.md`);
 * Discord/Slack clients are written the same way.
 *
 * Usage:
 *   bun run packages/coding-agent/src/sdk/bus/telegram-cli.ts \
 *     --bot-token <token> [--chat-id <id>] [--endpoint-file <path> | --session-id <id>] [--repo <dir>]
 *
 * Env fallbacks: GJC_TG_BOT_TOKEN, GJC_TG_CHAT_ID.
 * If --chat-id is omitted it is auto-resolved from getUpdates (message the bot once).
 * If neither --endpoint-file nor --session-id is given, the newest endpoint file
 * under <repo>/.gjc/state/sdk/ is used.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { $credentialEnv, getAgentDir } from "@gajae-code/utils";
import { tokenFingerprint } from "./config";
import { isFreshLiveOwner, readOwnerFreshnessSnapshot } from "./telegram-daemon";
import { runTelegramReferenceClient, type TelegramNotificationSound } from "./telegram-reference";

interface CliArgs {
	botToken?: string;
	chatId?: string;
	endpointFile?: string;
	sessionId?: string;
	repo: string;
	apiBase?: string;
	sound: TelegramNotificationSound;
	force: boolean;
}

class CliUsageError extends Error {}

export function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = { repo: process.cwd(), sound: "all", force: false };
	for (let i = 0; i < argv.length; i++) {
		const next = () => argv[++i];
		switch (argv[i]) {
			case "--bot-token":
				args.botToken = next();
				break;
			case "--chat-id":
				args.chatId = next();
				break;
			case "--endpoint-file":
				args.endpointFile = next();
				break;
			case "--session-id":
				args.sessionId = next();
				break;
			case "--repo":
				args.repo = next() ?? process.cwd();
				break;
			case "--api-base":
				args.apiBase = next();
				break;
			case "--sound": {
				const sound = next();
				if (sound !== "all" && sound !== "important" && sound !== "none") {
					throw new CliUsageError("--sound must be all, important, or none");
				}
				args.sound = sound;
				break;
			}
			case "--force":
				args.force = true;
				break;
			case "-h":
			case "--help":
				printHelpAndExit();
				break;
			default:
				break;
		}
	}
	return args;
}

function printHelpAndExit(): never {
	process.stdout.write(
		[
			"gjc notifications — Telegram reference client",
			"",
			"  --bot-token <token>     Telegram bot token (or env GJC_TG_BOT_TOKEN)",
			"  --chat-id <id>          Target chat id (or env GJC_TG_CHAT_ID; auto-resolved if omitted)",
			"  --endpoint-file <path>  Session endpoint discovery file",
			"  --session-id <id>       Resolve <repo>/.gjc/state/sdk/<id>.json",
			"  --repo <dir>            Repo root for endpoint discovery (default: cwd)",
			"  --api-base <url>        Telegram API base (default: https://api.telegram.org)",
			"  --sound <all|important|none> Telegram notification sound (default: all)",
			"  --force                 Bypass active daemon guard (debug only; may cause Telegram 409 conflicts)",
			"",
		].join("\n"),
	);
	process.exit(0);
}

/** Find the most recently modified endpoint discovery file under the repo. */
function findLatestEndpoint(repo: string): string | undefined {
	const dir = path.join(repo, ".gjc", "state", "sdk");
	let entries: string[];
	try {
		entries = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
	} catch {
		return undefined;
	}
	let best: { file: string; mtime: number } | undefined;
	for (const f of entries) {
		const full = path.join(dir, f);
		const mtime = fs.statSync(full).mtimeMs;
		if (!best || mtime > best.mtime) best = { file: full, mtime };
	}
	return best?.file;
}

async function resolveChatId(botToken: string, apiBase: string): Promise<string> {
	const api = `${apiBase}/bot${botToken}`;
	for (let i = 0; i < 150; i++) {
		const body = (await fetch(`${api}/getUpdates`)
			.then(r => r.json())
			.catch(() => ({}))) as {
			result?: Array<Record<string, any>>;
		};
		for (const u of body.result ?? []) {
			const id = u.message?.chat?.id ?? u.callback_query?.message?.chat?.id;
			if (id !== undefined) return String(id);
		}
		if (i === 0) process.stderr.write("Waiting for a message to the bot to resolve the chat id...\n");
		await new Promise(r => setTimeout(r, 2000));
	}
	throw new Error("could not resolve a chat id; send the bot a message first");
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function activeDaemonOwnsToken(input: { botToken: string; chatId: string }): Promise<boolean> {
	const snapshot = await readOwnerFreshnessSnapshot({ settings: { getAgentDir } as never });
	const state = snapshot.state;
	if (!state) return false;
	return isFreshLiveOwner({
		state,
		now: Date.now(),
		tokenFingerprint: tokenFingerprint(input.botToken),
		chatId: input.chatId,
		pidAlive,
		effectiveHeartbeatAt: snapshot.effectiveHeartbeatAt,
	});
}

async function main(): Promise<void> {
	let args: CliArgs;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (error) {
		if (error instanceof CliUsageError) {
			process.stderr.write(`error: ${error.message}\n`);
			process.exit(2);
		}
		throw error;
	}
	const apiBase = args.apiBase ?? "https://api.telegram.org";
	// Trusted sources only: this token is the bot the client talks to, so whatever
	// can set it receives the session's notifications and the operator's replies.
	// `$env` merges the caller's `cwd/.env` into `process.env`, and this client is
	// normally run from inside a repository.
	const botToken = args.botToken ?? $credentialEnv("GJC_TG_BOT_TOKEN");
	if (!botToken) {
		process.stderr.write("error: --bot-token (or GJC_TG_BOT_TOKEN) is required\n");
		process.exit(2);
	}

	const endpointFile =
		args.endpointFile ??
		(args.sessionId ? path.join(args.repo, ".gjc", "state", "sdk", `${args.sessionId}.json`) : undefined) ??
		findLatestEndpoint(args.repo);
	if (!endpointFile || !fs.existsSync(endpointFile)) {
		process.stderr.write(
			`error: no endpoint file found (looked under ${args.repo}/.gjc/state/sdk). Start a session with GJC_NOTIFICATIONS=1 first.\n`,
		);
		process.exit(2);
	}

	const chatId = args.chatId ?? $credentialEnv("GJC_TG_CHAT_ID") ?? (await resolveChatId(botToken, apiBase));
	if (!args.force && (await activeDaemonOwnsToken({ botToken, chatId }))) {
		process.stderr.write(
			"an active gjc notifications daemon already owns this bot token; running a second poller will cause Telegram 409 conflicts. Re-run with --force to override.\n",
		);
		process.exit(1);
	}
	process.stderr.write(`notifications: bridging ${endpointFile} <-> Telegram chat ${chatId}\n`);
	await runTelegramReferenceClient({ botToken, chatId, endpointFile, apiBase, sound: args.sound });
}

if (import.meta.main) {
	main().catch(e => {
		process.stderr.write(`fatal: ${String(e)}\n`);
		process.exit(1);
	});
}
