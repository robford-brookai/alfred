/**
 * /channels — OMI card derivation tests. Mirrors smsCardCore.test.ts.
 *
 * Covers:
 *   • the four visual states (unconfigured / needs_groq_key /
 *     configured / error)
 *   • the paste-form gating flag (showPasteBox) on needs_groq_key
 *   • isProbablyValidGroqKey accept + reject
 *   • formatLastSeen edge cases (just-now / minutes / hours / yesterday / null)
 *   • null status → unconfigured default
 *
 * The Groq key fixtures use a deliberately-fake `gsk_TEST_…` prefix so this
 * file is safe to ship in a public OSS repo (Groq's real keys have the same
 * `gsk_` prefix; never put a live one here).
 *
 * Run with:
 *   cd packages/web && npx tsx --test src/dashboard/omiCardCore.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveOmiCardState,
  formatLastSeen,
  isProbablyValidGroqKey,
  type OmiStatus,
} from "./omiCardCore";

const BASE: OmiStatus = {
  configured: false,
  state: "unconfigured",
  error: null,
  webhook_url: null,
  groq_key_present: false,
  recent_transcripts_24h: 0,
  last_audio_at: null,
};

// ---------------------------------------------------------------------------
// Derivation — the four states
// ---------------------------------------------------------------------------

test("derive: unconfigured (no webhook yet) → pair-first copy + available pill", () => {
  const s = deriveOmiCardState({ status: BASE });
  assert.equal(s.state, "unconfigured");
  assert.equal(s.pill, "available");
  assert.equal(s.showPasteBox, false);
  assert.equal(s.showWebhookBlock, false);
  assert.match(s.heading, /Pair OMI first/);
  assert.match(s.description, /pair your device/i);
});

test("derive: needs_groq_key (webhook present, no key) → paste-form copy + available pill", () => {
  const s = deriveOmiCardState({
    status: {
      ...BASE,
      state: "needs_groq_key",
      webhook_url: "https://omi.example.com/webhook/abc123",
      groq_key_present: false,
    },
  });
  assert.equal(s.state, "needs_groq_key");
  assert.equal(s.pill, "available");
  assert.equal(s.showPasteBox, true, "paste form must show in needs_groq_key");
  assert.equal(s.showWebhookBlock, false);
  assert.match(s.heading, /Add Groq transcription key/);
  assert.match(s.description, /Groq.*Whisper/);
});

test("derive: configured → listening copy + active pill + webhook block", () => {
  const s = deriveOmiCardState({
    status: {
      ...BASE,
      configured: true,
      state: "configured",
      webhook_url: "https://omi.example.com/webhook/abc123",
      groq_key_present: true,
      recent_transcripts_24h: 12,
      last_audio_at: new Date(Date.now() - 4 * 60_000).toISOString(),
    },
  });
  assert.equal(s.state, "configured");
  assert.equal(s.pill, "active");
  assert.equal(s.showPasteBox, false);
  assert.equal(s.showWebhookBlock, true);
  assert.equal(s.webhookUrl, "https://omi.example.com/webhook/abc123");
  assert.match(s.heading, /OMI is listening/);
  // The description interpolates the webhook URL + "last audio" liveness.
  assert.match(s.description, /omi\.example\.com\/webhook\/abc123/);
  assert.match(s.description, /4 minutes ago|just now/);
});

test("derive: configured but no recent audio → description omits 'last audio'", () => {
  const s = deriveOmiCardState({
    status: {
      ...BASE,
      configured: true,
      state: "configured",
      webhook_url: "https://omi.example.com/webhook/abc123",
      groq_key_present: true,
      recent_transcripts_24h: 0,
      last_audio_at: null,
    },
  });
  assert.equal(s.state, "configured");
  // Webhook still shown, but no "Last audio: …" fragment.
  assert.match(s.description, /omi\.example\.com\/webhook\/abc123/);
  assert.doesNotMatch(s.description, /Last audio/);
});

test("derive: error → verbatim message + error pill", () => {
  const s = deriveOmiCardState({
    status: {
      ...BASE,
      state: "error",
      error: "Groq rejected the key (401).",
    },
  });
  assert.equal(s.state, "error");
  assert.equal(s.pill, "error");
  assert.equal(s.description, "Groq rejected the key (401).");
  assert.match(s.heading, /OMI needs attention/);
});

test("derive: error with empty error → falls back to vaultwarden default copy", () => {
  const s = deriveOmiCardState({
    status: { ...BASE, state: "error", error: "" },
  });
  assert.equal(s.pill, "error");
  assert.match(s.description, /Vaultwarden/);
});

test("derive: null status → unconfigured default", () => {
  const s = deriveOmiCardState({ status: null });
  assert.equal(s.state, "unconfigured");
  assert.equal(s.pill, "available");
  assert.equal(s.showPasteBox, false);
});

// ---------------------------------------------------------------------------
// isProbablyValidGroqKey — `^gsk_[A-Za-z0-9_-]{20,}$`
// ---------------------------------------------------------------------------

test("isProbablyValidGroqKey: gsk_<20+ url-safe chars> accepts, everything else rejects", () => {
  // Synthetic fixture — `gsk_TEST_…` is deliberately fake.
  assert.equal(isProbablyValidGroqKey("gsk_TEST_abcdef0123456789ABCD"), true);
  assert.equal(
    isProbablyValidGroqKey("  gsk_TEST_abcdef0123456789ABCD  "),
    true,
    "whitespace stripped before validation",
  );
  assert.equal(
    isProbablyValidGroqKey("gsk_TEST_abc-def_ghi-jkl_mnopqr"),
    true,
    "underscores and hyphens permitted",
  );
  // Too short — needs >= 20 chars after the gsk_ prefix.
  assert.equal(isProbablyValidGroqKey("gsk_short"), false);
  assert.equal(isProbablyValidGroqKey("gsk_" + "a".repeat(19)), false);
  assert.equal(isProbablyValidGroqKey("gsk_" + "a".repeat(20)), true);
  // Wrong prefix.
  assert.equal(isProbablyValidGroqKey("sk-" + "a".repeat(40)), false);
  assert.equal(isProbablyValidGroqKey("xoxb-" + "a".repeat(40)), false);
  // Illegal characters (Groq keys are URL-safe alphanumerics).
  assert.equal(isProbablyValidGroqKey("gsk_TEST_abcdef0123456789ABC!"), false);
  assert.equal(isProbablyValidGroqKey("gsk_TEST_abc def0123456789ABCD"), false);
  // Pathological cases.
  assert.equal(isProbablyValidGroqKey(""), false);
  assert.equal(isProbablyValidGroqKey(null as any), false);
  assert.equal(isProbablyValidGroqKey(123 as any), false);
});

// ---------------------------------------------------------------------------
// formatLastSeen — relative-time helper
// ---------------------------------------------------------------------------

test("formatLastSeen: null / undefined / empty → empty string", () => {
  assert.equal(formatLastSeen(null), "");
  assert.equal(formatLastSeen(undefined), "");
  assert.equal(formatLastSeen(""), "");
});

test("formatLastSeen: < 60s → 'just now'", () => {
  const now = new Date();
  const t = new Date(now.getTime() - 10_000).toISOString();
  assert.equal(formatLastSeen(t, now), "just now");
});

test("formatLastSeen: minutes / hours / yesterday / older", () => {
  const now = new Date("2026-05-25T12:00:00Z");
  // 4 minutes ago
  assert.equal(
    formatLastSeen(new Date(now.getTime() - 4 * 60_000).toISOString(), now),
    "4 minutes ago",
  );
  // 1 minute (singular)
  assert.equal(
    formatLastSeen(new Date(now.getTime() - 60_000).toISOString(), now),
    "1 minute ago",
  );
  // 3 hours ago
  assert.equal(
    formatLastSeen(new Date(now.getTime() - 3 * 3600_000).toISOString(), now),
    "3 hours ago",
  );
  // 1 hour (singular)
  assert.equal(
    formatLastSeen(new Date(now.getTime() - 3600_000).toISOString(), now),
    "1 hour ago",
  );
  // ~26h ago → "yesterday"
  assert.equal(
    formatLastSeen(new Date(now.getTime() - 26 * 3600_000).toISOString(), now),
    "yesterday",
  );
  // 5 days ago → "5 days ago"
  assert.equal(
    formatLastSeen(
      new Date(now.getTime() - 5 * 24 * 3600_000).toISOString(),
      now,
    ),
    "5 days ago",
  );
});

test("formatLastSeen: garbage input → empty string", () => {
  assert.equal(formatLastSeen("not-an-iso"), "");
  assert.equal(formatLastSeen("2026-13-99T99:99:99Z"), "");
});
