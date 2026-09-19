import { describe, expect, test } from "bun:test";
import { commands } from "../src/cli-main";
import {
	SESSION_LIMIT_RECOVERY_ACTIONS,
	SESSION_OVERSIZED_RECOVERY_MESSAGE,
	SessionNearLimitAppendError,
	SessionNearLimitRewriteError,
} from "../src/session/session-manager";
import { ACP_BUILTIN_SLASH_COMMANDS } from "../src/slash-commands/acp-builtins";
import { BUILTIN_SLASH_COMMAND_DEFS } from "../src/slash-commands/builtin-registry";

/**
 * Recovery guidance must only name commands a user can actually run, on every
 * surface that renders the message.
 *
 * The near-limit messages told users to run `gjc export <session-file>`. There is
 * no `export` subcommand (`cli-main.ts` registers none), so the shell started a
 * fresh interactive agent that read "export" as a prompt: the operator lost the
 * recovery they were told to perform and still held an unwritable session. The
 * root `--export` flag is unrelated — it renders HTML and exits, which never
 * produces a resumable session.
 *
 * It came back once already. `#5691` added a third near-limit error class with its
 * own hardcoded copy of the advice, and this matrix — which then enumerated only
 * the two append messages — could not see it. Cover the error FAMILY, not the
 * instances that happened to exist when the guard was written (#5732).
 *
 * Existence alone is not enough. `AgentSession` renders the near-limit guidance
 * to ACP/text consumers too, and `ACP_BUILTIN_SLASH_COMMANDS` is filtered to
 * definitions carrying `handle`, so a `handleTui`-only command is unreachable
 * there — a different dead end, not a fix. Both registries are checked.
 *
 * These tests pin the properties that matter (every referenced command resolves,
 * on every surface) rather than one blessed sentence, so rewording stays free
 * while an unreachable command fails.
 */

/** `gjc <name>` tokens referenced by a message, excluding root flags. */
function referencedCliCommands(message: string): string[] {
	return [...message.matchAll(/`gjc\s+([a-z][a-z0-9-]*)/g)].map(match => match[1]);
}

/**
 * `/name` slash commands referenced by a message.
 *
 * Bare (un-backticked) mentions count: guidance that drops the formatting must
 * not slip past the reachability guard.
 */
function referencedSlashCommands(message: string): string[] {
	return [...message.matchAll(/(?:^|[\s`(])\/([a-z][a-z0-9-]*)/g)].map(match => match[1]);
}

const cliCommandNames = new Set(commands.flatMap(entry => [entry.name, ...(entry.aliases ?? [])]));
const builtinSlashNames = new Set(BUILTIN_SLASH_COMMAND_DEFS.map(entry => entry.name));
const acpSlashNames = new Set(ACP_BUILTIN_SLASH_COMMANDS.map(entry => entry.name));

function nearLimitMessage(entryRetained: boolean): string {
	return new SessionNearLimitAppendError({
		entryBytes: 4096,
		liveBytes: 128 * 1024 * 1024 - 1024,
		capBytes: 128 * 1024 * 1024,
		entryRetained,
	}).message;
}

/**
 * Messages rendered by `AgentSession`, which reaches TUI and ACP/text alike.
 *
 * Every near-limit error class belongs here, not just the append one. `#5691` added
 * `SessionNearLimitRewriteError` with its own hardcoded copy of the advice and
 * reintroduced `gjc export <session-file>` — the exact command #5621 removed — because
 * this matrix only covered the append class and nothing failed.
 */
const inSessionMessages: Array<[string, string]> = [
	["near-limit append (entry retained)", nearLimitMessage(true)],
	["near-limit append (entry rolled back)", nearLimitMessage(false)],
	[
		"near-limit managed rewrite",
		new SessionNearLimitRewriteError({ transcriptBytes: 128 * 1024 * 1024 + 1, capBytes: 128 * 1024 * 1024 }).message,
	],
];

const allGuidanceMessages: Array<[string, string]> = [
	...inSessionMessages,
	["oversized resume", SESSION_OVERSIZED_RECOVERY_MESSAGE],
];

describe("session recovery guidance references runnable commands", () => {
	test.each(allGuidanceMessages)("%s names only registered CLI commands", (_label, message) => {
		for (const name of referencedCliCommands(message)) {
			expect(cliCommandNames).toContain(name);
		}
	});

	test.each(allGuidanceMessages)("%s names only registered slash commands", (_label, message) => {
		for (const name of referencedSlashCommands(message)) {
			expect(builtinSlashNames).toContain(name);
		}
	});

	test.each(inSessionMessages)("%s names only ACP-dispatchable slash commands", (_label, message) => {
		// AgentSession renders these to ACP/text clients, where the registry is
		// filtered to definitions carrying `handle`. A handleTui-only command
		// (e.g. `/new`) answers with an unknown-command diagnostic there.
		for (const name of referencedSlashCommands(message)) {
			expect(acpSlashNames).toContain(name);
		}
	});

	test("the guard rejects the `gjc export` instruction that shipped", () => {
		// Guards the detector itself: without this, deleting the recovery text
		// entirely would pass every assertion above.
		expect(referencedCliCommands("Use `gjc export <session-file>` to recover.")).toEqual(["export"]);
		expect(cliCommandNames).not.toContain("export");
	});

	test("the slash detector catches un-backticked mentions", () => {
		expect(referencedSlashCommands("Run /compact or `/clear` to continue.")).toEqual(["compact", "clear"]);
	});

	test("the ACP guard would reject a TUI-only command", () => {
		// Pins the gap that let `/new` through: it is a real builtin, so the
		// builtin-registry check alone passes while ACP cannot dispatch it.
		expect(builtinSlashNames).toContain("new");
		expect(acpSlashNames).not.toContain("new");
	});

	test("in-session guidance still offers at least one recovery action", () => {
		for (const [, message] of inSessionMessages) {
			expect(referencedSlashCommands(message).length).toBeGreaterThan(0);
		}
	});

	test("in-session guidance keeps the retained entry recoverable", () => {
		// The retained near-limit entry carries a pending full rewrite that only
		// survives while the manager does. Guidance must not name a session
		// switch, which closes the writer without paying that debt.
		for (const retained of [true, false]) {
			expect(referencedSlashCommands(nearLimitMessage(retained))).not.toContain("new");
			expect(referencedSlashCommands(nearLimitMessage(retained))).not.toContain("drop");
		}
	});

	test("oversized-resume guidance names no in-session command", () => {
		// That message is emitted before any session is open, so a slash command
		// would act on whichever session is resumed next — never the rejected one.
		expect(referencedSlashCommands(SESSION_OVERSIZED_RECOVERY_MESSAGE)).toEqual([]);
		expect(SESSION_OVERSIZED_RECOVERY_MESSAGE).not.toContain(SESSION_LIMIT_RECOVERY_ACTIONS);
	});
});
