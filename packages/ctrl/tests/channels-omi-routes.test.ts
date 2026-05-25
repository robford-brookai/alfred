// Lane I — /api/v1/channels/omi/* + /api/v1/credentials/groq-api-key.
//
// Mirrors sms-routes.test.ts / slack-routes.test.ts (same vault-cli + fetch
// mock pattern). The OMI channel differs from the SMS/Slack/Telegram lanes:
// it touches NO per-profile Hermes .env, fires NO Hermes restart, and the
// canonical store is a SINGLE Vaultwarden item:
//
//   "Groq API Key (OMI transcription)"
//
// Behaviours under test (10):
//   1. GET /status → unconfigured when no OMI stream exists
//   2. GET /status → needs_groq_key when stream exists but no vault item
//   3. GET /status → configured when both exist
//   4. PUT /groq-key valid → 200, vault upsert, Groq /v1/models probe
//   5. PUT /groq-key empty body → 400, no side effects
//   6. PUT /groq-key Groq rejects → 400 with verbatim error
//   7. DELETE /groq-key → vault wipe, state=needs_groq_key
//   8. POST /test → posts 2KB to /streams/omi/audio, returns size_bytes
//   9. GET /credentials/groq-api-key → 200 + { api_key } when present
//  10. GET /credentials/groq-api-key → 404 when absent
//
// Privacy: this is a public OSS repo. Tests use synthetic placeholders only
// — the Groq key is "gsk_TEST_…" and never resembles a real key.

import { mock, describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "channels-omi-routes-"));
process.env.COMPOSE_DIR = tmp;
process.env.ALFRED_DATA_DIR = tmp;
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.INGEST_DB_PATH = path.join(tmp, "ingest.db");
process.env.SQLITE_VEC_PATH = "";
process.env.VAULT_CLI_URL = "http://vault-cli-stub:8087";
process.env.TENANT_BASE_URL = "https://test.alfred.black";
process.env.AAS_HOST = "127.0.0.1";
process.env.AAS_PORT = "3100";

const STREAMS_DIR = path.join(tmp, "streams");
const OMI_AUDIO_DIR = path.join(STREAMS_DIR, "omi-audio");
const STREAMS_META_PATH = path.join(STREAMS_DIR, "streams.json");

// Synthetic placeholders — never a real Groq key.
const VALID_KEY = "gsk_TEST_" + "0".repeat(40);
const WEBHOOK_TOKEN = "f".repeat(48); // mirrors crypto.randomBytes(24).toString("hex")

// ── vault-cli + Groq + local-audio mock ───────────────────────────────────

interface VaultItem {
  id: string;
  name: string;
  type: 1;
  login: { username: string | null; password: string; uris: unknown[] };
}
let vaultStore: VaultItem[] = [];

let groqProbeOk = true;
let groqProbeStatus = 200;
let groqProbeErrorMessage = "Invalid API Key";
const groqProbeCalls: { url: string; auth: string }[] = [];

let audioEndpointOk = true;
let audioEndpointSize = 2048;
const audioEndpointCalls: { url: string; size: number; contentType: string }[] = [];

