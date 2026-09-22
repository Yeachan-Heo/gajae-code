import chalk from "chalk";
export const success = (msg) => console.log(chalk.green("✓"), msg);
export const info = (msg) => console.log(chalk.blue("ℹ"), msg);
export const warn = (msg) => console.log(chalk.yellow("⚠"), msg);
export const error = (msg) => console.error(chalk.red("✗"), msg);
export const bold = (s) => chalk.bold(s);
export const dim = (s) => chalk.dim(s);
export const cmd = (s) => chalk.cyan(s);
export const bullet = (msg) => console.log(chalk.green("●"), msg);
export const bulletDim = (msg) => console.log(chalk.dim("●"), msg);
export const hint = (msg) => console.log(chalk.dim(`  ${msg}`));
export const nextStep = (command) => console.log(`  ${cmd(command)}`);
export const header = (title) => {
    console.log();
    console.log(chalk.bold(title));
    console.log();
};
export function jsonOutput(data) {
    console.log(JSON.stringify(data, null, 2));
}
export function output(options, handlers) {
    if (options.json && handlers.json) {
        jsonOutput(handlers.json());
    }
    else if (options.quiet && handlers.quiet) {
        handlers.quiet();
    }
    else {
        handlers.human();
    }
}
