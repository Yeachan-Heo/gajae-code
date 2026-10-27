import type { ConversionResult, Converter, StreamInfo } from "../types.js";
export declare class EpubConverter implements Converter {
    name: string;
    accepts(streamInfo: StreamInfo): boolean;
    convert(input: Buffer, _streamInfo: StreamInfo): Promise<ConversionResult>;
    private getText;
    private getTextArray;
}
