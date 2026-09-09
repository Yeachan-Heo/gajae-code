import type { ConversionResult, Converter, MarkitOptions, StreamInfo } from "../types.js";
export declare class AudioConverter implements Converter {
    name: string;
    accepts(streamInfo: StreamInfo): boolean;
    convert(input: Buffer, streamInfo: StreamInfo, options?: MarkitOptions): Promise<ConversionResult>;
    private formatDuration;
}
