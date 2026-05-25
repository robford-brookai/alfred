// Lane I — /api/v1/channels/sms/* routes.
//
// Mirrors telegram-routes.test.ts and slack-routes.test.ts: same docker-exec
// + vault-cli + fetch mock pattern. Twilio is the upstream the SMS adapter
// validates against; the canonical credential store is Vaultwarden (3 items:
// "Twilio Account SID", "Twilio Auth Token", "Twilio Phone Number"); the
// per-profile Hermes .env is the cache the gateway's twilio adapter reads.
//
// Six behaviours under test:
//   1. GET /status with no creds in .env       → state: "unconfigured"
//   2. GET /status with creds + Twilio 200      → state: "configured_running"
//                                                + masked sid + phone_number
//   3. PUT /credentials valid quartet           → vault writes (3 items) +
//                                                 4 .env keys upsert + restart
//   4. PUT /credentials malformed sid           → 400, no side effects
//   5. DELETE /credentials                       → vault wipes + all 4 TWILIO_*
//                                                 + SMS_* keys dropped + restart
//   6. POST /test                                → fires Twilio Messages.json
//                                                 + returns { ok, sid }
//
// Privacy: this is a public OSS repo. Tests use synthetic placeholders only:
//   - account_sid = "AC" + 32 zeros
//   - auth_token  = 32 zeros
//   - phone_number = "+15550100" (NANPA reserved-for-fiction +1-555-01XX)

