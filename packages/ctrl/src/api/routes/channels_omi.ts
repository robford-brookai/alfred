// Lane I — OMI channel routes (/api/v1/channels/omi/*) + the consumer-facing
// /api/v1/credentials/groq-api-key surface.
//
// Mirrors the Telegram / Slack / SMS /channels lane pattern
// (packages/ctrl/src/api/routes/telegram.ts,
//  packages/ctrl/src/api/routes/slack.ts,
//  packages/ctrl/src/api/routes/sms.ts).
//
// What's different from the other channel cards
// ---------------------------------------------
// OMI is a *hardware* channel: the device POSTs raw PCM16 audio chunks at
// /api/v1/streams/omi/audio?token=… (public, token-auth — see routes/omi.ts).
// The transcription step is alfred-learn's job (Lane V) — it pulls audio
// out of /alfred-data/streams/omi-audio/<uid>/<ts>.pcm, hits Groq Whisper,
// and writes the transcript into the canonical conversation/ vault. That
// means the Groq API key has TWO consumers:
//
//   * /api/v1/channels/omi/groq-key  — operator-write surface (PUT/DELETE).
//   * /api/v1/credentials/groq-api-key — alfred-learn pulls the key here at
//                                        transcription-activity time. The
//                                        master AAS_API_KEY is required;
//                                        the voice-bridge scoped token does
//                                        NOT cover this route (see auth.ts).
//
// There is NO per-profile Hermes .env mutation here and NO alfred-learn
// restart on key change — alfred-learn re-fetches the key per call, so a
// rotation takes effect on the next transcription without bouncing any
// container. (Contrast with the SMS/Slack/Telegram lanes which all write
// per-profile env keys + restart Hermes.)
//
// Vaultwarden is still the canonical store:
//   "Groq API Key (OMI transcription)" — the single item this lane touches.
//
// FAIL-SOFT POLICY mirrors Telegram/Slack/SMS: /status MUST NOT 5xx; the
// dashboard polls it. On any upstream failure (vault outage, fs hiccup)
// return state:"error" + the message in `error` so the UI shows a "needs
// attention" card.

import fs from "node:fs";
import path from "node:path";
import { addRoute } from "../server.js";
import { sendJson, ValidationError, NotFoundError } from "../errors.js";
import { getIngestDb } from "../../db/ingest.js";

const VAULT_CLI_URL = process.env.VAULT_CLI_URL || "http://vault-cli:8087";
const VAULT_GROQ_ITEM_NAME = "Groq API Key (OMI transcription)";

// alfred-data layout mirrors routes/omi.ts.
const ALFRED_DATA_DIR = process.env.ALFRED_DATA_DIR ?? "/alfred-data";
const STREAMS_DIR = path.join(ALFRED_DATA_DIR, "streams");
const OMI_AUDIO_DIR = path.join(STREAMS_DIR, "omi-audio");
const STREAMS_META_PATH = path.join(STREAMS_DIR, "streams.json");

// Public host the OMI device hits when posting audio. Mirrors streams.ts's
// composeWebhookUrl("omi", …): when TENANT_BASE_URL is unset the device URL
// can't be composed and we surface state:"unconfigured" (operator has not
// completed OMI pairing yet).
function tenantBaseUrl(): string | null {
  const base = process.env.TENANT_BASE_URL;
  if (!base) return null;
  return base.replace(/\/$/, "");
}

function composeOmiWebhookUrl(webhookToken: string): string | null {
  const base = tenantBaseUrl();
  if (!base) return null;
  return `${base}/api/v1/streams/omi/audio?token=${webhookToken}&uid=omi-device`;
}

type OmiState = "unconfigured" | "needs_groq_key" | "configured" | "error";

interface OmiStatus {
  configured: boolean;
  state: OmiState;
  error: string | null;
  webhook_url: string | null;
  groq_key_present: boolean;
  recent_transcripts_24h: number;
  last_audio_at: string | null;
}

// ── vault-cli helpers (mirror of slack.ts / sms.ts) ──────────────────────
//
// Convention from the other channel routes: keep these local per file,
// don't factor into a shared module.

interface BwEnvelope {
  success?: boolean;
  data?: unknown;
  message?: string;
}

