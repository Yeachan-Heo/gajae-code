import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findConfigDir } from "../config.js";
import { resolvePluginExport } from "./api.js";
export async function loadPluginFromPath(path) {
    let absPath = resolve(path);
    // Directory → find entry point
    if (existsSync(absPath) && statSync(absPath).isDirectory()) {
        const candidates = [
            join(absPath, "src", "index.ts"),
            join(absPath, "src", "index.js"),
            join(absPath, "index.ts"),
            join(absPath, "index.js"),
        ];
        const pkgPath = join(absPath, "package.json");
        if (existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
                if (pkg.main)
                    candidates.unshift(join(absPath, pkg.main));
            }
            catch { }
        }
        const found = candidates.find((c) => existsSync(c));
        if (found) {
            absPath = found;
        }
        else {
            throw new Error(`No entry point found in ${absPath}`);
        }
    }
    const mod = await import(pathToFileURL(absPath).href);
    const pluginId = absPath.replace(/.*\//, "").replace(/\.(ts|js)$/, "");
    return resolvePluginExport(mod.default, pluginId);
}
/**
 * Load all plugins from .markit/plugins.json
 */
export async function loadAllPlugins() {
    const plugins = [];
    const configDir = findConfigDir();
    if (!configDir)
        return plugins;
    const pluginsFile = join(configDir, "plugins.json");
    if (!existsSync(pluginsFile))
        return plugins;
    try {
        const data = JSON.parse(readFileSync(pluginsFile, "utf-8"));
        const entries = data.plugins ?? [];
        for (const entry of entries) {
            const p = typeof entry === "string" ? entry : entry.path;
            try {
                plugins.push(await loadPluginFromPath(p));
            }
            catch { }
        }
    }
    catch { }
    return plugins;
}
