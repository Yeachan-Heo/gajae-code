/**
 * Web search CLI command handlers.
 *
 * Handles `gjc q`/`gjc web-search` subcommands for testing web search providers.
 */

import { APP_NAME } from "@gajae-code/utils";
import chalk from "chalk";
import { Settings } from "../config/settings";
import { initTheme, theme } from "../modes/theme/theme";
import {
	isConfigurableSearchProviderId,
	isSearchProviderPreference,
	runSearchQuery,
	type SearchQueryParams,
} from "../web/search/index";
import { SEARCH_PROVIDER_ORDER, setPreferredSearchProvider, setSearchFallbackProviders } from "../web/search/provider";
import { setSearchHardTimeoutMs } from "../web/search/providers/utils";
import { renderSearchResult } from "../web/search/render";
import type { SearchProviderId } from "../web/search/types";

export interface SearchCommandArgs {
	query: string;
	provider?: SearchProviderId | "auto";
	recency?: "day" | "week" | "month" | "year";
	limit?: number;
	expanded: boolean;
	xaiSearchMode?: SearchQueryParams["xai_search_mode"];
	allowedDomains?: string[];
	excludedDomains?: string[];
	allowedXHandles?: string[];
	excludedXHandles?: string[];
	fromDate?: string;
	toDate?: string;
	enableImageUnderstanding?: boolean;
	enableImageSearch?: boolean;
	enableVideoUnderstanding?: boolean;
	noInlineCitations?: boolean;
}

const PROVIDERS: Array<SearchProviderId | "auto"> = ["auto", ...SEARCH_PROVIDER_ORDER];

const RECENCY_OPTIONS: SearchCommandArgs["recency"][] = ["day", "week", "month", "year"];
const XAI_SEARCH_MODES: Array<NonNullable<SearchCommandArgs["xaiSearchMode"]>> = ["web", "x", "web_and_x"];

function appendCsv(existing: string[] | undefined, raw: string | undefined): string[] | undefined {
	const values = raw
		?.split(",")
		.map(value => value.trim())
		.filter(Boolean);
	if (!values?.length) return existing;
	return [...(existing ?? []), ...values];
}

function splitFlag(raw: string): { flag: string; inlineValue?: string } {
	const equals = raw.indexOf("=");
	if (raw.startsWith("-") && equals > 0) return { flag: raw.slice(0, equals), inlineValue: raw.slice(equals + 1) };
	return { flag: raw };
}

function readValue(args: string[], index: number, flag: string, inlineValue: string | undefined): string {
	if (inlineValue !== undefined) return inlineValue;
	const value = args[index + 1];
	if (!value) throw new Error(`${flag} requires a value`);
	return value;
}

/**
 * Parse web search subcommand arguments.
 * Returns undefined if not a web search command.
 */
export function parseSearchArgs(args: string[]): SearchCommandArgs | undefined {
	if (args.length === 0 || (args[0] !== "q" && args[0] !== "web-search")) {
		return undefined;
	}

	const result: SearchCommandArgs = {
		query: "",
		expanded: true,
	};

	const positional: string[] = [];

	for (let i = 1; i < args.length; i++) {
		const { flag: arg, inlineValue } = splitFlag(args[i]);
		const value = () => readValue(args, i, arg, inlineValue);
		const consumeSeparateValue = () => {
			if (inlineValue === undefined) i++;
		};
		if (arg === "--provider") {
			result.provider = value() as SearchCommandArgs["provider"];
			consumeSeparateValue();
		} else if (arg === "--recency") {
			result.recency = value() as SearchCommandArgs["recency"];
			consumeSeparateValue();
		} else if (arg === "--limit" || arg === "-l") {
			result.limit = Number.parseInt(value(), 10);
			consumeSeparateValue();
		} else if (arg === "--xai-mode") {
			result.xaiSearchMode = value() as SearchCommandArgs["xaiSearchMode"];
			consumeSeparateValue();
		} else if (arg === "--allowed-domain" || arg === "--allowed-domains") {
			result.allowedDomains = appendCsv(result.allowedDomains, value());
			consumeSeparateValue();
		} else if (arg === "--excluded-domain" || arg === "--excluded-domains") {
			result.excludedDomains = appendCsv(result.excludedDomains, value());
			consumeSeparateValue();
		} else if (arg === "--allowed-x-handle" || arg === "--allowed-x-handles") {
			result.allowedXHandles = appendCsv(result.allowedXHandles, value());
			consumeSeparateValue();
		} else if (arg === "--excluded-x-handle" || arg === "--excluded-x-handles") {
			result.excludedXHandles = appendCsv(result.excludedXHandles, value());
			consumeSeparateValue();
		} else if (arg === "--from-date") {
			result.fromDate = value();
			consumeSeparateValue();
		} else if (arg === "--to-date") {
			result.toDate = value();
			consumeSeparateValue();
		} else if (arg === "--image-understanding") {
			result.enableImageUnderstanding = true;
		} else if (arg === "--image-search") {
			result.enableImageSearch = true;
		} else if (arg === "--video-understanding") {
			result.enableVideoUnderstanding = true;
		} else if (arg === "--no-inline-citations") {
			result.noInlineCitations = true;
		} else if (arg === "--compact") {
			result.expanded = false;
		} else if (!arg.startsWith("-")) {
			positional.push(args[i]);
		}
	}

	if (positional.length > 0) {
		result.query = positional.join(" ");
	}

	return result;
}