const originalFetch = globalThis.fetch;
function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : (input.url ?? String(input));
  const method = (init?.method ?? "GET").toUpperCase();

  // Groq /v1/models probe — auth-validation surface used by PUT /groq-key.
  if (url === "https://api.groq.com/openai/v1/models") {
    const authHeader = (init?.headers?.Authorization ??
      init?.headers?.authorization ??
      "") as string;
    groqProbeCalls.push({ url, auth: authHeader });
    if (groqProbeOk) {
      return makeJsonResponse({ data: [{ id: "whisper-large-v3" }] }, 200);
    }
    return makeJsonResponse(
      { error: { message: groqProbeErrorMessage } },
      groqProbeStatus,
    );
  }

  // Local audio endpoint — what POST /test round-trips against.
  if (
    method === "POST" &&
    url.startsWith("http://127.0.0.1:3100/api/v1/streams/omi/audio")
  ) {
    const buf =
      init?.body instanceof Buffer
        ? init.body
        : Buffer.from(init?.body ?? "");
    const ct =
      (init?.headers?.["content-type"] ??
        init?.headers?.["Content-Type"] ??
        "") as string;
    audioEndpointCalls.push({ url, size: buf.length, contentType: ct });
    if (!audioEndpointOk) {
      return makeJsonResponse(
        { status: "error", reason: "invalid_token" },
        200,
      );
    }
    return makeJsonResponse(
      { status: "ok", size_bytes: audioEndpointSize },
      200,
    );
  }

  // vault-cli
  if (url.includes("/list/object/items")) {
    const qIdx = url.indexOf("?");
    const params = new URLSearchParams(qIdx >= 0 ? url.slice(qIdx + 1) : "");
    const search = params.get("search") ?? "";
    const filtered = search
      ? vaultStore.filter((i) =>
          i.name.toLowerCase().includes(search.toLowerCase()),
        )
      : vaultStore.slice();
    return makeJsonResponse({ success: true, data: { data: filtered } });
  }
  const objMatch = url.match(/\/object\/item\/([^/?]+)/);
  if (objMatch && method === "GET") {
    const id = objMatch[1];
    const item = vaultStore.find((i) => i.id === id);
    if (!item)
      return makeJsonResponse(
        { success: false, message: "not found" },
        404,
      );
    return makeJsonResponse({ success: true, data: { data: item } });
  }
  if (url.endsWith("/object/item") && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const id =
      "id-" +
      String(Date.now()) +
      "-" +
      Math.random().toString(36).slice(2, 8);
    const item: VaultItem = {
      id,
      name: body.name,
      type: 1,
      login: {
        username: body.login?.username ?? null,
        password: body.login?.password ?? "",
        uris: body.login?.uris ?? [],
      },
    };
    vaultStore.push(item);
    return makeJsonResponse({ success: true, data: { data: item } });
  }
  if (objMatch && method === "PUT") {
    const id = objMatch[1];
    const idx = vaultStore.findIndex((i) => i.id === id);
    if (idx < 0)
      return makeJsonResponse(
        { success: false, message: "not found" },
        404,
      );
    const body = JSON.parse(String(init?.body ?? "{}"));
    vaultStore[idx] = {
      ...vaultStore[idx],
      name: body.name ?? vaultStore[idx].name,
      login: { ...vaultStore[idx].login, ...(body.login ?? {}) },
    };
    return makeJsonResponse({ success: true, data: { data: vaultStore[idx] } });
  }
  if (objMatch && method === "DELETE") {
    const id = objMatch[1];
    const idx = vaultStore.findIndex((i) => i.id === id);
    if (idx < 0)
      return makeJsonResponse(
        { success: false, message: "not found" },
        404,
      );
    vaultStore.splice(idx, 1);
    return makeJsonResponse({ success: true });
  }
  throw new Error(`unexpected fetch in channels-omi-routes test: ${method} ${url}`);
}) as typeof fetch;

// Stub the ingest.db module so the status route's transcript count returns
// a controllable value without opening a real sqlite file in the test. The
// real module has other exports (sweepIngestTTL, startIngestSweep, …) that
// transitive routes/streams.ts → routes/ingest.ts re-import, so we spread
// the real exports first and only override getIngestDb.
let mockRecentCount = 0;
const realIngest = await import("../src/db/ingest.js");
mock.module("../src/db/ingest.js", {
  namedExports: {
    ...realIngest,
    getIngestDb: () => ({
      prepare: (_sql: string) => ({
        get: (_channel: string, _since: string) => ({ n: mockRecentCount }),
      }),
    }),
  },
});

const { registerOmiChannelRoutes } = await import(
  "../src/api/routes/channels_omi.js"
);
const { matchRoute } = await import("../src/api/server.js");
registerOmiChannelRoutes();

interface CallResult {
  status: number;
  payload: any;
}
async function call(
  method: string,
  p: string,
  body?: unknown,
): Promise<CallResult> {
  const m = matchRoute(method, p);
  assert.ok(m, `${method} ${p} must be registered`);
  let status = 0;
  let payload: any;
  const res: any = {
    statusCode: 0,
    setHeader() {},
    writeHead(c: number) {
      status = c;
    },
    end(j?: string) {
      payload = j ? JSON.parse(j) : undefined;
    },
  };
  try {
    await m!.handler({
      req: { method, headers: {} } as any,
      res,
      params: {},
      body,
      query: new URLSearchParams(),
    });
  } catch (e: any) {
    if (e?.statusCode) {
      status = e.statusCode;
      payload = { error: { code: e.code, message: e.message } };
    } else {
      throw e;
    }
  }
  return { status: status || res.statusCode, payload };
}

