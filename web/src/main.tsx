import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import "./index.css";
import { applyStoredInboxWidth } from "./inboxWidth";
import { applyStoredSidebarWidth } from "./sidebarWidth";

applyStoredSidebarWidth();
applyStoredInboxWidth();

registerSW({ immediate: true });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
