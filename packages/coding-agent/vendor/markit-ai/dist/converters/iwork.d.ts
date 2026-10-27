import type { ConversionResult, Converter, StreamInfo } from "../types.js";
/**
 * Converts Apple iWork files (Pages, Keynote, Numbers) to markdown.
 *
 * All three formats are ZIP archives containing an XML file:
 *   - Pages:   index.xml   (sf:p paragraphs with named styles)
 *   - Keynote: index.apxl  (key:slide elements with sf:p text)
 *   - Numbers: index.xml   (sf:t text cells + sf:n number cells)
 */
export declare class IWorkConverter implements Converter {
    name: string;
    accepts(streamInfo: StreamInfo): boolean;
    convert(input: Buffer, streamInfo: StreamInfo): Promise<ConversionResult>;
    private convertPages;
    private convertKeynote;
    private convertNumbers;
    private extractGrid;
    private convertNumbersFallback;
    private readIndex;
}
