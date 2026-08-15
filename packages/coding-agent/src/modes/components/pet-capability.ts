import {
	ImageProtocol,
	isUnderTerminalMultiplexer,
	onImageProtocolChanged,
	type SelectItem,
	shouldProbeSixelCapability,
	TERMINAL,
} from "@gajae-code/tui";
import type { PetTransportAvailability } from "./iterm-pet-transport";

export type PetPixelProtocol = "sixel" | "kitty" | "iterm";

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

let latestItermAvailability: PetTransportAvailability | undefined;
let verifiedItermAvailability: PetTransportAvailability | undefined;
const verifiedItermListeners = new Set<(availability: PetTransportAvailability | undefined) => void>();
export function subscribeVerifiedItermPetAvailability(
	callback: (availability: PetTransportAvailability | undefined) => void,
): () => void {
	verifiedItermListeners.add(callback);
	return () => verifiedItermListeners.delete(callback);
}
export function setVerifiedItermPetAvailability(availability: PetTransportAvailability | undefined): void {
	latestItermAvailability = availability;
	verifiedItermAvailability = availability?.available ? availability : undefined;
	for (const listener of verifiedItermListeners) listener(verifiedItermAvailability);
}
export function getItermPetAvailability(): PetTransportAvailability | undefined {
	return latestItermAvailability;
}
export function getVerifiedItermPetAvailability(): PetTransportAvailability | undefined {
	return verifiedItermAvailability;
}
export function getItermPetUnavailableReason(): string | undefined {
	return latestItermAvailability?.available ? undefined : latestItermAvailability?.reason;
}

export function getPetPixelProtocol(): PetPixelProtocol | null {
	if (TERMINAL.imageProtocol === ImageProtocol.Kitty && !isUnderTerminalMultiplexer()) return "kitty";
	if (TERMINAL.imageProtocol === ImageProtocol.Sixel) return "sixel";
	if (verifiedItermAvailability?.available) return "iterm";
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
		if (disabled) description = savedUnavailable ? PET_SAVED_UNAVAILABLE_DESCRIPTION : PET_UNAVAILABLE_DESCRIPTION;
		return { ...option, label: savedUnavailable ? `${option.label} (saved)` : option.label, description, disabled };
	});
}

export const PET_CAPABILITY_SETTLE_MS = 1_000;

export function isPetCapabilityProbePending(
	env: NodeJS.ProcessEnv = Bun.env,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (TERMINAL.imageProtocol !== null) return false;
	if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
	return shouldProbeSixelCapability(env, platform);
}

export function warnWhenPetCapabilitySettled(options: {
	probePending: boolean;
	isAvailable?: () => boolean;
	onUnavailable: () => void;
	settleMs?: number;
}): () => void {
	if (!options.probePending) {
		options.onUnavailable();
		return () => {};
	}
	const isAvailable = options.isAvailable ?? isPetAvailable;
	let settled = false;
	let unsubscribeIterm = () => {};
	const finish = () => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		unsubscribe();
		unsubscribeIterm();
	};
	const unsubscribe = onImageProtocolChanged(protocol => {
		if (!protocol) return;
		finish();
	});
	unsubscribeIterm = subscribeVerifiedItermPetAvailability(availability => {
		if (availability?.available) finish();
	});
	const timer = setTimeout(() => {
		finish();
		if (!isAvailable()) options.onUnavailable();
	}, options.settleMs ?? PET_CAPABILITY_SETTLE_MS);
	timer.unref?.();
	return finish;
}
