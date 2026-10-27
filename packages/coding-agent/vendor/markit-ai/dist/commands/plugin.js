import { installPlugin, listInstalled, removePlugin, } from "../plugins/installer.js";
import { EXIT_ERROR } from "../utils/exit-codes.js";
import { bold, dim, error, output, success } from "../utils/output.js";
export async function pluginInstall(source, options) {
    try {
        const result = await installPlugin(source);
        output(options, {
            json: () => ({ success: true, ...result }),
            human: () => {
                success(`Installed ${result.name}`);
                console.log(dim(`  ${result.path}`));
            },
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output(options, {
            json: () => ({ success: false, error: msg }),
            human: () => error(msg),
        });
        process.exit(EXIT_ERROR);
    }
}
export async function pluginRemove(name, options) {
    const removed = removePlugin(name);
    output(options, {
        json: () => ({ success: removed, name }),
        human: () => {
            if (removed) {
                success(`Removed ${name}`);
            }
            else {
                error(`Plugin '${name}' not found`);
            }
        },
    });
    if (!removed)
        process.exit(EXIT_ERROR);
}
export async function pluginList(options) {
    const plugins = listInstalled();
    output(options, {
        json: () => ({ plugins }),
        human: () => {
            if (plugins.length === 0) {
                console.log(dim("  No plugins installed"));
                return;
            }
            console.log();
            console.log(bold("Installed plugins"));
            console.log();
            for (const p of plugins) {
                console.log(`  ${p.name.padEnd(20)} ${dim(p.type)} ${dim(p.source)}`);
            }
            console.log();
        },
    });
}
