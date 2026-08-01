/**
 * Resolve the only proxy-trust shape the HTTP server supports.
 *
 * A bounded hop count is intentionally used instead of Express's boolean
 * `true`: the latter trusts every X-Forwarded-For entry and lets a caller
 * rotate an IP-keyed rate-limit bucket. The deployment contract is one Caddy
 * hop, so the default is 1 and production rejects permissive spellings.
 */
export function resolveTrustProxy(raw: string | undefined, production = process.env.NODE_ENV === "production"): number {
  const value = raw ?? "1";
  if (["true", "*", "all", "0.0.0.0/0", "::/0"].includes(value.trim().toLowerCase())) {
    if (production) throw new Error(`Unsafe TRUST_PROXY_HOPS=${value}; use a bounded integer hop count (0-5)`);
    return 0;
  }
  if (!/^\d+$/.test(value) || Number(value) > 5) throw new Error(`Invalid TRUST_PROXY_HOPS=${value}; use a bounded integer hop count from 0 to 5`);
  return Number(value);
}