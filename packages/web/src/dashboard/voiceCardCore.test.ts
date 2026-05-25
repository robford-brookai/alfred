/**
 * /channels — Voice card derivation tests. Mirrors smsCardCore.test.ts.
 *
 * Voice is a read-only deploy-readiness card: there's no operator-facing
 * configuration because voice reuses the Twilio credentials configured by
 * the SMS section above. The four states map 1:1 to ctrl-api's
 * GET /api/v1/channels/voice/status `state` field (Lane I).
 *
 * Covers:
 *   • the four visual states (unconfigured / starting / running / error)
 *   • the needsSmsFirst branching inside `unconfigured`
 *     (compose_service_exists=true → "set up SMS first" copy;
 *      compose_service_exists=false → "voice not deployed" copy)
 *   • formatted phone number on the running state
 *   • null-status defaults to unconfigured
 *
 * Phone numbers in fixtures use the NANPA reserved-for-fiction block
 * (+1-555-01XX) so this file is safe in a public OSS repo.
 *
 * Run with:
 *   cd packages/web && npx tsx --test src/dashboard/voiceCardCore.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveVoiceCardState,
  formatPhoneNumber,
  type VoiceStatus,
} from "./voiceCardCore";

const BASE: VoiceStatus = {
  configured: false,
  state: "unconfigured",
  error: null,
  calling_number: null,
  compose_service_exists: false,
};

test("derive: unconfigured + compose missing → 'Voice not deployed' card", () => {
  const s = deriveVoiceCardState({ status: BASE });
  assert.equal(s.state, "unconfigured");
  assert.equal(s.pill, "available");
  assert.equal(s.needsSmsFirst, false);
  assert.match(s.heading, /not deployed/i);
  assert.match(s.description, /docker compose up/i);
  assert.equal(s.callingNumber, null);
});

test("derive: unconfigured + compose present → 'Set up SMS first' card", () => {
  const s = deriveVoiceCardState({
    status: { ...BASE, compose_service_exists: true },
  });
  assert.equal(s.state, "unconfigured");
  assert.equal(s.pill, "available");
  assert.equal(s.needsSmsFirst, true);
  assert.match(s.heading, /SMS first/i);
  assert.match(s.description, /reuse.*Twilio/i);
});

test("derive: configured_starting → spinner copy + starting pill", () => {
  const s = deriveVoiceCardState({
    status: {
      ...BASE,
      configured: true,
      state: "configured_starting",
      compose_service_exists: true,
    },
  });
  assert.equal(s.state, "configured_starting");
  assert.equal(s.pill, "starting");
  assert.equal(s.needsSmsFirst, false);
  assert.match(s.heading, /picking up/i);
  assert.match(s.description, /restarting/i);
});

test("derive: configured_running → active pill + formatted calling number", () => {
  const s = deriveVoiceCardState({
    status: {
      ...BASE,
      configured: true,
      state: "configured_running",
      calling_number: "+15550100",
      compose_service_exists: true,
    },
  });
  assert.equal(s.state, "configured_running");
  assert.equal(s.pill, "active");
  assert.equal(s.needsSmsFirst, false);
  assert.equal(s.callingNumber, "+1 555 0100");
  assert.match(s.heading, /Voice calls active/i);
  assert.match(s.description, /gpt-realtime/);
});

test("derive: error with verbatim message → error pill + verbatim text", () => {
  const s = deriveVoiceCardState({
    status: {
      ...BASE,
      configured: true,
      state: "error",
      error: "voice-bridge exited 137",
      compose_service_exists: true,
    },
  });
  assert.equal(s.state, "error");
  assert.equal(s.pill, "error");
  assert.equal(s.description, "voice-bridge exited 137");
  assert.match(s.heading, /needs attention/i);
});

test("derive: error with empty error → fallback description", () => {
  const s = deriveVoiceCardState({
    status: {
      ...BASE,
      configured: true,
      state: "error",
      error: "",
      compose_service_exists: true,
    },
  });
  assert.equal(s.pill, "error");
  assert.match(s.description, /not healthy|container logs/i);
});

test("derive: error with null error → fallback description", () => {
  const s = deriveVoiceCardState({
    status: {
      ...BASE,
      configured: true,
      state: "error",
      error: null,
      compose_service_exists: true,
    },
  });
  assert.equal(s.pill, "error");
  assert.match(s.description, /not healthy|container logs/i);
});

test("derive: null status defaults to unconfigured + 'Voice not deployed'", () => {
  const s = deriveVoiceCardState({ status: null });
  assert.equal(s.state, "unconfigured");
  assert.equal(s.pill, "available");
  assert.equal(s.needsSmsFirst, false);
  assert.match(s.heading, /not deployed/i);
});

test("formatPhoneNumber: re-exported from smsCardCore (no duplication)", () => {
  // Sanity-check that the re-export is wired correctly. The full
  // formatter behaviour is exhaustively tested in smsCardCore.test.ts.
  assert.equal(formatPhoneNumber("+15550100"), "+1 555 0100");
  assert.equal(formatPhoneNumber(""), "");
  assert.equal(formatPhoneNumber(null), "");
});
