import type { DesktopActivityGate } from "./activity-protocol";

/** Browser-only data. IDs identify issued surfaces, never SDK gates or grants. */
export interface DesktopGatePresentation {
	id: string;
	gate: DesktopActivityGate;
}

export type DesktopGatePresentationEvent =
	| { type: "presented"; presentation: DesktopGatePresentation }
	| { type: "retire"; presentationId: string; nonce: string };

export type DesktopGatePresentationErrorCode =
	| "unavailable"
	| "registration_failed"
	| "revoked"
	| "invalid_presentation"
	| "not_presented"
	| "invalid_retirement"
	| "stale_presentation"
	| "capacity"
	| "busy"
	| "callback_failed"
	| "retirement_timeout";
