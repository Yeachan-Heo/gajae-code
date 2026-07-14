import { ImageProtocol, isUnderTerminalMultiplexer, type SelectItem, TERMINAL } from "@gajae-code/tui";

export type PetPixelProtocol = "sixel" | "kitty";

export const PET_UNAVAILABLE_DESCRIPTION = "Unavailable: requires compatible Kitty or Sixel overlay rendering";
export const PET_SAVED_UNAVAILABLE_DESCRIPTION =
	"Saved, unavailable — requires compatible Kitty or Sixel overlay rendering";
export const PET_UNAVAILABLE_WARNING =
	"⚠ Pets aren’t available in this terminal. Its image support isn’t compatible with Gajae Pet’s overlay rendering yet. Try Kitty, Ghostty, WezTerm, or a terminal with compatible Sixel support.";
const PET_MULTIPLEXER_UNAVAILABLE_WARNING =
	"⚠ Gajae Pet graphics are unavailable inside tmux, screen, or zellij because image escapes are not forwarded end to end. Run gjc outside the multiplexer, or set PI_FORCE_IMAGE_PROTOCOL=sixel only when the full terminal chain supports Sixel.";

export function getPetUnavailableWarning(env: NodeJS.ProcessEnv = Bun.env): string {
	return isUnderTerminalMultiplexer(env) ? PET_MULTIPLEXER_UNAVAILABLE_WARNING : PET_UNAVAILABLE_WARNING;
}

export function getPetPixelProtocol(): PetPixelProtocol | null {
	if (TERMINAL.imageProtocol === ImageProtocol.Kitty) return "kitty";
	if (TERMINAL.imageProtocol === ImageProtocol.Sixel) return "sixel";
	return null;
}

export function isPetAvailable(): boolean {
	return getPetPixelProtocol() !== null;
}

export function createPetSelectItems(
	options: ReadonlyArray<SelectItem>,
	currentValue: string,
	available: boolean,
): SelectItem[] {
	return options.map(option => {
		const disabled = !available && option.value !== "off";
		const current = option.value === currentValue;
		const savedUnavailable = disabled && current;
		let description = `${option.description ?? ""}${current ? " (current)" : ""}`;
		if (disabled) {
			description = savedUnavailable ? PET_SAVED_UNAVAILABLE_DESCRIPTION : PET_UNAVAILABLE_DESCRIPTION;
		}
		return {
			...option,
			label: savedUnavailable ? `${option.label} (saved)` : option.label,
			description,
			disabled,
		};
	});
}
