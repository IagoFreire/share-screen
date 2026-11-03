import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPublicIp, syncDnsRecord, type CloudflareDns, type DnsPlan } from "./ddns.js";

/**
 * `node server/dist/ops/ddnsCli.js [--watch]` -- run by start-bot.bat in BOT_EXPOSE=direto
 * mode: once before Caddy starts (a failure stops the start), then with --watch in its
 * own window, following the home IP while the bot runs. Messages are pt-BR without
 * accents, like start-bot.bat's: they show in a cmd window.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: path.resolve(__dirname, "../../../.env") });

/** How often --watch checks whether the home IP changed. */
const WATCH_EVERY_MS = 2 * 60_000;

function hostnameFromEnv(): string {
  if (process.env.PUBLIC_HOSTNAME) return process.env.PUBLIC_HOSTNAME;
  const origin = process.env.PUBLIC_ORIGIN;
  const hostname = origin ? new URL(origin).hostname : "";
  if (!hostname || hostname === "localhost") {
    throw new Error("Defina PUBLIC_ORIGIN (ex.: https://share.iagofreire.dev) no .env.");
  }
  return hostname;
}

function dnsFromEnv(): CloudflareDns {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  if (!token || !zoneId) {
    throw new Error("Defina CLOUDFLARE_API_TOKEN e CLOUDFLARE_ZONE_ID no .env (veja .env.example).");
  }
  return { token, zoneId };
}

function describe(plan: DnsPlan, hostname: string, ip: string): string {
  switch (plan.kind) {
    case "none":
      return `${hostname} ja aponta para ${ip}.`;
    case "update":
      return `${hostname} atualizado para ${ip}.`;
    case "replace":
      return `${hostname} agora aponta para ${ip} (o registro do tunel foi trocado).`;
    case "create":
      return `${hostname} criado apontando para ${ip}.`;
  }
}

const stamp = () => new Date().toLocaleTimeString("pt-BR");

async function main(): Promise<void> {
  const hostname = hostnameFromEnv();
  const dns = dnsFromEnv();

  if (!process.argv.includes("--watch")) {
    const ip = await fetchPublicIp();
    console.log(describe(await syncDnsRecord(dns, hostname, ip), hostname, ip));
    return;
  }

  console.log(`Vigiando o IP de casa para ${hostname} (a cada ${WATCH_EVERY_MS / 60_000} min).`);
  let lastIp: string | null = null;
  const check = async () => {
    try {
      const ip = await fetchPublicIp();
      if (ip === lastIp) return;
      console.log(`[${stamp()}] ${describe(await syncDnsRecord(dns, hostname, ip), hostname, ip)}`);
      lastIp = ip;
    } catch (error) {
      // Kept going: the next check retries, and the record still holds the last good IP.
      console.error(`[${stamp()}] Falha ao atualizar o DNS: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  await check();
  setInterval(() => void check(), WATCH_EVERY_MS);
}

main().catch((error: unknown) => {
  console.error(`Falha ao atualizar o DNS: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
