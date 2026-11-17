### Fixed

- `/notify on` after a session shutdown on the same extension instance starts a same-ID replacement runtime again. Shutdown now cancels only notification startups reserved before it, instead of refusing every later start.
