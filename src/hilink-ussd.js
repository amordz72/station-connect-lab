import http from "node:http";
import os from "node:os";

const POLL_ATTEMPTS = 30;
const REQUEST_TIMEOUT_MS = 6000;

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function decodeXml(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_m, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

export function readXmlTag(xml, name) {
  const match = String(xml).match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "i"));
  return match ? decodeXml(match[1]).trim() : "";
}

function isPrivateIpv4(value) {
  const parts = String(value).trim().split(".").map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return false;
}

function subnet24(value) {
  const parts = String(value || "").trim().split(".");
  return parts.length === 4 ? parts.slice(0, 3).join(".") : "";
}

export function resolveLocalAddressForModem(modemIp, interfaces = os.networkInterfaces()) {
  const target = subnet24(modemIp);
  if (!target) return null;

  const candidates = [];
  for (const rows of Object.values(interfaces || {})) {
    for (const row of Array.isArray(rows) ? rows : []) {
      if (row?.internal || row?.family !== "IPv4") continue;
      const address = String(row.address || "").trim();
      if (subnet24(address) === target && address !== modemIp) candidates.push(address);
    }
  }

  const unique = [...new Set(candidates)];
  if (!unique.length) return null;
  if (unique.length === 1) return unique[0];

  // HiLink adapters in this project normally use .100 on Windows.
  return unique.find(value => value.endsWith(".100")) || unique.sort()[0];
}

export class HiLinkUssdError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "HiLinkUssdError";
    this.details = details;
  }
}

export function normalizeModemIp(value) {
  const ip = String(value || "").trim();
  if (!isPrivateIpv4(ip)) throw new HiLinkUssdError("HILINK_IP must be a private IPv4 address");
  return ip;
}

function apiError(xml) {
  if (!/<error>/i.test(String(xml))) return null;
  return {
    code: readXmlTag(xml, "code") || "UNKNOWN",
    message: readXmlTag(xml, "message") || "",
  };
}

async function request(ip, path, session = null, {
  method = "GET",
  body = null,
  timeoutMs = REQUEST_TIMEOUT_MS,
  localAddress = null,
} = {}) {
  const headers = { Accept: "application/xml" };
  if (body != null) {
    headers["Content-Type"] = "application/xml; charset=UTF-8";
    headers["Content-Length"] = Buffer.byteLength(body);
  }
  if (session?.cookie) headers.Cookie = session.cookie;
  if (session?.token) headers.__RequestVerificationToken = session.token;

  return new Promise((resolve, reject) => {
    const req = http.request({
      host: ip,
      port: 80,
      path,
      method,
      headers,
      localAddress: localAddress || undefined,
    }, response => {
      let xml = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { xml += chunk; });
      response.on("end", () => {
        if ((response.statusCode || 500) < 200 || (response.statusCode || 500) >= 300) {
          reject(new HiLinkUssdError(`HiLink HTTP ${response.statusCode || "UNKNOWN"}`, {
            httpStatus: response.statusCode,
          }));
          return;
        }

        const error = apiError(xml);
        if (error) {
          reject(new HiLinkUssdError("HiLink rejected the request", {
            hilinkCode: error.code,
            hilinkMessage: error.message,
          }));
          return;
        }

        resolve(xml);
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new HiLinkUssdError("HiLink request timed out"));
    });
    req.once("error", error => {
      if (error instanceof HiLinkUssdError) reject(error);
      else reject(new HiLinkUssdError(error?.message || "Unable to reach HiLink modem"));
    });
    if (body != null) req.write(body);
    req.end();
  });
}

async function openSession(ip, { localAddress = null } = {}) {
  const xml = await request(ip, "/api/webserver/SesTokInfo", null, { localAddress });
  const cookie = readXmlTag(xml, "SesInfo");
  const token = readXmlTag(xml, "TokInfo");
  if (!cookie || !token) throw new HiLinkUssdError("HiLink session token is incomplete");
  return { cookie, token };
}

function emptyToNull(value) {
  const text = String(value || "").trim();
  return text || null;
}

