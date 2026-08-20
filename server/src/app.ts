import express, { type Express } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, assertDiscordOAuthConfigured } from "./config.js";
import { exchangeCodeForToken } from "./auth/discordOAuth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Built client bundle (client/dist), served as static files so the relay is a single process/port.
const clientDistPath = path.resolve(__dirname, "../../client/dist");

export function createApp(): Express {
  const app = express();
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Public, non-secret config the client needs before it can bootstrap the Discord SDK.
  // Serving it at runtime (instead of baking VITE_DISCORD_CLIENT_ID into the build)
  // means rotating the app's client ID is a server restart, not a client rebuild --
  // the two were previously duplicated in .env, and forgetting to rebuild after
  // rotating one left the Activity opening fine and failing silently at login.
  app.get("/api/config", (_req, res) => {
    res.json({ clientId: config.discordClientId });
  });

  // Called by the Activity client after discordSdk.commands.authorize() returns a `code`.
  app.post("/api/token", async (req, res) => {
    try {
      assertDiscordOAuthConfigured();
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Server OAuth2 configuration is incomplete." });
      return;
    }

    const { code } = (req.body ?? {}) as { code?: unknown };
    if (typeof code !== "string" || !code) {
      res.status(400).json({ error: "Missing `code`." });
      return;
    }

    try {
      const token = await exchangeCodeForToken(code);
      res.json({ access_token: token.access_token });
    } catch (error) {
      console.error("OAuth2 token exchange failed:", error);
      res.status(502).json({ error: "Discord OAuth2 exchange failed." });
    }
  });

  app.use(express.static(clientDistPath));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDistPath, "index.html"));
  });

  return app;
}
