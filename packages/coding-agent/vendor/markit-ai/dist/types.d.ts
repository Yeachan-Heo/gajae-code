export interface StreamInfo {
    mimetype?: string;
    extension?: string;
    charset?: string;
    filename?: string;
    localPath?: string;
    url?: string;
    /** Directory to write extracted images/diagrams. */
    imageDir?: string;
}
export interface ConversionResult {
    markdown: string;
    title?: string;
}
export interface MarkitOptions {
    /** Describe an image, return markdown. Receives raw bytes and mimetype. */
    describe?: (image: Buffer, mimetype: string) => Promise<string>;
    /** Transcribe audio, return text. Receives raw bytes and mimetype. */
    transcribe?: (audio: Buffer, mimetype: string) => Promise<string>;
    /** Extra instructions appended to the image description prompt. */
    prompt?: string;
}
export interface Converter {
    /** Human-readable name for error messages */
    name: string;
    /** Quick check: can this converter handle the given stream? */
    accepts(streamInfo: StreamInfo): boolean;
    /**
     * Optional URL-first hook. When present, called before the default fetch
     * so the converter can handle URL fetching itself (e.g. rewrite to a raw
     * content URL or call an API).
     */
    convertUrl?(url: string, options?: MarkitOptions): Promise<ConversionResult>;
    /** Convert the source to markdown */
    convert(input: Buffer, streamInfo: StreamInfo, options?: MarkitOptions): Promise<ConversionResult>;
}
