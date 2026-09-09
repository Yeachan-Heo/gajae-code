export interface PluginSource {
    type: "npm" | "git" | "local";
    name: string;
    ref?: string;
    url?: string;
    path?: string;
    subpath?: string;
}
export interface InstalledPlugin {
    source: string;
    path: string;
    name?: string;
}
export declare function parsePluginSource(source: string): PluginSource;
export declare function installPlugin(source: string): Promise<{
    path: string;
    name: string;
}>;
export declare function removePlugin(name: string): boolean;
export declare function listInstalled(): Array<{
    name: string;
    type: string;
    source: string;
    path: string;
}>;
