import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
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
