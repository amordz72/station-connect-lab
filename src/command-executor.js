import {
  HiLinkUssdSession,
  readHiLinkSmsInbox,
  releaseHiLinkUssdSession,
} from "./hilink-ussd.js";
import { executeWindowsServiceCode } from "./windows-service-code.js";

function text(value) {
  return String(value ?? "").trim();
}

function technicalFailure(error) {
  const executionStarted = error?.details?.executionStarted === true;
  return {
    status: executionStarted ? "review" : "failed",
    raw_response: null,
    error_code: error?.details?.hilinkCode
      ? `HILINK_${String(error.details.hilinkCode).slice(0, 32)}`
      : error instanceof Error ? error.name : "AGENT_ERROR",
    error_message: error instanceof Error
      ? [error.message, error?.details?.hilinkCode ? `HiLink code: ${error.details.hilinkCode}` : "", error?.details?.hilinkMessage ? `HiLink message: ${String(error.details.hilinkMessage).slice(0, 160)}` : ""].filter(Boolean).join(" | ").slice(0, 400)
      : "Unknown Agent error",
  };
}

export class StationCommandExecutor {
  constructor({
    sessionFactory = modemIp => new HiLinkUssdSession(modemIp),
    releaseModem = releaseHiLinkUssdSession,
    readSmsInboxFn = readHiLinkSmsInbox,
    executeServiceCodeFn = executeWindowsServiceCode,
  } = {}) {
    this.sessionFactory = sessionFactory;
    this.releaseModem = releaseModem;
    this.readSmsInboxFn = readSmsInboxFn;
    this.executeServiceCodeFn = executeServiceCodeFn;
    this.sessions = new Map();
  }