export async function readHiLinkHardware(modemIp, { localAddress: preferredLocalAddress = null } = {}) {
  const normalizedIp = normalizeModemIp(modemIp);
  // Normal Agent operation keeps its historical behavior. Read-only hardware
  // diagnosis may pin BOTH GETs to the exact Windows USB network adapter.
  const localAddress = preferredLocalAddress || resolveLocalAddressForModem(normalizedIp);
  const session = await openSession(normalizedIp, { localAddress });
  const xml = await request(normalizedIp, "/api/device/information", session, { localAddress });

  return {
    modem_ip: normalizedIp,
    imei: emptyToNull(readXmlTag(xml, "Imei")),
    serial_number: emptyToNull(readXmlTag(xml, "SerialNumber")),
    device_name: emptyToNull(readXmlTag(xml, "DeviceName")),
    iccid: emptyToNull(readXmlTag(xml, "Iccid")),
    imsi: emptyToNull(readXmlTag(xml, "Imsi")),
    msisdn: emptyToNull(readXmlTag(xml, "Msisdn")),
  };
}

function waitingCode(error) {
  return error instanceof HiLinkUssdError
    && ["111016", "111019"].includes(String(error.details?.hilinkCode || ""));
}

async function release(ip, session, localAddress) {
  try {
    await request(ip, "/api/ussd/release", session, {
      method: "POST",
      body: "<request><Release>1</Release></request>",
      timeoutMs: 3000,
      localAddress,
    });
  } catch {
    // Some Huawei HiLink firmware releases the session automatically.
  }
}

async function send(ip, value, session, localAddress) {
  await request(ip, "/api/ussd/send", session, {
    method: "POST",
    body: `<request><content>${escapeXml(value)}</content><codeType>CodeType</codeType><timeout></timeout></request>`,
    timeoutMs: 7000,
    localAddress,
  });
}

