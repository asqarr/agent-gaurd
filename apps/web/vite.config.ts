import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(root, "index.html"),
        app: resolve(root, "app.html"),
        attackLab: resolve(root, "attack-lab.html"),
        agentSecurityTesting: resolve(root, "agent-security-testing.html"),
        promptInjectionTesting: resolve(root, "prompt-injection-testing.html"),
      },
    },
  },
  server: {
    port: 5173,
    host: "127.0.0.1",
    proxy: {
      "/api": "http://127.0.0.1:4100",
    },
  },
});
