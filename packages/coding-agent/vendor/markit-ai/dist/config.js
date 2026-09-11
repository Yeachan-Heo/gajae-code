import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const DATA_DIR = ".markit";
const CONFIG_FILE = "config.json";
/**
 * Walk up from cwd to find .markit/ directory.
 */
export function findConfigDir() {
    let dir = process.cwd();
    while (true) {
        if (existsSync(join(dir, DATA_DIR))) {
            return join(dir, DATA_DIR);
        }
        const parent = join(dir, "..");
        if (parent === dir)
            return null;
        dir = parent;
    }
}
/**
 * Load config from .markit/config.json.
 */
export function loadConfig() {
    const configDir = findConfigDir();
    if (!configDir)
        return {};
    const configFile = join(configDir, CONFIG_FILE);
    if (!existsSync(configFile))
        return {};
    const raw = JSON.parse(readFileSync(configFile, "utf-8"));
    return { ...raw, llm: { ...raw.llm } };
}
/**
 * Save config to .markit/config.json. Creates .markit/ if needed.
 */
export function saveConfig(config) {
    const configDir = findConfigDir();
    const dir = configDir || join(process.cwd(), DATA_DIR);
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
}