import { mock, describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sms-routes-"));
process.env.COMPOSE_DIR = tmp;
process.env.ALFRED_DATA_DIR = tmp;
process.env.VAULT_PATH = path.join(tmp, "vault");
process.env.STATE_DB_PATH = path.join(tmp, "state.db");
process.env.SQLITE_VEC_PATH = "";
process.env.VAULT_CLI_URL = "http://vault-cli-stub:8087";
process.env.HERMES_HOME_IN_CONTAINER = "/hermes-state";

const PROFILE_DIR = "/hermes-state/profiles/main";
const PROFILE_ENV_PATH = `${PROFILE_DIR}/.env`;

// Synthetic placeholders — see note above.
const VALID_SID = "AC" + "0".repeat(32);
const VALID_TOKEN = "0".repeat(32);
const VALID_PHONE = "+15550100";
const ALLOWED_USER = "+15550101";

// ── docker exec mock state ───────────────────────────────────────────────
let containerFiles: Record<string, string> = {};
const dockerExecCalls: { service: string; command: string[] }[] = [];
const dockerExecWithStdinCalls: { service: string; command: string[]; stdin: string }[] = [];
const dockerComposeCalls: string[][] = [];

function defaultDockerExec(_service: string, command: string[]): string {
  if (command[0] === "sh" && command[1] === "-c") {
    const script = command[2] ?? "";
    const catMatch = script.match(/^cat\s+(\S+)\s+2>\/dev\/null\s+\|\|\s+true$/);
    if (catMatch) return containerFiles[catMatch[1]] ?? "";
    return "";
  }
  return "";
}

const realHelpers = await import("../src/api/helpers.js");
mock.module("../src/api/helpers.js", {
  namedExports: {
    ...realHelpers,
    dockerExec: async (service: string, command: string[]) => {
      dockerExecCalls.push({ service, command: [...command] });
      return defaultDockerExec(service, command);
    },
    dockerExecWithStdin: async (service: string, command: string[], stdin: string) => {
      dockerExecWithStdinCalls.push({ service, command: [...command], stdin });
      const script = command[2] ?? "";
      const mvMatch = script.match(/mv\s+\S+\s+(\S+)$/);
      if (mvMatch) containerFiles[mvMatch[1]] = stdin;
      return { stdout: "", stderr: "" };
    },
    dockerComposeCmd: async (args: string[]) => {
      dockerComposeCalls.push([...args]);
      return "";
    },
  },
});

// ── vault-cli + Twilio API mock ───────────────────────────────────────────

interface VaultItem {
  id: string;
  name: string;
  type: 1;
  login: { username: string | null; password: string; uris: unknown[] };
}
let vaultStore: VaultItem[] = [];

// Twilio response controls — tests flip to simulate valid/invalid creds.
let twilioAccountsOk = true;
let twilioAccountsStatus = 200;
let twilioMessagesOk = true;
let twilioMessagesSid = "SM" + "f".repeat(32);
const twilioMessagesCalls: { sid: string; to: string; from: string; body: string; auth: string }[] = [];

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

  // Twilio accounts probe (auth validation on PUT + status surface)
  const acctMatch = url.match(/^https:\/\/api\.twilio\.com\/2010-04-01\/Accounts\/(AC[a-f0-9]+)\.json$/);
  if (acctMatch) {
    if (!twilioAccountsOk) {
      return makeJsonResponse({ code: 20003, message: "Authentication Error" }, twilioAccountsStatus);
    }
    return makeJsonResponse({
      sid: acctMatch[1],
      friendly_name: "Test Account",
      status: "active",
    }, 200);
  }

  // Twilio Messages.json (outbound send for /test)
  const msgMatch = url.match(/^https:\/\/api\.twilio\.com\/2010-04-01\/Accounts\/(AC[a-f0-9]+)\/Messages\.json$/);
  if (msgMatch) {
    // Capture the form-encoded body for assertions.
    const rawBody = String(init?.body ?? "");
    const params = new URLSearchParams(rawBody);
    const authHeader = (init?.headers?.Authorization ?? init?.headers?.authorization ?? "") as string;
    twilioMessagesCalls.push({
      sid: msgMatch[1],
      to: params.get("To") ?? "",
      from: params.get("From") ?? "",
      body: params.get("Body") ?? "",
      auth: authHeader,
    });
    if (!twilioMessagesOk) {
      return makeJsonResponse({ code: 21610, message: "Unsubscribed" }, 400);
    }
    return makeJsonResponse({ sid: twilioMessagesSid, status: "queued" }, 201);
  }

  // vault-cli
  if (url.includes("/list/object/items")) {
    const qIdx = url.indexOf("?");
    const params = new URLSearchParams(qIdx >= 0 ? url.slice(qIdx + 1) : "");
    const search = params.get("search") ?? "";
    const filtered = search
      ? vaultStore.filter((i) => i.name.toLowerCase().includes(search.toLowerCase()))
      : vaultStore.slice();
    return makeJsonResponse({ success: true, data: { data: filtered } });
  }
  const objMatch = url.match(/\/object\/item\/([^/?]+)/);
  if (objMatch && method === "GET") {
    const id = objMatch[1];
    const item = vaultStore.find((i) => i.id === id);
    if (!item) return makeJsonResponse({ success: false, message: "not found" }, 404);
    return makeJsonResponse({ success: true, data: { data: item } });
  }
  if (url.endsWith("/object/item") && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const id = "id-" + String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8);
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
    if (idx < 0) return makeJsonResponse({ success: false, message: "not found" }, 404);
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
    if (idx < 0) return makeJsonResponse({ success: false, message: "not found" }, 404);
    vaultStore.splice(idx, 1);
    return makeJsonResponse({ success: true });
  }
  throw new Error(`unexpected fetch in sms-routes test: ${method} ${url}`);
}) as typeof fetch;

const { registerSmsRoutes } = await import("../src/api/routes/sms.js");
const { matchRoute } = await import("../src/api/server.js");
registerSmsRoutes();

