// @lovable.dev/vite-tanstack-config already includes TanStack/React/Tailwind plugins.
// Extra Vite options are passed via the `vite` key.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    server: { entry: "server" },
  },
  vite: {
    server: {
      // Listen on all interfaces, not just loopback — the route-share QR
      // code needs this page reachable from a phone on the same network.
      host: true,
      proxy: {
        "/api": {
          target: "http://127.0.0.1:8000",
          changeOrigin: true,
          rewrite: (path: string) => path.replace(/^\/api/, ""),
          // Trapelo footprints/geometry can take 30–90s; default proxy
          // idle timeouts abort mid-ingest and leave only entities.json.
          timeout: 600_000,
          proxyTimeout: 600_000,
        },
      },
    },
    optimizeDeps: {
      exclude: ["@thatopen/fragments"],
    },
  },
});
