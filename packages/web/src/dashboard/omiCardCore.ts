// omiCardCore — pure shape derivation for the /channels OMI card.
// Mirrors smsCardCore.ts / slackCardCore.ts; import-free (no React/Wasp)
// so the four derived states unit-test under node:test.
//
// Phase 6b (OMI channel card, 2026-05-25): the OMI device already pairs
// at /connections (writes a webhook into ctrl-api). This card surfaces
// the *transcription* side — was the webhook created, is a Groq Whisper
// key on file, and is audio flowing? — backed by Lane I's ctrl-api
// endpoints under /api/v1/channels/omi/*.
//
// The four states map 1:1 to the `state` field on
// GET /api/v1/channels/omi/status:
//
//   • unconfigured    — no webhook yet (operator hasn't paired their
//                       device at /connections).
//   • needs_groq_key  — webhook exists but no Groq key is on file. The
//                       UI reveals a single password-style paste box.
//   • configured      — both webhook + Groq key present; alfred-learn
//                       can transcribe.
//   • error           — transient: Vaultwarden / Groq round-trip failed.
//                       The verbatim error string is shown.

export type OmiState =
  | "unconfigured"
  | "needs_groq_key"
  | "configured"
  | "error";

export interface OmiStatus {
  configured: boolean;
  state: OmiState;
  error: string | null;
  /** OMI webhook URL, created at pairing time. Null until paired. */
  webhook_url: string | null;
  /** True when a Groq API key is on file in Vaultwarden. */
  groq_key_present: boolean;
  /** How many transcripts landed in the last 24h. Drives liveness. */
  recent_transcripts_24h: number;
  /** ISO-8601 of the most recent audio chunk. Null when none yet. */
  last_audio_at: string | null;
}

export interface OmiCardState {
  state: OmiState;
  heading: string;
  description: string;
  /** Pretty status pill. */
  pill: "active" | "available" | "error";
  /** True iff the needs_groq_key paste box should render. */
  showPasteBox: boolean;
  /** True iff the webhook URL + Test/Disconnect controls should render. */
  showWebhookBlock: boolean;
  /** Webhook URL surfaced to the React layer (configured state). */
  webhookUrl: string | null;
}

const NULL_STATUS: OmiStatus = {
  configured: false,
  state: "unconfigured",
  error: null,
  webhook_url: null,
  groq_key_present: false,
  recent_transcripts_24h: 0,
  last_audio_at: null,
};

export function deriveOmiCardState(args: {
  status: OmiStatus | null | undefined;
}): OmiCardState {
  const status = args.status ?? NULL_STATUS;

  switch (status.state) {
    case "needs_groq_key":
      return {
        state: "needs_groq_key",
        heading: "Add Groq transcription key",
        description:
          "Paste your Groq API key below. Voice picked up by OMI gets " +
          "transcribed via Groq's Whisper and joins Alfred's cross-channel " +
          "memory.",
        pill: "available",
        showPasteBox: true,
        showWebhookBlock: false,
        webhookUrl: status.webhook_url,
      };

    case "configured": {
      // "OMI is listening" — webhook target + last-audio liveness so the
      // operator can tell at a glance whether the pipeline is actually
      // flowing. The wording stays calm; we'd rather omit the "Last audio"
      // fragment than show "never".
      const webhook = status.webhook_url ?? "";
      const lastSeen = formatLastSeen(status.last_audio_at);
      const audioFragment = lastSeen ? ` Last audio: ${lastSeen}.` : "";
      const description =
        "Audio is being transcribed by Groq Whisper and feeding into your " +
        `journal. Webhook target: ${webhook}.${audioFragment}`;
      return {
        state: "configured",
        heading: "OMI is listening",
        description,
        pill: "active",
        showPasteBox: false,
        showWebhookBlock: true,
        webhookUrl: status.webhook_url,
      };
    }

    case "error":
      return {
        state: "error",
        heading: "OMI needs attention",
        description:
          status.error?.trim() ||
          "Couldn't reach Vaultwarden. Try again in a moment.",
        pill: "error",
        showPasteBox: false,
        showWebhookBlock: false,
        webhookUrl: status.webhook_url,
      };

    case "unconfigured":
    default:
      return {
        state: "unconfigured",
        heading: "Pair OMI first",
        description:
          "OMI's webhook URL is created when you pair your device on " +
          "/connections. Once paired, come back here to enable " +
          "transcription.",
        pill: "available",
        showPasteBox: false,
        showWebhookBlock: false,
        webhookUrl: null,
      };
  }
}

// Groq API key validator. Stays in sync with ctrl-api's Lane I validator;
// real Groq keys are `gsk_` + 20+ URL-safe alphanumerics. The minimum
// length keeps us from green-lighting obviously-truncated paste-fails.
const GROQ_KEY_RE = /^gsk_[A-Za-z0-9_-]{20,}$/;

export function isProbablyValidGroqKey(s: string): boolean {
  if (typeof s !== "string") return false;
  return GROQ_KEY_RE.test(s.trim());
}

/**
 * Relative-time helper for "Last audio: 4 minutes ago" copy on the
 * configured card. Mirrors the wording the Telegram/Slack cards use
 * elsewhere — we'd rather understate ("just now") than be precise to
 * the second.
 *
 * Rules:
 *   • < 60s        → "just now"
 *   • < 60m        → "N minute[s] ago"
 *   • < 24h        → "N hour[s] ago"
 *   • < 48h        → "yesterday"
 *   • otherwise    → "N days ago"
 *
 * Garbage input (non-string, empty, malformed) → empty string so callers
 * can `${lastSeen && ` Last audio: ${lastSeen}.`}` cheaply.
 *
 * `now` is overridable for deterministic unit tests.
 */
export function formatLastSeen(
  iso: string | null | undefined,
  now: Date = new Date(),
): string {
  if (typeof iso !== "string" || iso.length === 0) return "";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const deltaMs = Math.max(0, now.getTime() - then.getTime());
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}
