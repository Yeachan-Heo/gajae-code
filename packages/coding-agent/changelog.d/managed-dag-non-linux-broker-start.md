### Fixed

- The SDK broker starts again on macOS and Windows. Managed task DAG enrollment recovery took its Linux-only private durable lock even when no enrollment index existed, so every non-Linux broker failed startup with "Broker cannot establish complete managed enrollment membership." An absent index now reads as empty off Linux; a present index still fails closed.
