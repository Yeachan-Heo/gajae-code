import type { ConversionResult, Converter, StreamInfo } from "../types.js";
export declare class HtmlConverter implements Converter {
    name: string;
    accepts(streamInfo: StreamInfo): boolean;
    convert(input: Buffer, streamInfo: StreamInfo): Promise<ConversionResult>;
}
