### Fixed

- An image Anthropic rejects with `Could not process image` no longer makes every later request in the session fail. The provider replaces the rejected image with a text placeholder and keeps omitting it on later turns and fallback models. The first repair omits the images of the newest message that has any; if the request still fails, the second omits every image (#6810).
