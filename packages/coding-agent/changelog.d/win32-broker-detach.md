### Fixed

- Windows SDK broker now spawns through an intermediate launcher (`cmd /c start`) to prevent it from being a descendant of the client process. This ensures the broker and other clients' sessions survive when one client is force-terminated (issue #6007).
