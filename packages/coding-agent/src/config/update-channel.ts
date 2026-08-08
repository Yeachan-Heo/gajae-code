/**
 * Release-channel primitives shared by the self-update command and the
 * startup update check.
 *
 * Kept in the config layer (no shell, theme, or updater imports) so the
 * startup path in main.ts can resolve the channel without pulling in the
 * updater implementation.
 */
export const UPDATE_CHANNELS = ["stable", "nightly"] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

export function isUpdateChannel(value: string): value is UpdateChannel {
	return (UPDATE_CHANNELS as readonly string[]).includes(value);
}

/** npm dist-tag backing each release channel. `latest` is the stable tag; nightly publishes never move it. */
export function distTagForChannel(channel: UpdateChannel): string {
	return channel === "nightly" ? "nightly" : "latest";
}
