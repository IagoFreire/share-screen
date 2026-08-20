import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const clientRoot = fileURLToPath(new URL(".", import.meta.url));

// Dev server proxies /api and /ws to the local Express+ws relay (see server/src/index.ts)
// so `npm run dev:client` and `npm run dev:server` can run side by side during Phase 1.
// envDir points Vite at the repo-root .env so client (VITE_*) and server share one file.
export default defineConfig({
  envDir: repoRoot,
  plugins: [
    {
      // Discord's Activity proxy caches aggressively, and Vite's dev URLs are stable
      // (/src/ui/styles.css, /@fs/..., etc). That combination repeatedly pinned stale
      // assets in the browser -- old CSS, missing exports after a shared/ change, and
      // even a stylesheet cached as text/css being re-served for a JS module import.
      // Dev only: production assets are content-hashed and should stay cacheable.
      //
      // A plain `res.setHeader(...)` here -- whether registered before or after Vite's
      // own internal middlewares -- consistently lost: Vite's static/module-serving
      // code sets its own `Cache-Control: no-cache` + ETag later in the same request
      // and apparently writes the response before a "post hook" middleware even runs,
      // so neither ordering worked. Patching `res.setHeader` itself intercepts at the
      // source instead: whenever ANY later code (ours or Vite's) tries to set these
      // headers on this response, it's forced to our values regardless of order.
      name: "screenshare-bot:no-store-dev-assets",
      configureServer(server) {
        server.middlewares.use((_req, res, next) => {
          const originalSetHeader = res.setHeader.bind(res);
          res.setHeader = ((name: string, value: unknown) => {
            const lower = name.toLowerCase();
            if (lower === "cache-control") {
              return originalSetHeader(name, "no-store, no-cache, must-revalidate, max-age=0");
            }
            if (lower === "etag" || lower === "last-modified") {
              return res;
            }
            return originalSetHeader(name, value as never);
          }) as typeof res.setHeader;
          next();
        });
      },
    },
  ],
  resolve: {
    alias: {
      // Resolve the workspace package to its TypeScript source instead of its built
      // dist/. Going through dist/ makes Vite serve it from a stable /@fs/... URL with
      // no cache-busting, which Discord's Activity proxy then pins -- newly added
      // exports show up in the browser as "does not provide an export named ...", the
      // same staleness that hit styles.css. As project source it is compiled inline and
      // versioned like any other module, and the client no longer needs shared to be
      // rebuilt before it can see a change.
      "@screenshare-bot/shared": path.resolve(repoRoot, "shared/src/index.ts"),
    },
  },
  server: {
    port: 5173,
    // Discord loads the Activity through its own proxy domain, and Phase 1 dev
    // testing goes through an ngrok/cloudflared tunnel first -- neither is
    // "localhost", so Vite's Host-header allowlist needs these explicitly.
    // Wildcards cover ngrok's randomly-generated subdomain on every restart.
    allowedHosts: [".iagofreire.dev", ".trycloudflare.com", ".ngrok-free.app", ".ngrok.io", ".discordsays.com"],
    proxy: {
      "/api": "http://localhost:3001",
      "/ws": {
        target: "ws://localhost:3001",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        // index.html: the Activity itself, runs inside Discord's iframe (viewer/orchestrator).
        // present.html: a plain page opened in a normal browser tab via
        // discordSdk.commands.openExternalLink() -- getDisplayMedia() is blocked by
        // Discord's iframe Permissions-Policy, so screen capture can only happen here.
        // watch.html: also opened externally, for watching outside the iframe (so the
        // real Fullscreen API works, unlike the Activity's CSS-only pseudo-fullscreen).
        main: path.resolve(clientRoot, "index.html"),
        present: path.resolve(clientRoot, "present.html"),
        watch: path.resolve(clientRoot, "watch.html"),
      },
    },
  },
});
