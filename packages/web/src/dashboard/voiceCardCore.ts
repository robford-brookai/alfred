// voiceCardCore — pure shape derivation for the /channels Voice card.
// Mirror of smsCardCore.ts; import-free (no React/Wasp) so the four
// derived states unit-test under node:test.
//
// Phase 2 (voice-bridge promotion, 2026-05-25): voice is a real compose
// service alongside the SMS adapter. The card is **read-only** because
// voice reuses the Twilio credentials configured by the SMS section
// above — the card's job is to surface deploy-readiness, not configure
// anything.
//
// The states map 1:1 to ctrl-api's GET /api/v1/channels/voice/status
// `state` field. Lane I owns the endpoint; this derivation is the only
// thing the UI needs to know about the state machine.

import { formatPhoneNumber } from "./smsCardCore";

// Re-export the NANP formatter so callers have one import surface for
// "anything voice-card-shaped". The implementation lives in
// smsCardCore — never duplicate it here.
export { formatPhoneNumber };

export type VoiceState =
  | "unconfigured"
  | "configured_starting"
  | "configured_running"
  | "error";

export interface VoiceStatus {
  configured: boolean;
  state: VoiceState;
  error: string | null;
  /** Twilio number the voice-bridge answers on, E.164. Null until configured. */
  calling_number: string | null;
  /** True when the voice-bridge compose service is present on this VM. */
  compose_service_exists: boolean;
}

export interface VoiceCardState {
  state: VoiceState;
  heading: string;
  description: string;
  callingNumber: string | null;
  pill: "active" | "available" | "starting" | "error";
  /** True when the operator needs to set up SMS first (voice reuses Twilio creds). */
  needsSmsFirst: boolean;
}

const NULL_STATUS: VoiceStatus = {
  configured: false,
  state: "unconfigured",
  error: null,
  calling_number: null,
  compose_service_exists: false,
};

export function deriveVoiceCardState(args: {
  status: VoiceStatus | null | undefined;
}): VoiceCardState {
  const status = args.status ?? NULL_STATUS;

  switch (status.state) {
    case "configured_starting":
      return {
        state: "configured_starting",
        heading: "Picking up the new credentials",
        description:
          "The voice bridge is restarting with the latest credentials. " +
          "This usually takes a few seconds.",
        callingNumber: status.calling_number,
        pill: "starting",
        needsSmsFirst: false,
      };

    case "configured_running":
      return {
        state: "configured_running",
        heading: "Voice calls active",
        description:
          "Calls to your Twilio number are bridged through gpt-realtime. " +
          "Alfred answers in the same butler voice he speaks in over text.",
        callingNumber: formatPhoneNumber(status.calling_number) || null,
        pill: "active",
        needsSmsFirst: false,
      };

    case "error":
      return {
        state: "error",
        heading: "Voice bridge needs attention",
        description:
          status.error?.trim() ||
          "The voice bridge service is not healthy. Check the container logs.",
        callingNumber: status.calling_number,
        pill: "error",
        needsSmsFirst: false,
      };

    case "unconfigured":
    default:
      // Two unconfigured shapes:
      //   • compose_service_exists=false → voice-bridge not deployed yet
      //   • compose_service_exists=true  → service present, waiting for
      //     SMS creds (voice reuses them; no extra UI to surface).
      if (status.compose_service_exists) {
        return {
          state: "unconfigured",
          heading: "Set up SMS first",
          description:
            "Voice calls reuse your Twilio phone number — finish the SMS " +
            "setup above and voice becomes available automatically.",
          callingNumber: null,
          pill: "available",
          needsSmsFirst: true,
        };
      }
      return {
        state: "unconfigured",
        heading: "Voice not deployed",
        description:
          "Voice calls are powered by a separate bridge service. It hasn't " +
          "been deployed to this VM yet — re-run `docker compose up -d`.",
        callingNumber: null,
        pill: "available",
        needsSmsFirst: false,
      };
  }
}
