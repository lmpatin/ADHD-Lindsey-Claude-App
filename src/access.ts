// Verifies the Cloudflare Access JWT on every protected request. Access sits
// in front of the app, but checking its token here as well means the
// workers.dev URL (or a misconfigured Access app) can't expose the data.

interface Jwk extends JsonWebKey {
  kid: string;
}

let certCache: { team: string; keys: Jwk[]; fetched: number } | null = null;

async function accessKeys(team: string): Promise<Jwk[]> {
  if (certCache && certCache.team === team && Date.now() - certCache.fetched < 3600_000) {
    return certCache.keys;
  }
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs fetch failed: ${res.status}`);
  const json = (await res.json()) as { keys: Jwk[] };
  certCache = { team, keys: json.keys, fetched: Date.now() };
  return json.keys;
}

function b64urlBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson<T>(s: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
}

export interface AccessConfig {
  teamDomain: string; // e.g. "lindsey.cloudflareaccess.com"
  aud: string; // the Access application's AUD tag
  allowedEmail?: string;
}

/** Returns the signed-in email when the request carries a valid Access JWT, else null. */
export async function verifyAccess(request: Request, cfg: AccessConfig): Promise<string | null> {
  const token =
    request.headers.get("Cf-Access-Jwt-Assertion") ??
    request.headers
      .get("Cookie")
      ?.split(/;\s*/)
      .find((c) => c.startsWith("CF_Authorization="))
      ?.slice("CF_Authorization=".length);
  if (!token) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = b64urlJson<{ alg: string; kid: string }>(parts[0]);
    const claims = b64urlJson<{ aud: string | string[]; exp: number; iss: string; email?: string }>(parts[1]);
    if (header.alg !== "RS256") return null;

    const jwk = (await accessKeys(cfg.teamDomain)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
      "verify",
    ]);
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!ok) return null;

    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!auds.includes(cfg.aud)) return null;
    if (claims.iss !== `https://${cfg.teamDomain}`) return null;
    if (claims.exp * 1000 < Date.now()) return null;
    const email = claims.email ?? "";
    if (cfg.allowedEmail && email.toLowerCase() !== cfg.allowedEmail.toLowerCase()) return null;
    return email || "access-user";
  } catch {
    return null;
  }
}

/** Constant-time string comparison for the feed token. */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}
