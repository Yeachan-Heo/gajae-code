const BEGINNER_HIDDEN_EXTENSION_COMMANDS = new Set(["grok-build-usage"]);

export function shouldShowExtensionCommand(name: string, activeProvider: string | undefined): boolean {
	if (!BEGINNER_HIDDEN_EXTENSION_COMMANDS.has(name)) return true;
	if (name === "grok-build-usage") {
		return activeProvider === "grok-build" || Boolean(process.env.GROK_CLI_OAUTH_TOKEN);
	}
	return true;
}