function seedOmiStream(token = WEBHOOK_TOKEN): void {
  fs.mkdirSync(STREAMS_DIR, { recursive: true });
  fs.writeFileSync(
    STREAMS_META_PATH,
    JSON.stringify([
      {
        id: "omi-ambient",
        name: "Omi Ambient",
        type: "webhook",
        source: "omi",
        enabled: true,
        status: "idle",
        last_event_at: null,
        event_count: 0,
        webhookToken: token,
      },
    ]),
  );
}

function clearStreams(): void {
  try {
    fs.unlinkSync(STREAMS_META_PATH);
  } catch {
    // not there → fine
  }
  // Wipe omi-audio dir between tests so last_audio_at doesn't leak.
  try {
    fs.rmSync(OMI_AUDIO_DIR, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

describe("/api/v1/channels/omi/* + /api/v1/credentials/groq-api-key", () => {
  beforeEach(() => {
    vaultStore = [];
    groqProbeCalls.length = 0;
    audioEndpointCalls.length = 0;
    groqProbeOk = true;
    groqProbeStatus = 200;
    groqProbeErrorMessage = "Invalid API Key";
    audioEndpointOk = true;
    audioEndpointSize = 2048;
    mockRecentCount = 0;
    clearStreams();
  });

  it("GET /status → unconfigured when no OMI stream exists", async () => {
    const r = await call("GET", "/api/v1/channels/omi/status");
    assert.equal(r.status, 200);
    assert.equal(r.payload.state, "unconfigured");
    assert.equal(r.payload.configured, false);
    assert.equal(r.payload.webhook_url, null);
    assert.equal(r.payload.groq_key_present, false);
    assert.equal(r.payload.error, null);
    assert.equal(r.payload.recent_transcripts_24h, 0);
    assert.equal(r.payload.last_audio_at, null);
  });

  it("GET /status → needs_groq_key when stream exists but no vault item", async () => {
    seedOmiStream();
    const r = await call("GET", "/api/v1/channels/omi/status");
    assert.equal(r.status, 200);
    assert.equal(r.payload.state, "needs_groq_key");
    assert.equal(r.payload.configured, false);
    assert.ok(
      typeof r.payload.webhook_url === "string" &&
        r.payload.webhook_url.includes("/api/v1/streams/omi/audio") &&
        r.payload.webhook_url.includes(WEBHOOK_TOKEN),
      `expected composed webhook url, got ${r.payload.webhook_url}`,
    );
    assert.ok(r.payload.webhook_url.startsWith("https://test.alfred.black/"));
    assert.equal(r.payload.groq_key_present, false);
    assert.equal(r.payload.error, null);
  });

  it("GET /status → configured when stream + vault item both present, surfaces recent_transcripts_24h", async () => {
    seedOmiStream();
    vaultStore = [
      {
        id: "v-groq",
        name: "Groq API Key (OMI transcription)",
        type: 1,
        login: { username: null, password: VALID_KEY, uris: [] },
      },
    ];
    mockRecentCount = 7;

    const r = await call("GET", "/api/v1/channels/omi/status");
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.state, "configured");
    assert.equal(r.payload.configured, true);
    assert.equal(r.payload.groq_key_present, true);
    assert.equal(r.payload.error, null);
    assert.equal(r.payload.recent_transcripts_24h, 7);

    // The status payload must NEVER leak the actual Groq key.
    const ser = JSON.stringify(r.payload);
    assert.ok(
      !ser.includes(VALID_KEY),
      "groq api key must never appear in status payload",
    );
  });

  it("PUT /groq-key valid → vault upsert + Groq /v1/models probe with Bearer", async () => {
    const r = await call("PUT", "/api/v1/channels/omi/groq-key", {
      api_key: VALID_KEY,
    });
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.state, "configured");

    // Groq probe fired with Bearer auth.
    assert.equal(
      groqProbeCalls.length,
      1,
      "Groq /v1/models must be probed exactly once on PUT",
    );
    assert.equal(groqProbeCalls[0].auth, `Bearer ${VALID_KEY}`);

    // Vault now holds exactly one item with the canonical name + the key.
    assert.equal(vaultStore.length, 1, "exactly one vault item");
    assert.equal(vaultStore[0].name, "Groq API Key (OMI transcription)");
    assert.equal(vaultStore[0].login.password, VALID_KEY);
  });

  it("PUT /groq-key empty body → 400, no Groq probe, no vault write", async () => {
    const r = await call("PUT", "/api/v1/channels/omi/groq-key", {});
    assert.equal(r.status, 400);
    assert.equal(groqProbeCalls.length, 0, "must not probe Groq when body is invalid");
    assert.equal(vaultStore.length, 0, "must not touch vault when body is invalid");
  });

  it("PUT /groq-key Groq rejection → 400 with verbatim Groq error, no vault write", async () => {
    groqProbeOk = false;
    groqProbeStatus = 401;
    groqProbeErrorMessage = "Invalid API Key";

    const r = await call("PUT", "/api/v1/channels/omi/groq-key", {
      api_key: "gsk_TEST_bad_key",
    });
    assert.equal(r.status, 400);
    assert.equal(r.payload.ok, false);
    assert.match(
      r.payload.error,
      /groq rejected key/i,
      `expected "groq rejected key" preamble, got: ${r.payload.error}`,
    );
    assert.match(
      r.payload.error,
      /Invalid API Key/,
      `expected verbatim Groq error message, got: ${r.payload.error}`,
    );
    assert.equal(vaultStore.length, 0, "vault must not be written on Groq rejection");
  });

  it("DELETE /groq-key → wipes vault item, returns state=needs_groq_key", async () => {
    // Seed: an existing vault item + a paired OMI stream so the post-delete
    // state would logically be needs_groq_key (the webhook still exists).
    seedOmiStream();
    vaultStore = [
      {
        id: "v-groq",
        name: "Groq API Key (OMI transcription)",
        type: 1,
        login: { username: null, password: VALID_KEY, uris: [] },
      },
    ];

    const r = await call("DELETE", "/api/v1/channels/omi/groq-key");
    assert.equal(r.status, 200);
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.state, "needs_groq_key");

    // Vault item is gone; the OMI stream meta is intact.
    assert.equal(vaultStore.length, 0, "vault item must be wiped");
    assert.ok(
      fs.existsSync(STREAMS_META_PATH),
      "OMI stream meta must NOT be wiped by /groq-key DELETE",
    );

    // A subsequent /status should now report needs_groq_key, not unconfigured.
    const status = await call("GET", "/api/v1/channels/omi/status");
    assert.equal(status.payload.state, "needs_groq_key");
  });

  it("POST /test → posts 2KB of zero-padded bytes to /streams/omi/audio, returns size_bytes", async () => {
    seedOmiStream();

    const r = await call("POST", "/api/v1/channels/omi/test");
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.size_bytes, 2048);

    assert.equal(
      audioEndpointCalls.length,
      1,
      "/streams/omi/audio must be hit exactly once",
    );
    const c = audioEndpointCalls[0];
    assert.equal(c.size, 2048, "payload must be 2KB");
    assert.match(c.contentType, /octet-stream/);
    assert.ok(
      c.url.includes(`token=${WEBHOOK_TOKEN}`),
      `URL must carry the webhook token, got ${c.url}`,
    );
    assert.ok(
      c.url.includes("uid=omi-device"),
      `URL must carry the omi-device uid, got ${c.url}`,
    );
  });

  it("POST /test → ok:false when /streams/omi/audio rejects the chunk", async () => {
    seedOmiStream();
    audioEndpointOk = false;

    const r = await call("POST", "/api/v1/channels/omi/test");
    assert.equal(r.status, 200);
    assert.equal(r.payload.ok, false);
    assert.match(r.payload.error, /invalid_token|rejected/);
  });

  it("GET /credentials/groq-api-key → 200 + { api_key } when item present", async () => {
    vaultStore = [
      {
        id: "v-groq",
        name: "Groq API Key (OMI transcription)",
        type: 1,
        login: { username: null, password: VALID_KEY, uris: [] },
      },
    ];

    const r = await call("GET", "/api/v1/credentials/groq-api-key");
    assert.equal(r.status, 200);
    assert.equal(r.payload.api_key, VALID_KEY);
  });

  it("GET /credentials/groq-api-key → 404 when item absent", async () => {
    const r = await call("GET", "/api/v1/credentials/groq-api-key");
    assert.equal(r.status, 404);
    // Match either the ApiError envelope or the bare payload, since the
    // server.ts handler wraps thrown NotFoundError in { error: { ... } }.
    const errMsg =
      r.payload?.error?.message ??
      r.payload?.error ??
      JSON.stringify(r.payload);
    assert.match(errMsg, /not configured/i);
  });
});

process.on("exit", () => {
  globalThis.fetch = originalFetch;
});
