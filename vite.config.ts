import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api/rpc": {
        target: "https://solana-rpc.publicnode.com",
        changeOrigin: true,
        rewrite: () => "/",
      },
      "/api/xstocks": {
        target: "https://api.xstocks.fi/api/v2/public",
        changeOrigin: true,
        rewrite: (path) => {
          const url = new URL(path, "http://localhost");
          const symbol = url.searchParams.get("symbol");
          return symbol
            ? `/assets/${encodeURIComponent(symbol)}`
            : `/assets?page=${url.searchParams.get("page") ?? "0"}`;
        },
      },
    },
  },
});
