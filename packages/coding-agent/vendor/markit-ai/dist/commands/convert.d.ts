import type { OutputOptions } from "../utils/output.js";
export declare function convert(source: string, options: OutputOptions & {
    output?: string;
    prompt?: string;
    imageDir?: string;
}): Promise<void>;