async function bwFetch(
  pathSuffix: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`${VAULT_CLI_URL}${pathSuffix}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await r.text();
  try {
    return { status: r.status, body: JSON.parse(text) };
  } catch {
    return { status: r.status, body: text };
  }
}

function unwrap(
  body: unknown,
): { ok: true; data: unknown } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, message: "vault-cli returned non-JSON body" };
  }
  const env = body as BwEnvelope;
  if (env.success === false)
    return { ok: false, message: env.message ?? "vault-cli error" };
  if (env.success === true && "data" in env) return { ok: true, data: env.data };
  return { ok: true, data: body };
}

async function findVaultItem(
  name: string,
): Promise<{ id: string; password: string | null } | null> {
  const r = await bwFetch(
    `/list/object/items?search=${encodeURIComponent(name)}`,
  );
  if (r.status >= 500)
    throw new Error(`vault-cli unreachable (HTTP ${r.status})`);
  const u = unwrap(r.body);
  if (!u.ok) throw new Error(u.message);
  const data = u.data as Record<string, unknown> | unknown[];
  const list = Array.isArray(data)
    ? data
    : Array.isArray((data as Record<string, unknown>).data)
      ? ((data as Record<string, unknown>).data as unknown[])
      : [];
  for (const raw of list) {
    if (typeof raw !== "object" || raw === null) continue;
    const it = raw as Record<string, unknown>;
    if (typeof it.name !== "string") continue;
    if (it.name.toLowerCase() !== name.toLowerCase()) continue;
    const login =
      typeof it.login === "object" && it.login !== null
        ? (it.login as Record<string, unknown>)
        : null;
    const password =
      login && typeof login.password === "string" ? login.password : null;
    return { id: typeof it.id === "string" ? it.id : "", password };
  }
  return null;
}

async function upsertVaultItem(name: string, secret: string): Promise<void> {
  const existing = await findVaultItem(name);
  if (existing && existing.id) {
    const cur = await bwFetch(`/object/item/${existing.id}`);
    const curU = unwrap(cur.body);
    if (!curU.ok) throw new Error(curU.message);
    const existingItem =
      (curU.data as Record<string, unknown>).data ?? curU.data;
    const e = existingItem as Record<string, unknown>;
    const existingLogin =
      typeof e.login === "object" && e.login !== null
        ? ({ ...(e.login as Record<string, unknown>) } as Record<string, unknown>)
        : { username: null, password: null, uris: [] };
    existingLogin.password = secret;
    const merged = { ...e, name, login: existingLogin };
    const r = await bwFetch(`/object/item/${existing.id}`, {
      method: "PUT",
      body: JSON.stringify(merged),
    });
    const u = unwrap(r.body);
    if (!u.ok) throw new Error(u.message);
    return;
  }
  const payload = {
    type: 1,
    name,
    notes:
      "Groq API key alfred-learn uses to transcribe OMI audio chunks " +
      "(Whisper). Source of truth for the OMI channel card.",
    folderId: null,
    favorite: false,
    reprompt: 0,
    login: {
      username: null,
      password: secret,
      uris: [{ uri: "https://console.groq.com/", match: null }],
    },
  };
  const r = await bwFetch("/object/item", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const u = unwrap(r.body);
  if (!u.ok) throw new Error(u.message);
}

async function deleteVaultItem(name: string): Promise<void> {
  const existing = await findVaultItem(name);
  if (!existing || !existing.id) return; // idempotent
  const r = await bwFetch(`/object/item/${existing.id}`, { method: "DELETE" });
  const u = unwrap(r.body);
  if (!u.ok) throw new Error(u.message);
}

// ── OMI stream metadata reader ────────────────────────────────────────────
//
// Inspect /alfred-data/streams/streams.json for the source:"omi" entry the
// integrations OMI-pair route creates (see routes/streams.ts ::
// createOrReuseOmiStream). The webhook_url is null until that stream exists,
// which keeps the state machine honest: an operator must run "Pair OMI"
// before the channel card can transition past `unconfigured`.

interface StreamMetaLite {
  id: string;
  source: string;
  webhookToken?: string;
}

function readOmiStreamToken(): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(STREAMS_META_PATH, "utf-8");
  } catch {
    return null;
  }
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  for (const entry of arr) {
    if (typeof entry !== "object" || entry === null) continue;
    const s = entry as StreamMetaLite;
    if (s.source === "omi" && typeof s.webhookToken === "string" && s.webhookToken) {
      return s.webhookToken;
    }
  }
  return null;
}

// ── recent-activity surface ──────────────────────────────────────────────
//
// Two signals power the UI's "is OMI actually hearing anything?" badge:
//
//   recent_transcripts_24h — count of rows in ingest.db's stream_event
//                            where channel='omi-audio' within the last 24h.
//                            This is the durable, post-EventProcessor count
//                            (one row per audio chunk that made it through
//                            the puller).
//   last_audio_at          — mtime of the newest .pcm file in
//                            /alfred-data/streams/omi-audio/<uid>/, across
//                            all uids. This is the rawest possible signal:
//                            it goes up the instant the device POSTs.
//
// Both are best-effort: on a vault or fs hiccup we return 0 / null rather
// than 5xx-ing the status route.

function countRecentOmiTranscripts(): number {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const row = getIngestDb()
      .prepare(
        "SELECT COUNT(*) AS n FROM stream_event WHERE channel = ? AND ts >= ?",
      )
      .get("omi-audio", since) as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

function findLastAudioMtime(): string | null {
  let latestMs = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(OMI_AUDIO_DIR, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const uidEnt of entries) {
    if (!uidEnt.isDirectory()) continue;
    const uidDir = path.join(OMI_AUDIO_DIR, uidEnt.name);
    let inner: fs.Dirent[];
    try {
      inner = fs.readdirSync(uidDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of inner) {
      if (!f.isFile()) continue;
      if (!f.name.endsWith(".pcm")) continue;
      try {
        const st = fs.statSync(path.join(uidDir, f.name));
        if (st.mtimeMs > latestMs) latestMs = st.mtimeMs;
      } catch {
        // best-effort
      }
    }
  }
  return latestMs > 0 ? new Date(latestMs).toISOString() : null;
}

// ── Groq validation ───────────────────────────────────────────────────────
//
// Validate via GET https://api.groq.com/openai/v1/models — a cheap auth
// probe Groq supports for the OpenAI-compatible surface. 200 → ok. Anything
// else → 400 from PUT with the upstream error verbatim so the UI can show a
// useful "Groq rejected key" message.

interface GroqProbe {
  ok: boolean;
  error: string | null;
}

async function probeGroqKey(apiKey: string): Promise<GroqProbe> {
  try {
    const r = await fetch("https://api.groq.com/openai/v1/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (r.ok) return { ok: true, error: null };
    let detail = `HTTP ${r.status}`;
    try {
      const j = (await r.json()) as { error?: { message?: string } | string };
      const msg =
        typeof j.error === "object" && j.error && "message" in j.error
          ? (j.error.message as string)
          : typeof j.error === "string"
            ? j.error
            : null;
      if (msg) detail = msg;
    } catch {
      // body wasn't JSON; keep the HTTP code as the detail
    }
    return { ok: false, error: detail };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Routes ────────────────────────────────────────────────────────────────

export function registerOmiChannelRoutes(): void {
  // GET /status — fail-soft. NEVER 5xx (dashboard polls it).
  addRoute("GET", "/api/v1/channels/omi/status", async ({ res }) => {
    let webhookToken: string | null = null;
    let webhookUrl: string | null = null;
    let groqKeyPresent = false;
    let errorMsg: string | null = null;

    try {
      webhookToken = readOmiStreamToken();
      if (webhookToken) webhookUrl = composeOmiWebhookUrl(webhookToken);
    } catch (e) {
      errorMsg = `streams meta: ${e instanceof Error ? e.message : String(e)}`;
    }

    if (!errorMsg) {
      try {
        const vaultItem = await findVaultItem(VAULT_GROQ_ITEM_NAME);
        groqKeyPresent = Boolean(
          vaultItem && vaultItem.password && vaultItem.password.length > 0,
        );
      } catch (e) {
        errorMsg = `vault: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    const recent = countRecentOmiTranscripts();
    const lastAudio = findLastAudioMtime();

    if (errorMsg) {
      sendJson(res, 200, {
        configured: false,
        state: "error",
        error: errorMsg,
        webhook_url: webhookUrl,
        groq_key_present: groqKeyPresent,
        recent_transcripts_24h: recent,
        last_audio_at: lastAudio,
      } satisfies OmiStatus);
      return;
    }

    let state: OmiState;
    if (!webhookUrl) state = "unconfigured";
    else if (!groqKeyPresent) state = "needs_groq_key";
    else state = "configured";

    sendJson(res, 200, {
      configured: state === "configured",
      state,
      error: null,
      webhook_url: webhookUrl,
      groq_key_present: groqKeyPresent,
      recent_transcripts_24h: recent,
      last_audio_at: lastAudio,
    } satisfies OmiStatus);
  });

  // PUT /groq-key — validate against Groq, upsert vault item.
  // Body: { api_key: string }.
  addRoute("PUT", "/api/v1/channels/omi/groq-key", async ({ res, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const apiKey = typeof b.api_key === "string" ? b.api_key.trim() : "";
    if (!apiKey) {
      throw new ValidationError("api_key is required (non-empty string)");
    }

    // Validate against Groq's OpenAI-compatible /v1/models endpoint.
    const probe = await probeGroqKey(apiKey);
    if (!probe.ok) {
      sendJson(res, 400, {
        ok: false,
        error: `groq rejected key${probe.error ? `: ${probe.error}` : ""}`,
      });
      return;
    }

    // Vaultwarden upsert. No env mutation, no container restart — alfred-learn
    // re-fetches per call via GET /api/v1/credentials/groq-api-key.
    await upsertVaultItem(VAULT_GROQ_ITEM_NAME, apiKey);
    sendJson(res, 200, { ok: true, state: "configured" });
  });

  // DELETE /groq-key — wipe vault item. The OMI stream + webhook_url stay;
  // the next status read transitions back to needs_groq_key (or unconfigured
  // if pairing was undone by some other path).
  addRoute("DELETE", "/api/v1/channels/omi/groq-key", async ({ res }) => {
    await deleteVaultItem(VAULT_GROQ_ITEM_NAME);
    sendJson(res, 200, { ok: true, state: "needs_groq_key" });
  });

  // POST /test — local round-trip the audio path. POSTs 2KB of zero-padded
  // bytes to /api/v1/streams/omi/audio?token=…&uid=omi-device on
  // 127.0.0.1:AAS_PORT. The streams/omi/audio route is public (token-auth)
  // so we don't need to forward any Bearer.
  //
  // This is a structural smoke test — it proves the URL composes, the token
  // resolves to a stream, and the writer can land a .pcm on disk. It is NOT
  // a transcription test (those need real audio + Groq).
  addRoute("POST", "/api/v1/channels/omi/test", async ({ res }) => {
    const token = readOmiStreamToken();
    if (!token) {
      sendJson(res, 200, {
        ok: false,
        error: "OMI is not paired — no source:'omi' stream exists yet",
      });
      return;
    }
    const host = process.env.AAS_HOST ?? "127.0.0.1";
    const port = process.env.AAS_PORT ?? "3100";
    const url =
      `http://${host}:${port}/api/v1/streams/omi/audio` +
      `?token=${encodeURIComponent(token)}&uid=omi-device`;
    const payload = Buffer.alloc(2048, 0); // 2KB of zero-padded bytes
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: payload,
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) {
        sendJson(res, 200, {
          ok: false,
          error: `streams/omi/audio returned HTTP ${r.status}`,
        });
        return;
      }
      // The audio endpoint always returns 200 + { status, ... }. Treat any
      // status: "error" as a test failure so the UI surfaces it instead of
      // pretending the round-trip worked.
      const j = (await r.json().catch(() => ({}))) as {
        status?: string;
        reason?: string;
        size_bytes?: number;
      };
      if (j.status !== "ok") {
        sendJson(res, 200, {
          ok: false,
          error: j.reason ?? "streams/omi/audio rejected the test payload",
        });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        size_bytes: typeof j.size_bytes === "number" ? j.size_bytes : payload.length,
      });
    } catch (e) {
      sendJson(res, 200, {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  // GET /api/v1/credentials/groq-api-key — the consumer-facing read surface.
  // alfred-learn (Lane V) hits this at transcription-activity time. Master
  // AAS_API_KEY is required (server.ts gates this via authenticate()); the
  // voice-bridge scoped token is NOT in the allowlist, so it 401s here.
  addRoute("GET", "/api/v1/credentials/groq-api-key", async ({ res }) => {
    let item: { id: string; password: string | null } | null;
    try {
      item = await findVaultItem(VAULT_GROQ_ITEM_NAME);
    } catch (e) {
      // Vault outage = service unavailable, not a 404. Caller (alfred-learn)
      // should retry rather than treat the key as "absent".
      sendJson(res, 503, {
        error: "vault unavailable",
        detail: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    if (!item || !item.password) {
      throw new NotFoundError("not configured");
    }
    sendJson(res, 200, { api_key: item.password });
  });
}
