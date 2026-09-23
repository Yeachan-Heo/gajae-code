import type { OutputOptions } from "../utils/output.js";
export declare function pluginInstall(source: string, options: OutputOptions): Promise<void>;
export declare function pluginRemove(name: string, options: OutputOptions): Promise<void>;
export declare function pluginList(options: OutputOptions): Promise<void>;
