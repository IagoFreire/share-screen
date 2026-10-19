import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repoRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Same as client/vite.config.ts: tests read shared/ from source, so a shared/
      // change never needs a rebuild before the suite can see it.
      "@screenshare-bot/shared": path.resolve(repoRoot, "shared/src/index.ts"),
    },
  },
  test: {
    include: ["{shared,server,client,desktop}/src/**/*.test.ts"],
  },
});
