### Fixed

- Reading a YouTube URL now runs `yt-dlp` (metadata and subtitle calls) from the same filtered environment as the bash tool. Previously, on source and npm installs (Bun dotenv autoload), a repository `.env` declaring `LD_PRELOAD` or another hook variable reached `yt-dlp` whenever the agent read a YouTube link.