  async execute(command) {
    const commandUuid = text(command?.command_uuid);
    const sessionUuid = text(command?.session_uuid);
    const action = text(command?.action);
    const modemIp = text(command?.modem_ip);
    const value = command?.value == null ? null : String(command.value);
    // Safe transport timings only. The code/PIN/recipient never enters
    // diagnostic fields; existing job/command UUIDs link the event history.
    const startedAtUtc = new Date().toISOString();
    const startedAtMs = Date.now();

    if (!commandUuid || !sessionUuid || !action || !modemIp) {
      return {
        status: "failed",
        raw_response: null,
        error_code: "INVALID_COMMAND",
        error_message: "Station command is incomplete",
      };
    }

    try {
      if (action === "ussd_start") {
        if (!value) {
          return {
            status: "failed",
            raw_response: null,
            error_code: "COMMAND_VALUE_REQUIRED",
            error_message: "ussd_start requires a value",
          };
        }

        const existing = this.sessions.get(sessionUuid);
        if (existing) {
          await existing.close().catch(() => {});
          this.sessions.delete(sessionUuid);
        }

        const session = this.sessionFactory(modemIp);
        const response = await session.start(value);
        this.sessions.set(sessionUuid, session);

        return {
          status: "success",
          raw_response: response,
          error_code: null,
          error_message: null,
        };
      }

      if (action === "ussd_send_short") {
        if (!value) {
          return {
            status: "failed",
            raw_response: null,
            error_code: "COMMAND_VALUE_REQUIRED",
            error_message: "ussd_send_short requires a server-issued value",
          };
        }
        // This action is transport-only; the server enforces that only a
        // nonfinancial 632 job can queue it, and substitutes the vault PIN.
        const existing = this.sessions.get(sessionUuid);
        if (existing) {
          return {
            status: "review",
            raw_response: null,
            error_code: "LOCAL_SESSION_ALREADY_OPEN",
            error_message: "Refusing a second short USSD send on a live session",
          };
        }
        const session = this.sessionFactory(modemIp);
        // Install transport ownership before the send attempt, since an HTTP
        // error does NOT prove that HiLink did not execute the USSD.
        // An explicit server release must be able to find this local handle.
        this.sessions.set(sessionUuid, session);
        const response = await session.startShort(value);
        return {
          status: "success",
          raw_response: response,
          error_code: null,
          error_message: null,
        };
      }

      if (action === "ussd_reply") {
        if (value == null) {
          return {
            status: "failed",
            raw_response: null,
            error_code: "COMMAND_VALUE_REQUIRED",
            error_message: "ussd_reply requires a value",
          };
        }

        const session = this.sessions.get(sessionUuid);
        if (!session) {
          return {
            status: "review",
            raw_response: null,
            error_code: "LOCAL_SESSION_MISSING",
            error_message: "USSD session is not available in this Agent runtime",
          };
        }

        const response = await session.reply(value);
        return {
          status: "success",
          raw_response: response,
          error_code: null,
          error_message: null,
        };
      }

      if (action === "service_code_dial") {
        if (!value) {
          return {
            status: "failed",
            raw_response: null,
            error_code: "COMMAND_VALUE_REQUIRED",
            error_message: "service_code_dial requires a value",
          };
        }

        return await this.executeServiceCodeFn(value, { modemIp });
      }

      if (action === "sms_read") {
        const delayMs = Math.min(30000, Math.max(0, Number(value) || 0));
        if (delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }

        const messages = await this.readSmsInboxFn(modemIp);
        return {
          status: "success",
          raw_response: JSON.stringify({
            messages: Array.isArray(messages) ? messages : [],
            diagnostic: {
              stage: "sms_inbox_read",
              started_at_utc: startedAtUtc,
              finished_at_utc: new Date().toISOString(),
              elapsed_ms: Date.now()-startedAtMs,
              wait_ms: delayMs,
              message_count: Array.isArray(messages) ? messages.length : 0,
            },
          }),
          error_code: null,
          error_message: null,
        };
      }

      if (action === "ussd_release") {
        const session = this.sessions.get(sessionUuid);
        const isShort = session?.shortOnly === true;
        if (session) {
          try {
            if (session.shortOnly === true && typeof session.closeShort === "function") {
              await session.closeShort();
            } else {
              await session.close();
            }
          } finally {
            // A failed physical release is REVIEW. Never retain a stale
            // in-memory handle and claim it belongs to a future command.
            this.sessions.delete(sessionUuid);
          }
        } else {
          await this.releaseModem(modemIp);
        }

        return {
          status: "success",
          // For 632 the release outcome is separately auditable. Keep
          // the original null 630 raw_response contract unchanged.
          raw_response: isShort ? JSON.stringify({
            stage: "short_ussd_release",
            started_at_utc: startedAtUtc,
            finished_at_utc: new Date().toISOString(),
            elapsed_ms: Date.now()-startedAtMs,
            outcome: "modem_release_http_accepted",
          }) : null,
          error_code: null,
          error_message: null,
        };
      }

      return {
        status: "failed",
        raw_response: null,
        error_code: "UNSUPPORTED_COMMAND_ACTION",
        error_message: `Unsupported Station command action: ${action}`,
      };
    } catch (error) {
      if (action === "ussd_release") {
        this.sessions.delete(sessionUuid);
      }

      const failure = technicalFailure(error);
      if (action === "ussd_send_short" || action === "sms_read" ||
        (action === "ussd_release" && error?.details?.executionStarted === true)) {
        failure.raw_response = JSON.stringify({
          diagnostic: {
            stage: action,
            started_at_utc: startedAtUtc,
            finished_at_utc: new Date().toISOString(),
            elapsed_ms: Date.now()-startedAtMs,
            outcome: "error_or_unknown",
            error_code: failure.error_code,
          },
        });
      }
      return failure;
    }
  }

  async closeAll() {
    const entries = [...this.sessions.entries()];
    this.sessions.clear();

    await Promise.all(entries.map(async ([, session]) => {
      try {
        await session.close();
      } catch {
        // Best effort shutdown.
      }
    }));
  }
}
