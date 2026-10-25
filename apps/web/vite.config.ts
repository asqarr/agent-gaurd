import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  // Render serves the Vite build from the domain root. Keep every generated
  // asset URL absolute so /app.html and /attack-lab.html resolve /assets/*
  // instead of looking relative to the current HTML path.
  base: "/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(root, "index.html"),
        app: resolve(root, "app.html"),
        attackLab: resolve(root, "attack-lab.html"),
        agentSecurityTesting: resolve(root, "agent-security-testing.html"),
        promptInjectionTesting: resolve(root, "prompt-injection-testing.html"),
        privacy: resolve(root, "privacy.html"),
        terms: resolve(root, "terms.html"),
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
