import { DiscordSDK } from "@discord/embedded-app-sdk";

export interface DiscordAuth {
  accessToken: string;
  userId: string;
  channelId: string | null;
  guildId: string | null;
}

let discordSdk: DiscordSDK | null = null;

/**
 * Returns the SDK instance constructed inside bootstrapDiscordSdk(). Only valid to call
 * after that has resolved (main.ts only mounts the app once it has), which is the only
 * place this is used.
 */
export function getDiscordSdk(): DiscordSDK {
  if (!discordSdk) throw new Error("Discord SDK accessed before bootstrapDiscordSdk() resolved.");
  return discordSdk;
}

/**
 * Runs the Activity's mandatory ready() + OAuth2 handshake. The client id is fetched
 * from the server (GET /api/config) rather than baked into the build via a VITE_ env
 * var: the server already has DISCORD_CLIENT_ID, so embedding a second copy at build
 * time is a duplication that goes stale silently -- rotate the credential, forget to
 * rebuild the client, and the Activity opens fine but fails at login.
 *
 * The `code` returned by authorize() is exchanged server-side via POST /api/token so
 * the client secret never reaches the browser bundle. Exact command/field names
 * (authorize/authenticate, discordSdk.channelId/guildId, auth.user.id) follow the
 * @discord/embedded-app-sdk quickstart as of writing -- re-verify against the installed
 * SDK version's docs before shipping, since Discord has iterated this API across
 * versions (see plan risk table).
 */
export async function bootstrapDiscordSdk(): Promise<DiscordAuth> {
  const configResponse = await fetch("/api/config");
  if (!configResponse.ok) {
    throw new Error(`Failed to load app config: ${configResponse.status}`);
  }
  const { clientId } = (await configResponse.json()) as { clientId: string };
  if (!clientId) {
    throw new Error("Server returned an empty Discord client id -- is DISCORD_CLIENT_ID set?");
  }

  discordSdk = new DiscordSDK(clientId);
  await discordSdk.ready();

  const { code } = await discordSdk.commands.authorize({
    client_id: clientId,
    response_type: "code",
    state: "",
    prompt: "none",
    scope: ["identify", "guilds", "applications.commands"],
  });

  const tokenResponse = await fetch("/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });

  if (!tokenResponse.ok) {
    throw new Error(`Token exchange failed: ${tokenResponse.status}`);
  }

  const { access_token: accessToken } = (await tokenResponse.json()) as { access_token: string };

  const auth = await discordSdk.commands.authenticate({ access_token: accessToken });
  if (!auth) {
    throw new Error("Discord authenticate() returned no session.");
  }

  return {
    accessToken,
    userId: auth.user.id,
    channelId: discordSdk.channelId ?? null,
    guildId: discordSdk.guildId ?? null,
  };
}
