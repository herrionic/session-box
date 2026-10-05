import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In the containerised dev topology the API lives in the sibling "server"
// container, not on 127.0.0.1 (compose.dev.yml overrides this variable).
const apiTarget = process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        ws: true,
      },
    },
    // The repository may live on a Windows drive mounted inside WSL, where
    // inotify is unavailable; polling keeps HMR working.
    watch: { usePolling: true, interval: 1000 },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
