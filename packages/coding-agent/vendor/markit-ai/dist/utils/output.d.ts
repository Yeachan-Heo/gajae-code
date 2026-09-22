export interface OutputOptions {
    json?: boolean;
    quiet?: boolean;
}
export declare const success: (msg: string) => void;
export declare const info: (msg: string) => void;
export declare const warn: (msg: string) => void;
export declare const error: (msg: string) => void;
export declare const bold: (s: string) => string;
export declare const dim: (s: string) => string;
export declare const cmd: (s: string) => string;
export declare const bullet: (msg: string) => void;
export declare const bulletDim: (msg: string) => void;
export declare const hint: (msg: string) => void;
export declare const nextStep: (command: string) => void;
export declare const header: (title: string) => void;
export declare function jsonOutput(data: object): void;
export declare function output(options: OutputOptions, handlers: {
    json?: () => object;
    quiet?: () => void;
    human: () => void;
}): void;
