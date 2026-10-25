import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles.css";
import { installGrowthTracking } from "../features/analytics/growth";
import App from "./App";

installGrowthTracking("app");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
