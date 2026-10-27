import type { CommandEntry } from "@gajae-code/utils/cli";

/**
 * Public-family hooks kept available for private-worker tests without loading the
 * full registry.
 *
 * This is the single shared array: the inert entry (`cli.ts`) and the ordinary
 * dispatcher (`cli-ordinary.ts`) both re-export THIS object, so a test that
 * mutates or injects an entry keeps affecting the dispatcher.
 */
export const commands: CommandEntry[] = [
	{ name: "sdk", load: () => import("./commands/sdk").then(module => module.default) },
	{ name: "daemon", load: () => import("./commands/daemon").then(module => module.default) },
];
