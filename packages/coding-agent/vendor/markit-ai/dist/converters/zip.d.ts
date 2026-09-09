import type { ConversionResult, Converter, StreamInfo } from "../types.js";
export declare class ZipConverter implements Converter {
    name: string;
    private parentConverters;
    constructor(parentConverters: Converter[]);
    accepts(streamInfo: StreamInfo): boolean;
    convert(input: Buffer, streamInfo: StreamInfo): Promise<ConversionResult>;
}
