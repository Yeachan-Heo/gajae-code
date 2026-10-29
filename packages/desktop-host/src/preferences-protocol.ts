/** Browser-safe preferences wire contract. No SDK or backend imports belong here. */
export type DesktopPreferenceOrigin = "default" | "global" | "project" | "runtime" | "layered";
export type DesktopPreferenceLayer = "global" | "project" | "runtime";

export interface DesktopPreferenceResolution {
	origin: DesktopPreferenceOrigin;
	layers: DesktopPreferenceLayer[];
}

export interface DesktopPreferenceCapability {
	available: boolean;
	reason: string | null;
}

export interface DesktopModelProfile {
	id: string;
	name: string;
	/** The public profile catalog does not currently provide descriptions. */
	description: string | null;
	source: "builtin" | "configured";
	active: boolean;
	default: boolean;
	capabilities: {
		/** Credentials and concrete model resolution are checked during activation. */
		selectSession: DesktopPreferenceCapability;
		persistDefault: DesktopPreferenceCapability;
	};
}

export type DesktopModelRoleId = "default" | "executor" | "architect" | "planner" | "critic" | "image";

export interface DesktopModelRolePreference {
	id: DesktopModelRoleId;
	name: string;
	configured: boolean;
	model: { id: string; provider: string; name: string } | null;
	thinkingLevel: string | null;
	/** Resolution of the containing role map, not proof of this individual entry's ownership. */
	configurationResolution: DesktopPreferenceResolution;
	canApply: DesktopPreferenceCapability;
}

export type DesktopSamplingParameter =
	| "temperature"
	| "topP"
	| "topK"
	| "minP"
	| "presencePenalty"
	| "repetitionPenalty";

export interface DesktopSamplingPreference {
	parameter: DesktopSamplingParameter;
	/** Merged Settings value; -1 is the canonical provider-default sentinel. */
	configuredValue: number | null;
	/** Next-run agent option, not a claim that the provider transmits or accepts it. */
	effectiveValue: number | null;
	mode: "value" | "provider-default" | "invalid";
	resolution: DesktopPreferenceResolution;
	application: "next-run";
	modelSupport: "unknown";
	canApply: DesktopPreferenceCapability;
}

export interface DesktopPreferences {
	profiles: DesktopModelProfile[];
	roles: DesktopModelRolePreference[];
	sampling: DesktopSamplingPreference[];
}

/** Explicit operations only: never an arbitrary setting path, patch, owner or authority flag. */
export type DesktopPreferenceAction =
	| { type: "profile.select"; name: string; scope: "session" | "default" }
	| { type: "role.set"; role: DesktopModelRoleId; modelId: string }
	| { type: "sampling.set"; parameter: DesktopSamplingParameter; value: number; scope: "session" | "default" };

export interface DesktopPreferenceResult {
	applied: "profile.select";
	profileId: string;
	scope: "session" | "default";
	durability: "session" | "persisted";
	preferences: DesktopPreferences;
}
