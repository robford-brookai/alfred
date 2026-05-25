// Phase 4.1 — ctrl-api auth.ts accepts a SCOPED voice-bridge bearer, but
// ONLY for an explicit 2-route allowlist. Any other route requested with
// that token rejects with 401 — same outcome as if no token were sent.
//
// What this pins:
//
//   1. The master AAS_API_KEY accepts every route (unchanged).
//   2. The voice-bridge token accepts GET /api/v1/phone/voice-context.
//   3. The voice-bridge token accepts POST /api/v1/phone/transcript.
//   4. The voice-bridge token REJECTS every other /api/v1/* route — vault
//      read, journal recall, settings, anything.
//   5. A wrong token (neither master nor voice-bridge) rejects.
//   6. A path that LOOKS LIKE one of the allowlisted routes but isn't an
//      exact match (e.g. trailing /raw) is also rejected with the
//      voice-bridge token — exact matching, no prefix inheritance.
//   7. Wrong method on an allowlisted path also rejects (POST on
//      /voice-context, GET on /transcript).
//
// Why this matters: voice-bridge is a network-edge service that talks to
// Twilio (mulaw parser) and OpenAI Realtime (WebSocket). If it's ever
// compromised the blast radius MUST be bounded to those 2 routes.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";

import {
  setApiKey,
  setVoiceBridgeKey,
  authenticate,
  _resetAuthForTests,
} from "../src/api/auth.js";
import { AuthError } from "../src/api/errors.js";

const MASTER_KEY = "test-master-" + "x".repeat(40);
const VOICE_KEY = "test-voice-" + "y".repeat(40);

function fakeReq(token: string | undefined): IncomingMessage {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as unknown as IncomingMessage;
}

beforeEach(() => {
  _resetAuthForTests();
  setApiKey(MASTER_KEY);
  setVoiceBridgeKey(VOICE_KEY);
});

// ----------------------------------------------------------------------- master

test("master key accepts every route (vault, journal, voice-context, settings)", () => {
  for (const route of [
    { method: "GET", pathname: "/api/v1/vault/context" },
    { method: "POST", pathname: "/api/v1/alfred-journal" },
    { method: "GET", pathname: "/api/v1/phone/voice-context" },
    { method: "POST", pathname: "/api/v1/phone/transcript" },
    { method: "GET", pathname: "/api/v1/settings" },
    { method: "DELETE", pathname: "/api/v1/channels/sms/credentials" },
  ]) {
    assert.doesNotThrow(
      () => authenticate(fakeReq(MASTER_KEY), route),
      `master key must accept ${route.method} ${route.pathname}`,
    );
  }
});

// ------------------------------------------------------------------ voice-bridge accept

test("voice-bridge token accepts GET /api/v1/phone/voice-context", () => {
  assert.doesNotThrow(() =>
    authenticate(fakeReq(VOICE_KEY), {
      method: "GET",
      pathname: "/api/v1/phone/voice-context",
    }),
  );
});

test("voice-bridge token accepts POST /api/v1/phone/transcript", () => {
  assert.doesNotThrow(() =>
    authenticate(fakeReq(VOICE_KEY), {
      method: "POST",
      pathname: "/api/v1/phone/transcript",
    }),
  );
});

// ------------------------------------------------------------------ voice-bridge reject

test("voice-bridge token REJECTS vault context (master-only territory)", () => {
  assert.throws(
    () =>
      authenticate(fakeReq(VOICE_KEY), {
        method: "GET",
        pathname: "/api/v1/vault/context",
      }),
    AuthError,
  );
});

test("voice-bridge token REJECTS alfred-journal recall (cross-channel memory)", () => {
  assert.throws(
    () =>
      authenticate(fakeReq(VOICE_KEY), {
        method: "GET",
        pathname: "/api/v1/alfred-journal/recent",
      }),
    AuthError,
  );
});

test("voice-bridge token REJECTS settings mutation", () => {
  assert.throws(
    () =>
      authenticate(fakeReq(VOICE_KEY), {
        method: "PUT",
        pathname: "/api/v1/settings/state-mutator-mode",
      }),
    AuthError,
  );
});

test("voice-bridge token REJECTS sibling channel ops (SMS credentials)", () => {
  assert.throws(
    () =>
      authenticate(fakeReq(VOICE_KEY), {
        method: "DELETE",
        pathname: "/api/v1/channels/sms/credentials",
      }),
    AuthError,
  );
});

// ---------------------------------------------------------------- exact-match pins

test("voice-bridge token REJECTS a path that PREFIX-matches voice-context", () => {
  // Anti-regression: if someone introduces /voice-context/raw or similar,
  // the scoped token must NOT inherit privilege.
  assert.throws(
    () =>
      authenticate(fakeReq(VOICE_KEY), {
        method: "GET",
        pathname: "/api/v1/phone/voice-context/raw",
      }),
    AuthError,
  );
  assert.throws(
    () =>
      authenticate(fakeReq(VOICE_KEY), {
        method: "GET",
        pathname: "/api/v1/phone/voice-context-extended",
      }),
    AuthError,
  );
});

test("voice-bridge token REJECTS wrong-method on allowlisted path", () => {
  // POST /voice-context, GET /transcript — wrong verb, must reject.
  assert.throws(
    () =>
      authenticate(fakeReq(VOICE_KEY), {
        method: "POST",
        pathname: "/api/v1/phone/voice-context",
      }),
    AuthError,
  );
  assert.throws(
    () =>
      authenticate(fakeReq(VOICE_KEY), {
        method: "GET",
        pathname: "/api/v1/phone/transcript",
      }),
    AuthError,
  );
});

// ---------------------------------------------------------------- bad-token paths

test("no Bearer header rejects (with master key configured)", () => {
  assert.throws(
    () =>
      authenticate(fakeReq(undefined), {
        method: "GET",
        pathname: "/api/v1/health",
      }),
    AuthError,
  );
});

test("wrong token rejects on every route", () => {
  for (const route of [
    { method: "GET", pathname: "/api/v1/phone/voice-context" },
    { method: "GET", pathname: "/api/v1/vault/context" },
  ]) {
    assert.throws(
      () => authenticate(fakeReq("definitely-not-a-real-token"), route),
      AuthError,
    );
  }
});

test("voice-bridge key may be disabled (set to empty string)", () => {
  setVoiceBridgeKey("");
  // Now the scoped token should be rejected EVERYWHERE.
  assert.throws(
    () =>
      authenticate(fakeReq(VOICE_KEY), {
        method: "GET",
        pathname: "/api/v1/phone/voice-context",
      }),
    AuthError,
  );
  // Master still works.
  assert.doesNotThrow(() =>
    authenticate(fakeReq(MASTER_KEY), {
      method: "GET",
      pathname: "/api/v1/phone/voice-context",
    }),
  );
});

test("when no master key is configured, authenticate is open (dev mode)", () => {
  _resetAuthForTests();
  // No setApiKey call — both keys null.
  assert.doesNotThrow(() =>
    authenticate(fakeReq(undefined), {
      method: "GET",
      pathname: "/api/v1/anything",
    }),
  );
});
