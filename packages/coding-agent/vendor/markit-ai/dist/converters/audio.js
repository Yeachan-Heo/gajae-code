const EXTENSIONS = [
    ".mp3",
    ".wav",
    ".m4a",
    ".mp4",
    ".ogg",
    ".flac",
    ".aac",
    ".wma",
];
const MIMETYPES = ["audio/", "video/mp4"];
export class AudioConverter {
    name = "audio";
    accepts(streamInfo) {
        if (streamInfo.extension && EXTENSIONS.includes(streamInfo.extension))
            return true;
        if (streamInfo.mimetype &&
            MIMETYPES.some((m) => streamInfo.mimetype?.startsWith(m)))
            return true;
        return false;
    }
    async convert(input, streamInfo, options) {
        const sections = [];
        // Extract audio metadata
        try {
            const mm = await import("music-metadata");
            const metadata = await mm.parseBuffer(new Uint8Array(input), {
                mimeType: streamInfo.mimetype,
                size: input.length,
            });
            const { common, format } = metadata;
            sections.push("## Metadata\n");
            const fields = {
                Title: common.title,
                Artist: common.artist,
                Album: common.album,
                Genre: common.genre?.join(", "),
                Track: common.track?.no
                    ? `${common.track.no}${common.track.of ? ` of ${common.track.of}` : ""}`
                    : undefined,
                Year: common.year ? String(common.year) : undefined,
                Duration: format.duration
                    ? this.formatDuration(format.duration)
                    : undefined,
                Format: format.codec || format.container,
                SampleRate: format.sampleRate ? `${format.sampleRate} Hz` : undefined,
                Channels: format.numberOfChannels
                    ? String(format.numberOfChannels)
                    : undefined,
                Bitrate: format.bitrate
                    ? `${Math.round(format.bitrate / 1000)} kbps`
                    : undefined,
            };
            for (const [key, value] of Object.entries(fields)) {
                if (value)
                    sections.push(`${key}: ${value}`);
            }
            if (common.lyrics?.length) {
                sections.push(`\n## Lyrics\n\n${common.lyrics.join("\n")}`);
            }
        }
        catch {
            // Metadata parsing failed
        }
        // AI transcription
        if (options?.transcribe) {
            try {
                const mimetype = streamInfo.mimetype || guessMimetype(streamInfo.extension);
                const transcript = await options.transcribe(input, mimetype);
                if (transcript) {
                    sections.push(`\n## Transcript\n\n${transcript}`);
                }
            }
            catch {
                // Transcription failed
            }
        }
        if (sections.length === 0) {
            return { markdown: `*[audio: ${streamInfo.filename || "unknown"}]*` };
        }
        return { markdown: sections.join("\n").trim() };
    }
    formatDuration(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.round(seconds % 60);
        if (h > 0)
            return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
        return `${m}:${String(s).padStart(2, "0")}`;
    }
}
function guessMimetype(ext) {
    const map = {
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".m4a": "audio/mp4",
        ".mp4": "video/mp4",
        ".ogg": "audio/ogg",
        ".flac": "audio/flac",
        ".aac": "audio/aac",
        ".wma": "audio/x-ms-wma",
    };
    return map[ext || ""] || "audio/mpeg";
}
