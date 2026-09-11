import type { ConversionResult, Converter, StreamInfo } from "../types.js";
export declare class IpynbConverter implements Converter {
    name: string;
    accepts(streamInfo: StreamInfo): boolean;
    convert(input: Buffer, _streamInfo: StreamInfo): Promise<ConversionResult>;
}
