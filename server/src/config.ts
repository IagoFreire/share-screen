import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_CONCURRENT_ROOMS_DEFAULT,
  MAX_VIEWERS_PER_ROOM_DEFAULT,
  TARGET_VIDEO_BITRATE_KBPS_DEFAULT,
} from "@screenshare-bot/shared";

// `npm run dev --workspace=server` runs with cwd=server/, not the repo root, so the
// default dotenv/config (which resolves ".env" against process.cwd()) silently finds
// nothing there. Resolve the repo-root .env explicitly instead.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(__dirname, "../../.env") });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** Comma-separated env value -> trimmed entries, ignoring blanks and stray whitespace. */
function listEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: intEnv("PORT", 3001),
  publicOrigin: process.env.PUBLIC_ORIGIN ?? `http://localhost:${intEnv("PORT", 3001)}`,
  nodeEnv: process.env.NODE_ENV ?? "development",

  discordClientId: process.env.DISCORD_CLIENT_ID ?? "",
  discordClientSecret: process.env.DISCORD_CLIENT_SECRET ?? "",
  /** Optional: only required if verifyMember.ts membership checks are enabled. */
  discordBotToken: process.env.DISCORD_BOT_TOKEN ?? "",

  targetVideoBitrateKbps: intEnv("TARGET_VIDEO_BITRATE_KBPS", TARGET_VIDEO_BITRATE_KBPS_DEFAULT),
  maxConcurrentRooms: intEnv("MAX_CONCURRENT_ROOMS", MAX_CONCURRENT_ROOMS_DEFAULT),
  maxViewersPerRoom: intEnv("MAX_VIEWERS_PER_ROOM", MAX_VIEWERS_PER_ROOM_DEFAULT),

  /**
   * Discord user ids allowed to end anyone's broadcast, not just their own.
   *
   * Kept in the environment rather than the source so moderators can change without a
   * rebuild and redeploy, and so the list never lands in the repository.
   */
  adminUserIds: listEnv("ADMIN_USER_IDS"),
};

export function assertDiscordOAuthConfigured(): void {
  requireEnv("DISCORD_CLIENT_ID");
  requireEnv("DISCORD_CLIENT_SECRET");
}
