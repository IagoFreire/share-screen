/**
 * Keeps the public hostname pointing at this machine's home IP, for running the bot
 * from home without the Cloudflare Tunnel (start-bot.bat with BOT_EXPOSE=direto):
 * Caddy terminates TLS here, on the port in PUBLIC_ORIGIN that the router forwards to
 * it (see Caddyfile.home). Residential IPs
 * change, so this runs at start and then keeps watching (see ddnsCli.ts).
 *
 * The record must be DNS-only (grey cloud): Cloudflare's proxy in front would bring
 * back the extra hop this mode exists to remove.
 */

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
}

export type DnsPlan =
  | { kind: "none" }
  | { kind: "update"; recordId: string }
  | { kind: "create" }
  /** Records in the way of an address record -- the tunnel's CNAME -- go first. */
  | { kind: "replace"; removeIds: string[] };

/** Short, so an IP change reaches resolvers within a minute or two. */
const RECORD_TTL_SECONDS = 60;
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function planDnsChange(records: DnsRecord[], hostname: string, ip: string): DnsPlan {
  const own = records.filter((record) => record.name === hostname);
  const address = own.find((record) => record.type === "A");
  if (address) {
    return address.content === ip && address.proxied === false ? { kind: "none" } : { kind: "update", recordId: address.id };
  }
  const inTheWay = own.filter((record) => record.type === "CNAME").map((record) => record.id);
  return inTheWay.length > 0 ? { kind: "replace", removeIds: inTheWay } : { kind: "create" };
}

/** The `ip=` line of https://1.1.1.1/cdn-cgi/trace; null unless it is a valid IPv4. */
export function parseTraceIp(trace: string): string | null {
  const ip = /^ip=(.+)$/m.exec(trace)?.[1]?.trim() ?? "";
  const octets = IPV4_PATTERN.exec(ip);
  if (!octets || octets.slice(1).some((octet) => Number(octet) > 255)) return null;
  return ip;
}

/** Asked over IPv4 (1.1.1.1), so the answer is the address the router shows the world. */
export async function fetchPublicIp(): Promise<string> {
  const response = await fetch("https://1.1.1.1/cdn-cgi/trace", { signal: AbortSignal.timeout(10_000) });
  const ip = parseTraceIp(await response.text());
  if (!ip) throw new Error("could not read the public IPv4 address");
  return ip;
}

export interface CloudflareDns {
  token: string;
  zoneId: string;
}

async function cloudflare<T>(dns: CloudflareDns, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${dns.zoneId}/dns_records${path}`, {
    method,
    headers: { Authorization: `Bearer ${dns.token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = (await response.json()) as { success?: boolean; result?: T; errors?: Array<{ message?: string }> };
  if (!response.ok || !payload.success) {
    const reason = payload.errors?.map((error) => error.message).join("; ") || `HTTP ${response.status}`;
    throw new Error(`Cloudflare ${method} dns_records${path}: ${reason}`);
  }
  return payload.result as T;
}

/** Points `hostname` at `ip` (DNS only). Returns what it changed, for the log. */
export async function syncDnsRecord(dns: CloudflareDns, hostname: string, ip: string): Promise<DnsPlan> {
  const records = await cloudflare<DnsRecord[]>(dns, "GET", `?name=${encodeURIComponent(hostname)}`);
  const plan = planDnsChange(records, hostname, ip);
  const address = { type: "A", name: hostname, content: ip, proxied: false, ttl: RECORD_TTL_SECONDS };
  switch (plan.kind) {
    case "none":
      break;
    case "update":
      await cloudflare(dns, "PATCH", `/${plan.recordId}`, address);
      break;
    case "replace":
      for (const id of plan.removeIds) await cloudflare(dns, "DELETE", `/${id}`);
      await cloudflare(dns, "POST", "", address);
      break;
    case "create":
      await cloudflare(dns, "POST", "", address);
      break;
  }
  return plan;
}
