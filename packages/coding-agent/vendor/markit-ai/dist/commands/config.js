import { findConfigDir, loadConfig, saveConfig } from "../config.js";
import { getProvider, listProviders } from "../providers/index.js";
import { EXIT_ERROR, EXIT_USER_ERROR } from "../utils/exit-codes.js";
import { bold, dim, error, output, success } from "../utils/output.js";
export async function configShow(_args, options) {
    const config = loadConfig();
    const configDir = findConfigDir();
    const providerName = config.llm?.provider || "openai";
    const provider = getProvider(providerName);
    output(options, {
        json: () => ({
            configDir,
            config,
            providers: listProviders(),
        }),
        human: () => {
            console.log();
            console.log(bold("Configuration"));
            console.log();
            if (configDir) {
                console.log(`  ${dim("config:")} ${configDir}/config.json`);
            }
            else {
                console.log(`  ${dim("config:")} none (run 'markit init')`);
            }
            console.log();
            console.log(bold("LLM Settings"));
            console.log();
            console.log(`  ${dim("provider:")} ${providerName}`);
            if (provider) {
                // Resolve API key
                const apiKey = provider.envKeys.reduce((found, key) => found || process.env[key], undefined) || config.llm?.apiKey;
                const keySource = provider.envKeys.find((k) => process.env[k]) ||
                    (config.llm?.apiKey ? "config" : undefined);
                console.log(`  ${dim("api key:")} ${apiKey ? `***${apiKey.slice(-4)} (${keySource})` : dim("not set")}`);
                console.log(`  ${dim("api base:")} ${config.llm?.apiBase || provider.defaultBase}`);
                console.log(`  ${dim("model:")} ${config.llm?.model || provider.defaultModel}`);
                if (provider.defaultTranscriptionModel) {
                    console.log(`  ${dim("transcription:")} ${config.llm?.transcriptionModel || provider.defaultTranscriptionModel}`);
                }
                console.log(`  ${dim("env vars:")} ${provider.envKeys.join(", ")}`);
            }
            else {
                console.log(`  ${dim("(unknown provider)")}`);
            }
            console.log();
            console.log(dim(`  Available providers: ${listProviders().join(", ")}`));
            console.log();
        },
    });
}
export async function configGet(key, options) {
    const config = loadConfig();
    const value = getNestedValue(config, key);
    if (value === undefined) {
        output(options, {
            json: () => ({ key, value: null }),
            human: () => error(`Key '${key}' not found`),
        });
        process.exit(EXIT_USER_ERROR);
    }
    output(options, {
        json: () => ({ key, value }),
        quiet: () => console.log(String(value)),
        human: () => console.log(String(value)),
    });
}
export async function configSet(key, value, options) {
    if (!findConfigDir()) {
        output(options, {
            json: () => ({
                success: false,
                error: "No .markit/ directory. Run 'markit init'",
            }),
            human: () => error("No .markit/ directory. Run 'markit init' first."),
        });
        process.exit(EXIT_ERROR);
    }
    // Secrets: read from stdin instead of args (avoids shell history)
    const isSecret = key.toLowerCase().includes("key") ||
        key.toLowerCase().includes("secret") ||
        key.toLowerCase().includes("token");
    let resolved;
    if (isSecret && !value) {
        // Prompt from stdin
        if (process.stdin.isTTY) {
            process.stderr.write(`Enter value for ${key}: `);
        }
        const chunks = [];
        for await (const chunk of process.stdin) {
            chunks.push(chunk);
        }
        resolved = Buffer.concat(chunks).toString("utf-8").trim();
        if (!resolved) {
            error("No value provided");
            process.exit(EXIT_USER_ERROR);
        }
    }
    else if (isSecret && value) {
        // Warn if secret passed as arg
        console.error(dim("  hint: secrets in args leak to shell history. Use: markit config set llm.apiKey < keyfile"));
        resolved = value;
    }
    else if (value === undefined) {
        error("Missing value. Usage: markit config set <key> <value>");
        process.exit(EXIT_USER_ERROR);
    }
    else {
        resolved = value;
    }
    const config = loadConfig();
    let parsed = resolved;
    if (resolved === "true")
        parsed = true;
    else if (resolved === "false")
        parsed = false;
    else if (/^\d+$/.test(resolved))
        parsed = parseInt(resolved, 10);
    setNestedValue(config, key, parsed);
    saveConfig(config);
    output(options, {
        json: () => ({ success: true, key, value: parsed }),
        human: () => success(`${key} = ${JSON.stringify(parsed)}`),
    });
}
function getNestedValue(obj, path) {
    return path.split(".").reduce((o, k) => o?.[k], obj);
}
function setNestedValue(obj, path, value) {
    const keys = path.split(".");
    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        if (!current[keys[i]] || typeof current[keys[i]] !== "object") {
            current[keys[i]] = {};
        }
        current = current[keys[i]];
    }
    current[keys[keys.length - 1]] = value;
}
