/**
 * Test web search providers.
 */
import { Args, Command, Flags } from "@gajae-code/utils/cli";
import { runSearchCommand, type SearchCommandArgs } from "../cli/web-search-cli";
import { SEARCH_PROVIDER_ORDER } from "../web/search/provider";

const PROVIDERS: Array<string> = ["auto", ...SEARCH_PROVIDER_ORDER];

const RECENCY: NonNullable<SearchCommandArgs["recency"]>[] = ["day", "week", "month", "year"];

type ListFlagValue = string | string[] | undefined;

function appendCsv(existing: string[] | undefined, raw: ListFlagValue): string[] | undefined {
	const rawValues = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
	const values = rawValues
		.flatMap(value => value.split(","))
		.map(value => value.trim())
		.filter(Boolean);
	if (values.length === 0) return existing;
	return [...(existing ?? []), ...values];
}

function combineCsv(...values: ListFlagValue[]): string[] | undefined {
	return values.reduce<string[] | undefined>((acc, value) => appendCsv(acc, value), undefined);
}

export default class Search extends Command {
	static description = "Test web search providers";

	static aliases = ["q"];

	static args = {
		query: Args.string({ description: "Search query text", required: false, multiple: true }),
	};

	static flags = {
		provider: Flags.string({ description: "Search provider", options: PROVIDERS }),
		recency: Flags.string({ description: "Recency filter", options: RECENCY }),
		limit: Flags.integer({ char: "l", description: "Max results to return" }),
		"xai-mode": Flags.string({ description: "xAI mode", options: ["web", "x", "web_and_x"] }),
		"allowed-domain": Flags.string({
			description: "xAI web_search allowed domains, comma-separated",
			multiple: true,
		}),
		"allowed-domains": Flags.string({
			description: "xAI web_search allowed domains, comma-separated",
			multiple: true,
		}),
		"excluded-domain": Flags.string({
			description: "xAI web_search excluded domains, comma-separated",
			multiple: true,
		}),
		"excluded-domains": Flags.string({
			description: "xAI web_search excluded domains, comma-separated",
			multiple: true,
		}),
		"allowed-x-handle": Flags.string({
			description: "xAI x_search allowed handles, comma-separated",
			multiple: true,
		}),
		"allowed-x-handles": Flags.string({
			description: "xAI x_search allowed handles, comma-separated",
			multiple: true,
		}),
		"excluded-x-handle": Flags.string({
			description: "xAI x_search excluded handles, comma-separated",
			multiple: true,
		}),
		"excluded-x-handles": Flags.string({
			description: "xAI x_search excluded handles, comma-separated",
			multiple: true,
		}),
		"from-date": Flags.string({ description: "xAI x_search start date (ISO8601)" }),
		"to-date": Flags.string({ description: "xAI x_search end date (ISO8601)" }),
		"image-understanding": Flags.boolean({ description: "Enable xAI image understanding" }),
		"image-search": Flags.boolean({ description: "Enable xAI web image search" }),
		"video-understanding": Flags.boolean({ description: "Enable xAI X video understanding" }),
		"no-inline-citations": Flags.boolean({ description: "Disable xAI inline citation markdown" }),
		compact: Flags.boolean({ description: "Render condensed output" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Search);
		const query = Array.isArray(args.query) ? args.query.join(" ") : (args.query ?? "");

		const cmd: SearchCommandArgs = {
			query,
			provider: flags.provider as SearchCommandArgs["provider"],
			recency: flags.recency as SearchCommandArgs["recency"],
			limit: flags.limit,
			expanded: !flags.compact,
			xaiSearchMode: flags["xai-mode"] as SearchCommandArgs["xaiSearchMode"],
			allowedDomains: combineCsv(flags["allowed-domain"], flags["allowed-domains"]),
			excludedDomains: combineCsv(flags["excluded-domain"], flags["excluded-domains"]),
			allowedXHandles: combineCsv(flags["allowed-x-handle"], flags["allowed-x-handles"]),
			excludedXHandles: combineCsv(flags["excluded-x-handle"], flags["excluded-x-handles"]),
			fromDate: flags["from-date"],
			toDate: flags["to-date"],
			enableImageUnderstanding: flags["image-understanding"],
			enableImageSearch: flags["image-search"],
			enableVideoUnderstanding: flags["video-understanding"],
			noInlineCitations: flags["no-inline-citations"],
		};

		await runSearchCommand(cmd);
	}
}
