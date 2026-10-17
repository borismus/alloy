import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "./theme";
import { isTauri } from "./services/api";
import "@fontsource-variable/geist-mono/wght.css";
import "@fontsource-variable/geist-mono/wght-italic.css";
import "./styles/tokens.css";

// The macOS window has no title bar of its own (titleBarStyle "Overlay"): the
// app draws to the top edge and leaves room for the traffic lights.
if (isTauri() && navigator.userAgent.includes("Mac")) {
  document.documentElement.classList.add("macos-overlay-titlebar");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);
