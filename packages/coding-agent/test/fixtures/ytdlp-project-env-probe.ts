/**
 * Runs the YouTube reader from the current (project) directory the way the app
 * does: `@gajae-code/utils/env` loads first (copying the project `.env` into the
 * process environment), then the reader runs `yt-dlp`. `yt-dlp` is a PATH shim
 * that records the environment it received.
 */
import "@gajae-code/utils/env";
import { handleYouTube } from "../../src/web/scrapers/youtube";

await handleYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ", 20).catch(() => null);
console.log(JSON.stringify({ done: true }));
process.exit(0);
