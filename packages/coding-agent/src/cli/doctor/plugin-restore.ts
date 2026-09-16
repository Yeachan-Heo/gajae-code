import {
	applyGjcBundleRestore,
	authorizeGjcBundleRestore,
	type GjcLifecycleContext,
	previewGjcBundleRestore,
} from "../../extensibility/gjc-plugins/lifecycle";
import type {
	GjcBundleIdentity,
	GjcLifecycleResult,
	GjcUpdateApplyResult,
	LocalRestorePlanV1,
	ReviewedRestoreTokenV1,
} from "../../extensibility/gjc-plugins/types";
import type {
	MarketplaceManager,
	MarketplaceRestoreApplyResult,
	MarketplaceRestorePlanV1,
	MarketplaceReviewedRestoreTokenV1,
} from "../../extensibility/plugins/marketplace/manager";

export interface PluginRestoreTargetV1 {
	identity: GjcBundleIdentity;
	cwd: string;
}

export type PluginRestoreActionV1 =
	| { kind: "preview"; target: PluginRestoreTargetV1 }
	| { kind: "authorize"; target: PluginRestoreTargetV1; plan: LocalRestorePlanV1; authorizations: readonly string[] }
	| { kind: "apply"; target: PluginRestoreTargetV1; token: ReviewedRestoreTokenV1 }
	| { kind: "marketplace-preview"; manager: MarketplaceManager; pluginId: string; scope: "user" | "project" }
	| {
			kind: "marketplace-authorize";
			manager: MarketplaceManager;
			plan: MarketplaceRestorePlanV1;
			authorizations: readonly string[];
	  }
	| { kind: "marketplace-apply"; manager: MarketplaceManager; token: MarketplaceReviewedRestoreTokenV1 };

/**
 * Typed doctor dispatch surface for both restore lanes (GJC bundles and
 * proven-private marketplace plugins). Every branch is action + explicit
 * authorization before any effect; `action` alone never authorizes a write.
 */
export type PluginRestoreActionResultV1 =
	| GjcLifecycleResult<LocalRestorePlanV1 | ReviewedRestoreTokenV1 | GjcUpdateApplyResult>
	| MarketplaceRestorePlanV1
	| MarketplaceReviewedRestoreTokenV1
	| MarketplaceRestoreApplyResult;

export async function runPluginRestoreAction(action: PluginRestoreActionV1): Promise<PluginRestoreActionResultV1> {
	if (action.kind === "marketplace-preview") return action.manager.previewPluginRestore(action.pluginId, action.scope);
	if (action.kind === "marketplace-authorize")
		return action.manager.authorizePluginRestore(action.plan, action.authorizations);
	if (action.kind === "marketplace-apply") return action.manager.applyPluginRestore(action.token);
	const ctx: GjcLifecycleContext = { cwd: action.target.cwd };
	if (action.kind === "preview") return previewGjcBundleRestore(ctx, action.target.identity);
	if (action.kind === "authorize") return authorizeGjcBundleRestore(ctx, action.plan, action.authorizations);
	return applyGjcBundleRestore(ctx, action.token);
}
