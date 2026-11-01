/** Manage stored OAuth accounts without exposing credential payloads. */
import { Args, Command, Flags, renderCommandHelp } from "@gajae-code/utils/cli";
import {
	ACCOUNTS_ACTIONS,
	type AccountsAction,
	type AccountsCommandArgs,
	runAccountsCommand,
} from "../cli/accounts-cli";

export default class Accounts extends Command {
	static description = "List, check, pin, prefer, and remove stored OAuth accounts";
	static strict = true;

	static args = {
		action: Args.string({
			description: "Account action",
			required: false,
			options: [...ACCOUNTS_ACTIONS],
		}),
		provider: Args.string({
			description: "Provider id",
			required: false,
		}),
		selector: Args.string({
			description:
				"Account selector (bare email, id:, email:, or account:); prefer takes several in order, each optionally =<max used percent>",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output safe machine-readable JSON" }),
		persistent: Flags.boolean({ description: "Required for persistent pin changes" }),
		clear: Flags.boolean({ description: "Clear the persistent pin or preferred accounts" }),
		account: Flags.string({ description: "Logout one account by row id, email, or org:<organization id or name>" }),
		all: Flags.boolean({ description: "Logout every OAuth account for the provider" }),
	};

	static examples = [
		"gjc accounts list",
		"gjc accounts list --json",
		"gjc accounts check",
		"gjc accounts check anthropic --json",
		"gjc accounts pin anthropic me@example.com --persistent",
		"gjc accounts pin anthropic id:42 --persistent",
		"gjc accounts pin anthropic 'org:Acme Team' --persistent",
		"gjc accounts pin anthropic --clear --persistent",
		"gjc accounts prefer anthropic cheap@example.com shared@example.com=75",
		"gjc accounts prefer anthropic --clear",
		"gjc accounts logout anthropic --account me@example.com",
		"gjc accounts logout anthropic --all",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Accounts);
		if (!args.action) {
			renderCommandHelp("gjc", "accounts", Accounts);
			return;
		}
		const action = args.action as AccountsAction;
		const cmd: AccountsCommandArgs = {
			action,
			provider: args.provider,
			selectors: Array.isArray(args.selector) ? args.selector : args.selector ? [args.selector] : undefined,
			flags: {
				json: flags.json,
				persistent: flags.persistent,
				clear: flags.clear,
				account: flags.account,
				all: flags.all,
			},
		};
		await runAccountsCommand(cmd);
	}
}
