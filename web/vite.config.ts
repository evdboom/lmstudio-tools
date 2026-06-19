import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// API server runs separately (npm run api at repo root, port 8787).
// In dev, proxy /api to it so the SPA and API share an origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
  build: { outDir: "dist" },
});
