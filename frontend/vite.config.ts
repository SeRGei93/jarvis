import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Mini App is served from the "/miniapp" subpath in prod, so asset URLs are
// absolute under that base (robust regardless of a trailing slash on the page
// URL). In dev, /admin/api and /health are proxied to the backend on :8080 so
// the browser's same-origin admin calls (Authorization: tma <initData>) reach
// Hono — open the dev app at http://localhost:5173/miniapp/.
export default defineConfig({
  plugins: [react()],
  base: "/miniapp/",
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
