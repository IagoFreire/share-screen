import { describe, expect, it } from "vitest";
import { parseTraceIp, planDnsChange, type DnsRecord } from "./ddns.js";

const HOST = "share.iagofreire.dev";
const IP = "203.0.113.7";

const record = (overrides: Partial<DnsRecord>): DnsRecord => ({
  id: "r1",
  type: "A",
  name: HOST,
  content: IP,
  proxied: false,
  ...overrides,
});

describe("planDnsChange", () => {
  it("leaves a record that already points here, unproxied", () => {
    expect(planDnsChange([record({})], HOST, IP)).toEqual({ kind: "none" });
  });

  it("updates the address after the home IP changed", () => {
    expect(planDnsChange([record({ content: "198.51.100.1" })], HOST, IP)).toEqual({ kind: "update", recordId: "r1" });
  });

  it("turns the orange cloud off: Cloudflare's proxy would sit in front of Caddy again", () => {
    expect(planDnsChange([record({ proxied: true })], HOST, IP)).toEqual({ kind: "update", recordId: "r1" });
  });

  it("replaces the tunnel's CNAME with an address record", () => {
    const tunnel = record({ id: "c1", type: "CNAME", content: "abc.cfargotunnel.com", proxied: true });

    expect(planDnsChange([tunnel], HOST, IP)).toEqual({ kind: "replace", removeIds: ["c1"] });
  });

  it("creates the record when the name has none", () => {
    expect(planDnsChange([], HOST, IP)).toEqual({ kind: "create" });
  });

  it("ignores records of other names and of other types", () => {
    const other = record({ id: "o1", name: "www.iagofreire.dev", content: "198.51.100.1" });
    const txt = record({ id: "t1", type: "TXT", content: "hello" });

    expect(planDnsChange([other, txt, record({})], HOST, IP)).toEqual({ kind: "none" });
  });
});

describe("parseTraceIp", () => {
  it("reads the address from Cloudflare's trace", () => {
    expect(parseTraceIp(`fl=1\nh=1.1.1.1\nip=${IP}\nts=1\n`)).toBe(IP);
  });

  it("refuses anything that isn't an IPv4 address", () => {
    expect(parseTraceIp("ip=2001:db8::1\n")).toBeNull();
    expect(parseTraceIp("ip=999.1.1.1\n")).toBeNull();
    expect(parseTraceIp("no address here")).toBeNull();
  });
});
