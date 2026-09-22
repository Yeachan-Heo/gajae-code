import type { MarkitPluginAPI, PluginDef, PluginFunction } from "./types.js";
export declare function createPluginAPI(pluginId: string): {
    api: MarkitPluginAPI;
    resolve: () => PluginDef;
};
export declare function isPluginFunction(val: any): val is PluginFunction;
export declare function resolvePluginExport(exported: PluginFunction | PluginDef, pluginId: string): PluginDef;