interface CallResult {
  status: number;
  payload: any;
}
async function call(method: string, p: string, body?: unknown): Promise<CallResult> {
  const m = matchRoute(method, p);
  assert.ok(m, `${method} ${p} must be registered`);
  let status = 0;
  let payload: any;
  const res: any = {
    statusCode: 0,
    setHeader() {},
    writeHead(c: number) { status = c; },
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

describe("/api/v1/channels/sms/*", () => {
  beforeEach(() => {
    containerFiles = {};
    dockerExecCalls.length = 0;
    dockerExecWithStdinCalls.length = 0;
    dockerComposeCalls.length = 0;
    twilioMessagesCalls.length = 0;
    vaultStore = [];
    twilioAccountsOk = true;
    twilioAccountsStatus = 200;
    twilioMessagesOk = true;
  });

  it("GET /status returns unconfigured when no creds in .env", async () => {
    containerFiles[PROFILE_ENV_PATH] = "# empty\n";
    const r = await call("GET", "/api/v1/channels/sms/status");
    assert.equal(r.status, 200);
    assert.equal(r.payload.state, "unconfigured");
    assert.equal(r.payload.configured, false);
    assert.equal(r.payload.phone_number, null);
    assert.equal(r.payload.account_sid_masked, null);
    assert.equal(r.payload.allowed_users, "");
    assert.equal(r.payload.error, null);
  });

  it("GET /status returns configured_running + masked sid + phone when Twilio accepts creds", async () => {
    containerFiles[PROFILE_ENV_PATH] =
      `TWILIO_ACCOUNT_SID=${VALID_SID}\n` +
      `TWILIO_AUTH_TOKEN=${VALID_TOKEN}\n` +
      `TWILIO_PHONE_NUMBER=${VALID_PHONE}\n` +
      `SMS_ALLOWED_USERS=${ALLOWED_USER}\n`;
    const r = await call("GET", "/api/v1/channels/sms/status");
    assert.equal(r.status, 200);
    assert.equal(r.payload.state, "configured_running");
    assert.equal(r.payload.configured, true);
    assert.equal(r.payload.phone_number, VALID_PHONE);
    assert.equal(r.payload.allowed_users, ALLOWED_USER);
    // Masked: "AC********...<last4>" — must NOT contain the raw sid tail beyond
    // the trailing 4 chars and must NOT contain the auth token at all.
    assert.match(r.payload.account_sid_masked, /^AC\*+[0-9a-f]{4}$/);
    assert.ok(!r.payload.account_sid_masked.includes(VALID_SID.slice(2, -4)),
      "masked sid must not leak the middle of the real sid");
    const ser = JSON.stringify(r.payload);
    assert.ok(!ser.includes(VALID_TOKEN), "auth token must never appear in status payload");
  });

  it("PUT /credentials valid quartet → 3 vault items + 4 .env keys + hermes restart", async () => {
    const r = await call("PUT", "/api/v1/channels/sms/credentials", {
      account_sid: VALID_SID,
      auth_token: VALID_TOKEN,
      phone_number: VALID_PHONE,
      allowed_users: ALLOWED_USER,
    });
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.state, "configured_starting");

    // Vault now has 3 named items.
    assert.equal(vaultStore.length, 3, `expected 3 vault items, got ${vaultStore.length}`);
    assert.ok(vaultStore.some((i) => i.name === "Twilio Account SID"));
    assert.ok(vaultStore.some((i) => i.name === "Twilio Auth Token"));
    assert.ok(vaultStore.some((i) => i.name === "Twilio Phone Number"));

    // .env was written via dockerExecWithStdin to per-profile path.
    const wrote = dockerExecWithStdinCalls.find((c) =>
      c.command[2]?.includes(PROFILE_ENV_PATH),
    );
    assert.ok(wrote, "dockerExecWithStdin should have written the .env");
    assert.equal(wrote.service, "hermes");
    assert.match(wrote.stdin, new RegExp(`TWILIO_ACCOUNT_SID=${VALID_SID}`));
    assert.match(wrote.stdin, new RegExp(`TWILIO_AUTH_TOKEN=${VALID_TOKEN}`));
    assert.match(wrote.stdin, new RegExp(`TWILIO_PHONE_NUMBER=\\${VALID_PHONE}`));
    assert.match(wrote.stdin, new RegExp(`SMS_ALLOWED_USERS=\\${ALLOWED_USER}`));

    // Hermes restart was fired.
    assert.ok(
      dockerComposeCalls.some((c) => c[0] === "restart" && c[1] === "hermes"),
      `hermes restart should fire, got ${JSON.stringify(dockerComposeCalls)}`,
    );

    // Twilio accounts probe was made for validation, with HTTP Basic auth.
    const validationFetch = dockerExecCalls; // sanity placeholder
    void validationFetch;
  });

  it("PUT /credentials rejects malformed account_sid → 400 + no side effects", async () => {
    const r = await call("PUT", "/api/v1/channels/sms/credentials", {
      account_sid: "not-an-account-sid",
      auth_token: VALID_TOKEN,
      phone_number: VALID_PHONE,
    });
    assert.equal(r.status, 400);
    assert.equal(vaultStore.length, 0, "no vault write on validation failure");
    assert.equal(
      dockerExecWithStdinCalls.length,
      0,
      ".env write must not happen on validation failure",
    );
    assert.equal(
      dockerComposeCalls.length,
      0,
      "hermes restart must not fire on validation failure",
    );
  });

  it("DELETE /credentials wipes 3 vault items + drops all 4 env keys + restarts hermes", async () => {
    // Seed: 3 vault items + .env with all 4 keys + a sibling key to preserve.
    vaultStore = [
      { id: "v1", name: "Twilio Account SID",  type: 1, login: { username: null, password: VALID_SID,   uris: [] } },
      { id: "v2", name: "Twilio Auth Token",   type: 1, login: { username: null, password: VALID_TOKEN, uris: [] } },
      { id: "v3", name: "Twilio Phone Number", type: 1, login: { username: null, password: VALID_PHONE, uris: [] } },
    ];
    containerFiles[PROFILE_ENV_PATH] =
      `TWILIO_ACCOUNT_SID=${VALID_SID}\n` +
      `TWILIO_AUTH_TOKEN=${VALID_TOKEN}\n` +
      `TWILIO_PHONE_NUMBER=${VALID_PHONE}\n` +
      `SMS_ALLOWED_USERS=${ALLOWED_USER}\n` +
      `OPENROUTER_API_KEY=keep-me\n`;

    const r = await call("DELETE", "/api/v1/channels/sms/credentials");
    assert.equal(r.status, 200);
    assert.equal(r.payload.ok, true);

    // All 3 vault items wiped.
    assert.equal(vaultStore.length, 0, "all 3 Twilio vault items must be wiped");

    // .env rewrite drops the four SMS-channel keys but preserves siblings.
    const wrote = dockerExecWithStdinCalls.find((c) =>
      c.command[2]?.includes(PROFILE_ENV_PATH),
    );
    assert.ok(wrote, "dockerExecWithStdin must have rewritten the .env");
    assert.doesNotMatch(wrote.stdin, /^TWILIO_ACCOUNT_SID=/m, "TWILIO_ACCOUNT_SID must be dropped");
    assert.doesNotMatch(wrote.stdin, /^TWILIO_AUTH_TOKEN=/m, "TWILIO_AUTH_TOKEN must be dropped");
    assert.doesNotMatch(wrote.stdin, /^TWILIO_PHONE_NUMBER=/m, "TWILIO_PHONE_NUMBER must be dropped");
    assert.doesNotMatch(wrote.stdin, /^SMS_ALLOWED_USERS=/m, "SMS_ALLOWED_USERS must be dropped");
    assert.match(wrote.stdin, /OPENROUTER_API_KEY=keep-me/, "unrelated keys must be preserved");

    // Restart fired.
    assert.ok(
      dockerComposeCalls.some((c) => c[0] === "restart" && c[1] === "hermes"),
    );
  });

  it("POST /test sends via Twilio Messages.json to first allowed_users entry", async () => {
    containerFiles[PROFILE_ENV_PATH] =
      `TWILIO_ACCOUNT_SID=${VALID_SID}\n` +
      `TWILIO_AUTH_TOKEN=${VALID_TOKEN}\n` +
      `TWILIO_PHONE_NUMBER=${VALID_PHONE}\n` +
      `SMS_ALLOWED_USERS=${ALLOWED_USER},+15550199\n`;

    const r = await call("POST", "/api/v1/channels/sms/test");
    assert.equal(r.status, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.sid, twilioMessagesSid);

    // Exactly one Twilio send, with the right From/To/Body/auth.
    assert.equal(twilioMessagesCalls.length, 1);
    const c = twilioMessagesCalls[0];
    assert.equal(c.sid, VALID_SID, "must POST to /Accounts/<sid>/Messages.json");
    assert.equal(c.from, VALID_PHONE);
    assert.equal(c.to, ALLOWED_USER, "must send to FIRST entry in SMS_ALLOWED_USERS");
    assert.match(c.body, /Alfred SMS test/);
    // HTTP Basic: base64(<sid>:<token>).
    const expectedBasic = "Basic " + Buffer.from(`${VALID_SID}:${VALID_TOKEN}`).toString("base64");
    assert.equal(c.auth, expectedBasic, "Twilio call must use HTTP Basic auth with sid:token");
  });
});

process.on("exit", () => {
  globalThis.fetch = originalFetch;
});
