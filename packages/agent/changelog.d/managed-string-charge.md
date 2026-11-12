### Performance

- Streaming a multi-line or non-English reply spends less CPU measuring the partial message. A string with a newline or a non-ASCII character was charged one code point at a time on every delta, with a limit check per code point; a well-formed one is now charged its UTF-8 length plus its JSON escapes in two limit checks. The measured size is unchanged.
