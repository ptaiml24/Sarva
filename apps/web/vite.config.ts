import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    /**
     * Listen on all local interfaces (0.0.0.0). If we bind only 127.0.0.1, some browsers resolve
     * `localhost` to ::1 first → connection refused → "Failed to fetch" on screen. Playwright still
     * uses http://127.0.0.1:5173 (playwright.config.ts).
     */
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
        /**
         * Local LLM (Ollama) often needs 60s+. http-proxy defaults can close idle sockets
         * before the API responds → browser shows `Failed to fetch` though the API logged the request.
         * `0` disables these timeouts (dev-only).
         */
        timeout: 0,
        proxyTimeout: 0,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setTimeout(0);
            proxyReq.on("socket", (socket) => {
              socket.setTimeout(0);
            });
          });
          proxy.on("proxyRes", (proxyRes) => {
            proxyRes.setTimeout(0);
          });
        },
      },
    },
  },
});
