import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { registerServiceWorker } from "./pwa";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

window.addEventListener(
  "load",
  () => {
    void registerServiceWorker().catch((error: unknown) => {
      console.error("Service worker registration failed", error);
    });
  },
  { once: true },
);
