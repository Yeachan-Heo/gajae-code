import type { Provider } from "../providers/types.js";
import type { Converter } from "../types.js";
export interface FormatDef {
    name: string;
    extensions: string[];
}
export interface MarkitPluginAPI {
    setName(name: string): void;
    setVersion(version: string): void;
    registerConverter(converter: Converter, format?: FormatDef): void;
    registerProvider(provider: Provider): void;
}
export type PluginFunction = (api: MarkitPluginAPI) => void;
export interface PluginDef {
    name: string;
    version: string;
    converters: Converter[];
    providers: Provider[];
    formats: FormatDef[];
}
export interface InstalledPlugin {
    source: string;
    path: string;
    name?: string;
}
