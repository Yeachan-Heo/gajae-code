### Fixed

- The Gajae Pet sprite is uploaded as a single-escape lossless PNG instead of chunked kitty raw RGBA (`f=32`), and every kitty escape is bounded to the protocol's 4096-byte limit in both the pet and inline-image paths. A pet animation frame used to emit several ~4 KB raw-RGBA chunk continuations per tick; when the terminal dropped one mid-payload the remaining base64 was painted into the transcript as text and the frame desynchronized. A sprite frame now costs a few hundred payload characters inside one complete escape.
