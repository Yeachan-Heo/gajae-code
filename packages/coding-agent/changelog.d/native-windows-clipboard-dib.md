### Fixed

- Windows clipboard image reads now decode Qt `CF_DIB` and `CF_DIBV5` `BI_BITFIELDS` payloads that arboard rejects, returning the image as PNG through the existing lazy native clipboard path. On Linux, retaining arboard's X11 selection owner for the process lifetime keeps copied clipboard text available after the copy call returns.
