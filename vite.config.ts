import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Serves the edge functions in `api/` during local development so the page runs
 * against the same code Vercel will execute, rather than against a mock that can
 * drift from it.
 */
function apiRoutes(): Plugin {
  return {
    name: "breaker-api-routes",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith("/api/tape")) return next();
        try {
          const mod = await server.ssrLoadModule("/api/tape.ts");
          const handler = mod.default as (request: Request) => Promise<Response>;
          const response = await handler(new Request(`http://localhost${url}`));
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(await response.text());
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(error) }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), apiRoutes()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      // The browser never talks to an RPC endpoint directly; in production this
      // path is the allowlisted edge proxy in api/rpc.ts.
      "/api/rpc": {
        target: "https://api.devnet.solana.com",
        changeOrigin: true,
        rewrite: () => "/",
      },
    },
  },
});
