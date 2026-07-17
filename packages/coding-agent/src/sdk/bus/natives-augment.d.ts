/**
 * Worktree-local module augmentation for the v3 SDK connection lane added to
 * the pi-natives NotificationServer in this branch (onSdkFrame / sendTo /
 * onConnectionClose). Linked sibling checkouts sharing the root node_modules
 * can dedupe `@gajae-code/natives` declarations by package ID to an older
 * generated file; this augmentation guarantees the new members are visible and
 * is a harmless re-declaration when the resolved declarations already have
 * them.
 */
import "@gajae-code/natives";

declare module "@gajae-code/natives" {
	interface SdkFrameEvent {
		connectionId: string;
		json: string;
	}
	interface PresentationLease {
		actionId: string;
		registrationEpoch: number;
	}
	interface RetireIfUnclaimedResult {
		status: "retired" | "already_terminal" | "claimed" | "stale";
	}
	interface NotificationServer {
		/** Register the raw v3 SDK frame callback. Must be called before start. */
		onSdkFrame(callback: (err: null | Error, frame: SdkFrameEvent) => void): void;
		/** Register the connection-close callback. Must be called before start. */
		onConnectionClose(callback: (err: null | Error, connectionId: string) => void): void;
		/** Register negotiated v3 client capabilities. Must be called before start. */
		onNegotiatedCapabilities(
			callback: (err: null | Error, connectionId: string, capabilities: string[]) => void,
		): void;
		/** Directed delivery of a validated, bounded JSON v3 envelope to one connection. */
		sendTo(connectionId: string, json: string): void;
		/** Register a correlated workflow-gate action_needed frame. */
		registerWorkflowGateAsk(workflowJson: string, repliable: boolean): void;
		/** Atomically register the single active arbitrated action and return its private lease. */
		registerArbitratedAsk(actionJson: string, repliable: boolean): PresentationLease;
		/** Retire an exact private lease unless a generic reply has already claimed it. */
		retireIfUnclaimed(lease: PresentationLease): RetireIfUnclaimedResult;
	}
}
