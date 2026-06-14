import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Mini App is served from a static subpath in prod → relative asset URLs.
// In dev, /admin/api and /health are proxied to the backend on :8080 so the
// browser's same-origin admin calls (Authorization: tma <initData>) reach Hono.
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    port: 5173,
    proxy: {
      "/admin/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
      "/health": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
});
