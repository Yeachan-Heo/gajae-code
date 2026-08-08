import type { Settings } from "../config/settings";
import { createMemoryBackendService } from "../memory-backend/service";
import type { MemoryBackend } from "../memory-backend/types";
import type { LazyService } from "./lazy-service";
import type { NetworkPrewarmRuntime } from "./network-prewarm-service";
import { createNetworkPrewarmService } from "./network-prewarm-service";
import { createWorkspaceTreeService, type WorkspaceTreeRuntime } from "./workspace-tree-service";

/** Runtime services that may be initialized on demand by a session. */
export interface OptionalRuntimeServices {
	memoryBackend: LazyService<MemoryBackend>;
	workspaceTree: LazyService<WorkspaceTreeRuntime>;
	networkPrewarm: LazyService<NetworkPrewarmRuntime>;
	// Later milestones add: notifications, history, lsp, pythonEval, javascriptEval,
	// stt, gjcPlugins, nativeSyntax.
}

/** Caller-provided runtime services; omitted entries receive their defaults. */
export type OptionalRuntimeServicesOverrides = Partial<OptionalRuntimeServices>;

/** Context needed by services whose identity is scoped to the session cwd. */
export interface OptionalRuntimeServicesContext {
	cwd?: string;
}

/**
 * Fill the optional runtime-service container with the defaults for this
 * settings instance, preserving any caller-owned service overrides.
 */
export function createOptionalRuntimeServices(
	settings: Settings,
	overrides: OptionalRuntimeServicesOverrides = {},
	context: OptionalRuntimeServicesContext = {},
): OptionalRuntimeServices {
	const cwd = context.cwd ?? process.cwd();
	return {
		memoryBackend: overrides.memoryBackend ?? createMemoryBackendService(settings),
		workspaceTree: overrides.workspaceTree ?? createWorkspaceTreeService(settings, cwd),
		networkPrewarm: overrides.networkPrewarm ?? createNetworkPrewarmService(settings),
	};
}
