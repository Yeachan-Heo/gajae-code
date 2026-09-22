import type { ConversionResult, Converter, StreamInfo } from "../types.js";
export declare class RssConverter implements Converter {
    name: string;
    accepts(streamInfo: StreamInfo): boolean;
    convert(input: Buffer, _streamInfo: StreamInfo): Promise<ConversionResult>;
    private parseRss;
    private parseAtom;
    private htmlToMd;
    private extract;
    private extractAll;
}
