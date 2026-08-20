import { config } from "../config.js";

const DISCORD_TOKEN_URL = "https://discord.com/api/oauth2/token";

/**
 * Discord requires a Redirect URI to be registered for the app (Developer Portal >
 * OAuth2 > Redirects) even though the Embedded App SDK's authorize() RPC command
 * never navigates the browser there -- the SDK handles the redirect internally.
 * This placeholder is what Discord's own Activities guide recommends registering
 * for local dev; the token exchange must echo the same value back per standard
 * OAuth2 behavior (redirect_uri must match what the authorization step used).
 */
const REDIRECT_URI = "https://127.0.0.1";

export interface DiscordTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

/**
 * Exchanges the `code` obtained from the client's discordSdk.commands.authorize() call
 * for an access token.
 */
export async function exchangeCodeForToken(code: string): Promise<DiscordTokenResponse> {
  const body = new URLSearchParams({
    client_id: config.discordClientId,
    client_secret: config.discordClientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
  });

  const response = await fetch(DISCORD_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    throw new Error(`Discord OAuth2 token exchange failed: ${response.status} ${await response.text()}`);
  }

  return (await response.json()) as DiscordTokenResponse;
}
