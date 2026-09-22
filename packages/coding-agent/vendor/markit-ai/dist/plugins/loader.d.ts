import type { PluginDef } from "./types.js";
export declare function loadPluginFromPath(path: string): Promise<PluginDef>;
/**
 * Load all plugins from .markit/plugins.json
 */
export declare function loadAllPlugins(): Promise<PluginDef[]>;