export async function runSearchCommand(cmd: SearchCommandArgs): Promise<void> {
	if (!cmd.query) {
		process.stderr.write(`${chalk.red("Error: Query is required")}\n`);
		process.exit(1);
	}

	if (cmd.provider && !PROVIDERS.includes(cmd.provider)) {
		process.stderr.write(`${chalk.red(`Error: Unknown provider "${cmd.provider}"`)}\n`);
		process.stderr.write(`${chalk.dim(`Valid providers: ${PROVIDERS.join(", ")}`)}\n`);
		process.exit(1);
	}

	if (cmd.recency && !RECENCY_OPTIONS.includes(cmd.recency)) {
		process.stderr.write(`${chalk.red(`Error: Invalid recency "${cmd.recency}"`)}\n`);
		process.stderr.write(`${chalk.dim(`Valid recency values: ${RECENCY_OPTIONS.join(", ")}`)}\n`);
		process.exit(1);
	}

	if (cmd.xaiSearchMode && !XAI_SEARCH_MODES.includes(cmd.xaiSearchMode)) {
		process.stderr.write(`${chalk.red(`Error: Invalid xAI mode "${cmd.xaiSearchMode}"`)}\n`);
		process.stderr.write(`${chalk.dim(`Valid xAI modes: ${XAI_SEARCH_MODES.join(", ")}`)}\n`);
		process.exit(1);
	}

	if (cmd.limit !== undefined && Number.isNaN(cmd.limit)) {
		process.stderr.write(`${chalk.red("Error: --limit must be a number")}\n`);
		process.exit(1);
	}

	await initTheme();
	const settings = await Settings.init();
	const configuredProvider = settings.get("providers.webSearch");
	if (typeof configuredProvider === "string" && isSearchProviderPreference(configuredProvider)) {
		setPreferredSearchProvider(configuredProvider);
	}
	const configuredFallback = settings.get("web_search.fallback");
	if (Array.isArray(configuredFallback)) {
		setSearchFallbackProviders(
			configuredFallback.filter(value => typeof value === "string" && isConfigurableSearchProviderId(value)),
		);
	}
	const configuredTimeout = settings.get("web_search.timeout");
	if (typeof configuredTimeout === "number" && Number.isFinite(configuredTimeout) && configuredTimeout > 0) {
		setSearchHardTimeoutMs(configuredTimeout * 1000);
	}

	const params: SearchQueryParams = {
		query: cmd.query,
		provider: cmd.provider,
		recency: cmd.recency,
		limit: cmd.limit,
		xai_search_mode: cmd.xaiSearchMode,
		allowed_domains: cmd.allowedDomains,
		excluded_domains: cmd.excludedDomains,
		allowed_x_handles: cmd.allowedXHandles,
		excluded_x_handles: cmd.excludedXHandles,
		from_date: cmd.fromDate,
		to_date: cmd.toDate,
		enable_image_understanding: cmd.enableImageUnderstanding,
		enable_image_search: cmd.enableImageSearch,
		enable_video_understanding: cmd.enableVideoUnderstanding,
		no_inline_citations: cmd.noInlineCitations,
	};

	const result = await runSearchQuery(params);
	const component = renderSearchResult(result, { expanded: cmd.expanded, isPartial: false }, theme, {
		query: cmd.query,
		allowLongAnswer: true,
		maxAnswerLines: cmd.expanded ? undefined : 6,
	});

	const width = Math.max(60, process.stdout.columns ?? 100);
	process.stdout.write(`${component.render(width).join("\n")}\n`);

	if (result.details?.error) {
		process.exitCode = 1;
	}
}

export function printSearchHelp(): void {
	process.stdout.write(`${chalk.bold(`${APP_NAME} q`)} - Test web search providers

${chalk.bold("Usage:")}
  ${APP_NAME} q [options] <query>
  ${APP_NAME} web-search [options] <query>

${chalk.bold("Arguments:")}
  query      Search query text

${chalk.bold("Options:")}
  --provider <name>   Provider: ${PROVIDERS.join(", ")}
  --recency <value>   Recency filter: ${RECENCY_OPTIONS.join(", ")}
  --xai-mode <mode>   xAI mode: web, x, web_and_x
  --allowed-domain(s) d xAI web_search domain allow-list (comma-separated, repeatable)
  --excluded-domain(s) d xAI web_search domain deny-list (comma-separated, repeatable)
  --allowed-x-handle(s) h xAI x_search handle allow-list (comma-separated, repeatable)
  --excluded-x-handle(s) h xAI x_search handle deny-list (comma-separated, repeatable)
  --from-date <date>  xAI x_search start date (ISO8601)
  --to-date <date>    xAI x_search end date (ISO8601)
  --image-understanding Enable xAI image understanding
  --image-search      Enable xAI web image search
  --video-understanding Enable xAI X video understanding
  --no-inline-citations Disable xAI inline citation markdown
  -l, --limit <n>     Max results to return
  --compact           Render condensed output
  -h, --help          Show this help

${chalk.bold("Examples:")}
  ${APP_NAME} q --provider=exa "what's the color of the sky"
  ${APP_NAME} q --provider=brave --recency=week "latest TypeScript 5.7 changes"
`);
}
