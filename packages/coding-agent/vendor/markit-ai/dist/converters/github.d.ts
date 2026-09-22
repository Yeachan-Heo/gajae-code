import type { ConversionResult, Converter, MarkitOptions, StreamInfo } from "../types.js";
/**
 * Matches GitHub URLs and fetches clean markdown content directly
 * from raw endpoints or the GitHub API — no HTML scraping needed.
 *
 * Supported patterns:
 *   - Repos:   github.com/owner/repo          → raw README.md
 *   - Files:   github.com/owner/repo/blob/…   → raw file content
 *   - Gists:   gist.github.com/owner/id       → raw gist content
 *   - Issues:  github.com/owner/repo/issues/N  → API (title + body)
 *   - PRs:     github.com/owner/repo/pull/N    → API (title + body)
 */
export declare class GitHubConverter implements Converter {
    name: string;
    accepts(streamInfo: StreamInfo): boolean;
    convertUrl(url: string, _options?: MarkitOptions): Promise<ConversionResult>;
    convert(_input: Buffer, streamInfo: StreamInfo): Promise<ConversionResult>;
}
