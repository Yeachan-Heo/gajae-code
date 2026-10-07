import type { KeyId } from "@gajae-code/tui";

/**
 * Characters macOS composes for Option+<letter> on the US/ABC layout when the
 * terminal sends Option as text instead of Alt/Meta. Dead-key letters (e, i, n,
 * u) compose nothing on their own and are absent.
 */
const MACOS_OPTION_COMPOSED_KEYS: ReadonlyMap<string, KeyId> = new Map<string, KeyId>([
	["å", "alt+a"],
	["∫", "alt+b"],
	["ç", "alt+c"],
	["∂", "alt+d"],
	["ƒ", "alt+f"],
	["©", "alt+g"],
	["˙", "alt+h"],
	["∆", "alt+j"],
	["˚", "alt+k"],
	["¬", "alt+l"],
	["µ", "alt+m"],
	["ø", "alt+o"],
	["π", "alt+p"],
	["œ", "alt+q"],
	["®", "alt+r"],
	["ß", "alt+s"],
	["†", "alt+t"],
	["√", "alt+v"],
	["∑", "alt+w"],
	["≈", "alt+x"],
	["¥", "alt+y"],
	["Ω", "alt+z"],
]);

/** The Option chord that composes `text` on the macOS US/ABC layout, if any. */
export function macosOptionChordForComposedText(text: string): KeyId | undefined {
	return MACOS_OPTION_COMPOSED_KEYS.get(text);
}

/** Terminal-specific instruction for sending Option as Alt/Meta, when the terminal is known. */
export function macosOptionForwardingInstruction(terminalProgram: string | undefined): string | undefined {
	const program = terminalProgram?.toLowerCase() ?? "";
	if (program.includes("ghostty")) {
		return "Ghostty: set macos-option-as-alt = true in its config, then reload the config or restart Ghostty.";
	}
	if (program === "apple_terminal") {
		return "Terminal.app: enable Settings > Profiles > Keyboard > Use Option as Meta key.";
	}
	if (program === "iterm.app") {
		return "iTerm2: set Settings > Profiles > Keys > Left and Right Option key to Esc+.";
	}
	return undefined;
}

export interface UnforwardedOptionChordWarnerOptions {
	platform: NodeJS.Platform;
	terminalProgram: string | undefined;
	formatKeyHint: (key: KeyId) => string;
	showWarning: (message: string) => void;
}

/**
 * Builds the composer callback that explains, once, why a bound Option shortcut
 * produced a character instead of firing. Returns undefined off macOS, where the
 * composition table does not apply.
 */
export function createUnforwardedOptionChordWarner(
	options: UnforwardedOptionChordWarnerOptions,
): ((key: KeyId, text: string) => void) | undefined {
	if (options.platform !== "darwin") return undefined;
	let warned = false;
	return (key, text) => {
		if (warned) return;
		warned = true;
		const instruction =
			macosOptionForwardingInstruction(options.terminalProgram) ??
			"Configure the terminal to send Option as Alt/Meta (Esc+).";
		options.showWarning(
			`${options.formatKeyHint(key)} arrived as "${text}": the terminal is sending Option as text, so Option shortcuts cannot reach GJC. ${instruction} Or remap the shortcut to a Control chord in keybindings.json.`,
		);
	};
}
