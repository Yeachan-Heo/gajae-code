export function createPluginAPI(pluginId) {
    let name = pluginId;
    let version = "0.0.0";
    const converters = [];
    const providers = [];
    const formats = [];
    const api = {
        setName(n) {
            name = n;
        },
        setVersion(v) {
            version = v;
        },
        registerConverter(converter, format) {
            converters.push(converter);
            if (format) {
                formats.push(format);
            }
        },
        registerProvider(provider) {
            providers.push(provider);
        },
    };
    function resolve() {
        return { name, version, converters, providers, formats };
    }
    return { api, resolve };
}
export function isPluginFunction(val) {
    return typeof val === "function";
}
export function resolvePluginExport(exported, pluginId) {
    if (isPluginFunction(exported)) {
        const { api, resolve } = createPluginAPI(pluginId);
        exported(api);
        return resolve();
    }
    if (exported && typeof exported === "object" && "converters" in exported) {
        return exported;
    }
    throw new Error(`Invalid plugin export from "${pluginId}": expected a function or { name, converters } object`);
}
