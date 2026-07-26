/**
 * Ordering seam for an in-band SDK identity transition.
 *
 * A request arrives through predecessor A, so a successful terminal response cannot
 * be published until successor B is ready. Native builds may provide a true
 * send-only connection lease; source/dev builds use the conservative fallback in
 * which the predecessor server remains alive until the terminal write completes.
 */

export type TerminalSendOutcome = "written" | "disconnected" | "write_failed";

/** Fence/capability hooks may return false to reject; undefined means ok. */
export type IdentityControlGateResult = boolean | undefined;
export type IdentityControlGate = () => IdentityControlGateResult | Promise<IdentityControlGateResult>;

export interface IdentityControlSuccessPathInput {
	/** Fence predecessor inbound work. The fence must not close its response writer. */
	fence: IdentityControlGate;
	/** Optional explicit proof that the predecessor writer is still usable. */
	ensurePredecessorSendCapable?: IdentityControlGate;
	/** Start successor B and resolve only after its public endpoint is ready. */
	startSuccessor: () => Promise<void>;
	/** Write and flush either the success or non-success terminal response. */
	sendTerminal: () => Promise<TerminalSendOutcome>;
	/** Release predecessor A after the terminal response has settled. */
	stopPredecessor: () => Promise<void>;
	/** Set only when a caller cannot use the retained-writer fallback. */
	requireNativeControlDrain?: boolean;
}

export interface IdentityControlTerminalPathInput {
	fenceInbound: IdentityControlGate;
	ensurePredecessorSendCapable?: IdentityControlGate;
	startSuccessorReady: () => Promise<void>;
	sendTerminal: () => Promise<TerminalSendOutcome>;
	stopPredecessor: () => Promise<void>;
	requireNativeControlDrain?: boolean;
}

/**
 * Probe the loaded native addon, never an environment flag or a TypeScript shim.
 * Older/source installs intentionally report false so callers can select the
 * retained-writer fallback or fail closed when detach is mandatory.
 */
export function isNativeControlDrainAvailable(): boolean {
	try {
		// Keep the addon lazy: importing the bus must continue to work without a
		// compiled native artifact (tests and source distributions do that often).
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const natives = require("@gajae-code/natives") as {
			NotificationServer?: {
				prototype?: Record<string, unknown>;
			};
		};
		const prototype = natives.NotificationServer?.prototype;
		return (
			typeof prototype?.acquireControlDrain === "function" &&
			typeof prototype?.sendTerminalAndWait === "function" &&
			typeof prototype?.closeControlDrain === "function"
		);
	} catch {
		return false;
	}
}

/**
 * Run the only safe ordering for a successful identity-control response.
 *
 * The `finally` is deliberately around both successor startup and terminal
 * delivery: a failed startup must not leave the fenced predecessor alive, and a
 * failed/disconnected terminal write must still release it. When native detach
 * is unavailable the caller is expected to keep A's server up (not call
 * `stopAndWait`) until `sendTerminal` settles.
 */
export async function runIdentityControlSuccessPath(
	input: IdentityControlSuccessPathInput,
): Promise<TerminalSendOutcome> {
	if (input.requireNativeControlDrain && !isNativeControlDrainAvailable())
		throw new Error("SDK identity control requires the native control-drain lease.");

	if ((await input.fence()) === false) throw new Error("SDK identity control predecessor fence was not acquired.");
	if ((await input.ensurePredecessorSendCapable?.()) === false)
		throw new Error("SDK identity control predecessor writer is not send-capable.");
	try {
		await input.startSuccessor();
		return await input.sendTerminal();
	} finally {
		await input.stopPredecessor();
	}
}

/** Compatibility spelling used by the host wiring design notes. */
export async function runIdentityControlTerminalPath(
	input: IdentityControlTerminalPathInput,
): Promise<TerminalSendOutcome> {
	return runIdentityControlSuccessPath({
		fence: input.fenceInbound,
		ensurePredecessorSendCapable: input.ensurePredecessorSendCapable,
		startSuccessor: input.startSuccessorReady,
		sendTerminal: input.sendTerminal,
		stopPredecessor: input.stopPredecessor,
		requireNativeControlDrain: input.requireNativeControlDrain,
	});
}