async function waitForReply(ip, session, localAddress, previous = "") {
  let lastError = null;

  for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1) {
    await wait(attempt === 1 ? 700 : 500);
    try {
      const xml = await request(ip, "/api/ussd/get", session, {
        timeoutMs: 5000,
        localAddress,
      });
      const content = readXmlTag(xml, "content");
      if (!content || content === previous) continue;
      return content;
    } catch (error) {
      if (waitingCode(error)) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  throw new HiLinkUssdError(
    lastError?.details?.hilinkCode
      ? `USSD reply timed out (${lastError.details.hilinkCode})`
      : "USSD reply timed out",
    { executionStarted: true },
  );
}

export async function releaseHiLinkUssdSession(modemIp) {
  const normalizedIp = normalizeModemIp(modemIp);
  const localAddress = resolveLocalAddressForModem(normalizedIp);
  const session = await openSession(normalizedIp, { localAddress });
  await release(normalizedIp, session, localAddress);
}

export class HiLinkUssdSession {
  constructor(modemIp, { localAddress = null } = {}) {
    this.modemIp = normalizeModemIp(modemIp);
    this.localAddress = localAddress || resolveLocalAddressForModem(this.modemIp);
    this.session = null;
    this.lastReply = "";
    this.opened = false;
    this.executionStarted = false;
    this.shortOnly = false;
  }

  // Generic short noninteractive USSD transport. The server decides which
  // nonfinancial job may use it; this method never interprets network results.
  async startShort(code) {
    const startedAt = Date.now();
    this.session = await openSession(this.modemIp, { localAddress: this.localAddress });
    // Track the actual physical session BEFORE invoking POST /api/ussd/send:
    // a timeout after the POST may mean the modem executed it anyway.
    this.opened = true;
    this.shortOnly = true;
    try {
      await send(this.modemIp, code, this.session, this.localAddress);
    } catch (error) {
      // Once POST /api/ussd/send starts, the modem/network outcome can be
      // unknown even on HTTP timeout: preserve REVIEW evidence, never retry.
      if (error instanceof HiLinkUssdError) {
        throw new HiLinkUssdError(error.message, {
          ...error.details, executionStarted: true,
        });
      }
      throw new HiLinkUssdError("HiLink short USSD dispatch outcome unknown", {
        executionStarted: true,
      });
    }
    this.executionStarted = true;
    this.opened = true;
    this.shortOnly = true;
    return JSON.stringify({
      transport: "hilink_ussd_send",
      ack: "modem_http_accepted_not_network_balance",
      send_ack_at: new Date().toISOString(),
      elapsed_ms: Date.now() - startedAt,
    });
  }

  // Short-flow release reports a real transport error, unlike legacy
  // best-effort release. Never claim physical release succeeded when unknown.
  async closeShort() {
    if (!this.shortOnly || !this.session) {
      throw new HiLinkUssdError("Short USSD local session missing", {
        executionStarted: this.executionStarted,
      });
    }
    try {
      // Many HiLink firmwares rotate the request-verification token after
      // POST /api/ussd/send. Refresh HTTP auth, but NOT the modem USSD dialog,
      // before release. Any failed release stays REVIEW instead of fake success.
      this.session = await openSession(this.modemIp, {
        localAddress: this.localAddress,
      });
      await request(this.modemIp, "/api/ussd/release", this.session, {
        method: "POST",
        body: "<request><Release>1</Release></request>",
        timeoutMs: 3000,
        localAddress: this.localAddress,
      });
    } catch (error) {
      // Failure to confirm RELEASE means physical session state is unknown.
      // The server must retain REVIEW evidence and must not infer cleanup.
      if (error instanceof HiLinkUssdError) {
        throw new HiLinkUssdError(error.message, {
          ...error.details, executionStarted: true,
        });
      }
      throw new HiLinkUssdError("Short USSD release outcome unknown", {
        executionStarted: true,
      });
    } finally {
      this.opened = false;
      this.session = null;
      this.shortOnly = false;
    }
  }

  async start(code) {
    // This mirrors the field-tested HiLink IP Manager path:
    // one SesTokInfo session is reused for SEND -> GET polling -> RELEASE.
    this.session = await openSession(this.modemIp, { localAddress: this.localAddress });
    await send(this.modemIp, code, this.session, this.localAddress);
    this.executionStarted = true;
    this.opened = true;
    this.lastReply = await waitForReply(
      this.modemIp,
      this.session,
      this.localAddress,
    );
    return this.lastReply;
  }

  async reply(value) {
    if (!this.opened || !this.session) throw new HiLinkUssdError("USSD session is not open");
    // Huawei may invalidate the CSRF token after the initial USSD POST.
    // Refresh only the HTTP auth token/cookie; keep the active modem USSD dialog.
    this.session = await openSession(this.modemIp, { localAddress: this.localAddress });
    await send(this.modemIp, value, this.session, this.localAddress);
    this.executionStarted = true;
    this.lastReply = await waitForReply(
      this.modemIp,
      this.session,
      this.localAddress,
      this.lastReply,
    );
    return this.lastReply;
  }

  async close() {
    if (!this.opened || !this.session) return;
    await release(this.modemIp, this.session, this.localAddress);
    this.opened = false;
    this.session = null;
  }
}

// Reads only the inbox. No message is deleted or marked by the Agent.
export async function readHiLinkSmsInbox(modemIp) {
  const normalizedIp = normalizeModemIp(modemIp);
  const localAddress = resolveLocalAddressForModem(normalizedIp);
  const session = await openSession(normalizedIp, { localAddress });
  const xml = await request(normalizedIp, "/api/sms/sms-list", session, {
    method: "POST",
    body: "<request><PageIndex>1</PageIndex><ReadCount>20</ReadCount><BoxType>1</BoxType><SortType>0</SortType><Ascending>0</Ascending><UnreadPreferred>0</UnreadPreferred></request>",
    localAddress,
  });

  const entries = [...xml.matchAll(/<Message>([\s\S]*?)<\/Message>/gi)];
  return entries.map(([, entry]) => ({
    index: readXmlTag(entry, "Index"),
    sender: readXmlTag(entry, "Phone"),
    date: readXmlTag(entry, "Date"),
    content: readXmlTag(entry, "Content"),
    smstat: readXmlTag(entry, "Smstat"),
    sca: readXmlTag(entry, "Sca"),
    save_type: readXmlTag(entry, "SaveType"),
    priority: readXmlTag(entry, "Priority"),
    sms_type: readXmlTag(entry, "SmsType"),
  }));
}
