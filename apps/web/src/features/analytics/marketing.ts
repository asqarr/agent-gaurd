import { installGrowthTracking } from "./growth";

const page = window.location.pathname === "/attack-lab.html"
  ? "attack_lab"
  : window.location.pathname === "/agent-security-testing.html"
    ? "security_guide"
    : window.location.pathname === "/prompt-injection-testing.html"
      ? "prompt_injection_guide"
      : "home";
installGrowthTracking(page);
