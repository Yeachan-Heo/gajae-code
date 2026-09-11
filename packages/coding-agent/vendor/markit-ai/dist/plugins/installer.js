import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, } from "node:fs";
import { basename, join, resolve } from "node:path";
import { findConfigDir } from "../config.js";
const PLUGINS_FILE = "plugins.json";
export function parsePluginSource(source) {
    // npm:package@version
    if (source.startsWith("npm:")) {
        const rest = source.slice(4);
        let name;
        let ref;
        if (rest.startsWith("@")) {
            const lastAt = rest.lastIndexOf("@");
            if (lastAt > 0 && lastAt !== rest.indexOf("@")) {
                name = rest.slice(0, lastAt);
                ref = rest.slice(lastAt + 1);
            }
            else {
                name = rest;
            }
        }
        else {
            const atIdx = rest.indexOf("@");
            if (atIdx > 0) {
                name = rest.slice(0, atIdx);
                ref = rest.slice(atIdx + 1);
            }
            else {
                name = rest;
            }
        }
        return { type: "npm", name, ref };
    }
    // git:url or https://...
    if (source.startsWith("git:") ||
        source.startsWith("https://") ||
        source.startsWith("http://") ||
        source.startsWith("ssh://")) {
        let raw = source;
        if (raw.startsWith("git:"))
            raw = raw.slice(4);
        let subpath;
        const hashIdx = raw.indexOf("#");
        if (hashIdx > 0) {
            subpath = raw.slice(hashIdx + 1);
            raw = raw.slice(0, hashIdx);
        }
        let ref;
        const atIdx = raw.lastIndexOf("@");
        if (atIdx > 0 && !raw.slice(atIdx).includes("/")) {
            ref = raw.slice(atIdx + 1);
            raw = raw.slice(0, atIdx);
        }
        let url = raw;
        if (!url.startsWith("http://") &&
            !url.startsWith("https://") &&
            !url.startsWith("ssh://")) {
            url = `https://${url}`;
        }
        if (!url.endsWith(".git"))
            url += ".git";
        const name = subpath ? basename(subpath) : basename(url, ".git");
        return { type: "git", name, url, ref, subpath };
    }
    // Local path
    const absPath = resolve(source);
    const name = basename(absPath).replace(/\.(ts|js)$/, "");
    return { type: "local", name, path: absPath };
}
function getPluginsDir() {
    const configDir = findConfigDir();
    const dir = configDir
        ? join(configDir, "plugins")
        : join(process.cwd(), ".markit", "plugins");
    mkdirSync(dir, { recursive: true });
    return dir;
}
function getPluginsJsonPath() {
    const configDir = findConfigDir();
    return configDir
        ? join(configDir, PLUGINS_FILE)
        : join(process.cwd(), ".markit", PLUGINS_FILE);
}
function readPluginsJson() {
    const path = getPluginsJsonPath();
    if (!existsSync(path))
        return { plugins: [] };
    return JSON.parse(readFileSync(path, "utf-8"));
}
function writePluginsJson(data) {
    const path = getPluginsJsonPath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}
export async function installPlugin(source) {
    const parsed = parsePluginSource(source);
    const pluginsDir = getPluginsDir();
    let installPath;
    switch (parsed.type) {
        case "npm": {
            const npmDir = join(pluginsDir, "npm");
            mkdirSync(npmDir, { recursive: true });
            const spec = parsed.ref ? `${parsed.name}@${parsed.ref}` : parsed.name;
            execSync(`npm install ${spec}`, { cwd: npmDir, stdio: "pipe" });
            installPath = join(npmDir, "node_modules", parsed.name);
            break;
        }
        case "git": {
            const url = new URL(parsed.url || "");
            const gitDir = join(pluginsDir, "git", url.hostname, url.pathname.replace(/\.git$/, ""));
            if (existsSync(gitDir)) {
                execSync("git pull", { cwd: gitDir, stdio: "pipe" });
            }
            else {
                mkdirSync(join(gitDir, ".."), { recursive: true });
                const refArg = parsed.ref ? `--branch ${parsed.ref}` : "";
                execSync(`git clone ${refArg} ${parsed.url} ${gitDir}`, {
                    stdio: "pipe",
                });
            }
            if (existsSync(join(gitDir, "package.json"))) {
                execSync("npm install", { cwd: gitDir, stdio: "pipe" });
            }
            installPath = parsed.subpath ? join(gitDir, parsed.subpath) : gitDir;
            break;
        }
        case "local": {
            if (!parsed.path || !existsSync(parsed.path)) {
                throw new Error(`Path does not exist: ${parsed.path}`);
            }
            installPath = parsed.path;
            break;
        }
    }
    const data = readPluginsJson();
    const existing = data.plugins.findIndex((p) => p.source === source);
    const entry = {
        source,
        path: installPath,
        name: parsed.name,
    };
    if (existing >= 0) {
        data.plugins[existing] = entry;
    }
    else {
        data.plugins.push(entry);
    }
    writePluginsJson(data);
    return { path: installPath, name: parsed.name };
}
export function removePlugin(name) {
    const data = readPluginsJson();
    const idx = data.plugins.findIndex((p) => p.name === name || p.source.includes(name));
    if (idx < 0)
        return false;
    const plugin = data.plugins[idx];
    const parsed = parsePluginSource(plugin.source);
    if (parsed.type !== "local" && existsSync(plugin.path)) {
        rmSync(plugin.path, { recursive: true, force: true });
    }
    data.plugins.splice(idx, 1);
    writePluginsJson(data);
    return true;
}
export function listInstalled() {
    const data = readPluginsJson();
    return data.plugins.map((p) => {
        const parsed = parsePluginSource(p.source);
        return {
            name: p.name || parsed.name,
            type: parsed.type,
            source: p.source,
            path: p.path,
        };
    });
}
