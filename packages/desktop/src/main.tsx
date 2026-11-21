import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import Showcase from "./Showcase";
import { applyTheme, readThemePreference } from "./themes";
import "./styles.css";

// Applied before the first paint so the fallback palette never flashes.
applyTheme(readThemePreference());

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
root.addEventListener("contextmenu", event => event.preventDefault());
createRoot(root).render(
	<StrictMode>{new URLSearchParams(window.location.search).has("showcase") ? <Showcase /> : <App />}</StrictMode>,
);
