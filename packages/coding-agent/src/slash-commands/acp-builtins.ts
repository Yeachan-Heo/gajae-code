import type { AvailableCommand } from "@agentclientprotocol/sdk";
import {
	BUILTIN_SLASH_COMMANDS_INTERNAL,
	formatUnknownBuiltinSlashCommandDiagnostic,
	lookupBuiltinSlashCommand,
} from "./builtin-registry";
import { parseSlashCommand } from "./helpers/parse";
import type { AcpBuiltinCommandRuntime, AcpBuiltinSlashCommandResult } from "./types";

export type { AcpBuiltinCommandRuntime, AcpBuiltinSlashCommandResult } from "./types";

/**
 * Commands advertised to ACP clients. Entries without a text-mode `handle`
 * (e.g. `/quit`, `/login`, dashboards) are filtered out so the client doesn't
 * see commands it cannot drive.
 */
export const ACP_BUILTIN_SLASH_COMMANDS: AvailableCommand[] = BUILTIN_SLASH_COMMANDS_INTERNAL.filter(
	command => command.handle !== undefined,
).map(command => {
	// Honor mode-specific copy: ACP clients receive concise text-mode
	// descriptions/hints when the spec sets `acpDescription` / `acpInputHint`,
	// otherwise fall back to the unified `description` / `inlineHint`.
	const hint = command.acpInputHint ?? command.inlineHint;
	return {
		name: command.name,
		description: command.acpDescription ?? command.description,
		input: hint ? { hint } : undefined,
	};
});

/**
 * Dispatch a slash command in ACP/text mode. Returns:
 * - `false` when no builtin matched (or matched a TUI-only entry); the caller
 *   should forward the input as a prompt.
 * - `{ consumed: true }` when the command handled the input entirely.
 * - `{ prompt }` when the command was handled but a residual prompt should be
 *   sent to the model.
 */
export async function executeAcpBuiltinSlashCommand(
	text: string,
	runtime: AcpBuiltinCommandRuntime,
): Promise<AcpBuiltinSlashCommandResult> {
	const parsed = parseSlashCommand(text);
	if (!parsed) return false;
	const command = lookupBuiltinSlashCommand(parsed.name);
	if (!command?.handle) {
		const diagnostic = formatUnknownBuiltinSlashCommandDiagnostic(parsed.name);
		if (!diagnostic) return false;
		await runtime.output(diagnostic);
		return { consumed: true };
	}
	const result = await command.handle(parsed, runtime);
	if (result === undefined) return { consumed: true };
	return result;
}
