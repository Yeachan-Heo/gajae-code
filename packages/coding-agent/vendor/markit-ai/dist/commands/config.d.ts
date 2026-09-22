import type { OutputOptions } from "../utils/output.js";
export declare function configShow(_args: string[], options: OutputOptions): Promise<void>;
export declare function configGet(key: string, options: OutputOptions): Promise<void>;
export declare function configSet(key: string, value: string | undefined, options: OutputOptions): Promise<void>;
