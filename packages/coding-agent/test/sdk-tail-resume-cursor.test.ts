import { expect, test } from "bun:test";
import { stripSecretFields } from "../src/sdk/cli/rows";

/**
 * `sdk session tail` must hand its caller the host's signed checkpoint cursor,
 * or no tail can ever be resumed and every poll replays the whole session.
 *
 * The host mints it as `checkpointToken`; the CLI's output pass
 * (`stripSecretFields`) drops any key matching /token/i by NAME, so under that
 * name the value never reached stdout (observed: a gateway polling a live
 * session replayed ~300 historical items per poll and rejected 614 frames per
 * turn as pre-turn history). The CLI therefore emits it as `cursor`, the same
 * opaque per-grant continuation shape `list` and `transcript` already return.
 * This pins both halves: the name the CLI must NOT use, and the one it uses.
 */
test("a checkpoint cursor named `cursor` survives output redaction; named `checkpointToken` it does not", () => {
	const minted = "v1.eyJzZXNzaW9uSWQiOiJhYmMifQ.signature";
	const stripped = stripSecretFields({
		checkpoint: { revision: 2, generation: 1, seq: 4 },
		checkpointToken: minted,
		cursor: minted,
		items: [],
		terminal: false,
	}) as Record<string, unknown>;
	// Defense-in-depth redaction is intact - the /token/i name is still stripped.
	expect("checkpointToken" in stripped).toBe(false);
	// And the resumable cursor reaches the caller under the name tail emits.
	expect(stripped.cursor).toBe(minted);
	expect(stripped.checkpoint).toEqual({ revision: 2, generation: 1, seq: 4 });
});
