import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../styles.css";
import { installGrowthTracking } from "../analytics/growth";
import { AttackLabPage } from "./AttackLabPage";

installGrowthTracking("attack_lab");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AttackLabPage />
  </StrictMode>,
);
