import { execFile as defaultExecFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(defaultExecFile);

function text(value) {
  return String(value ?? "").trim();
}

export function parseServiceCodeEnvelope(value) {
  let payload = value;
  if (typeof value === "string") {
    try {
      payload = JSON.parse(value);
    } catch {
      payload = { code: value };
    }
  }

  const code = text(payload?.code);
  const imei = text(payload?.imei).replace(/\D/g, "");
  const imsi = text(payload?.imsi).replace(/\D/g, "");

  if (!/^\d{1,8}$/.test(code)) {
    throw new Error("SERVICE_CODE_INVALID");
  }

  return {
    code,
    imei: /^\d{14,17}$/.test(imei) ? imei : "",
    imsi: /^\d{14,17}$/.test(imsi) ? imsi : "",
  };
}

function phoneCandidates(raw) {
  const values = (text(raw).match(/(?:\+?213|0)[\s.\-]*(?:5|6|7)(?:[\s.\-]*\d){8}/g) ?? [])
    .map(value => value.replace(/\D/g, ""))
    .map(value => value.startsWith("213") ? "0" + value.slice(3) : value)
    .filter(value => /^0[5-7]\d{8}$/.test(value));
  return [...new Set(values)];
}

const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$code = [string]$env:STATION_SERVICE_CODE
$targetImei = [string]$env:STATION_TARGET_IMEI
$targetImsi = [string]$env:STATION_TARGET_IMSI

function Read-Chunk($port, [int]$milliseconds) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($milliseconds)
  $buffer = New-Object System.Text.StringBuilder
  while ([DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 120
    try {
      $chunk = $port.ReadExisting()
      if ($chunk) { [void]$buffer.Append($chunk) }
    } catch {}
  }
  return $buffer.ToString()
}

function Send-At($port, [string]$command, [int]$waitMs = 900) {
  try { $port.DiscardInBuffer() } catch {}
  $port.Write($command + [char]13)
  return Read-Chunk $port $waitMs
}

$entities = @(Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue | Where-Object {
  $_.PNPDeviceID -like 'USB\*' -and
  ($_.PNPClass -in @('Ports','Modem')) -and
  (
    [string]$_.Manufacturer -match 'Huawei|HUAWEI' -or
    [string]$_.Name -match 'Huawei|HUAWEI|Mobile Connect|PC UI|Application Interface|Modem'
  )
})

$candidates = @()
foreach ($entity in $entities) {
  $name = [string]$entity.Name
  $m = [regex]::Match($name, '\((COM\d+)\)', 'IgnoreCase')
  if (-not $m.Success) { $m = [regex]::Match($name, '(COM\d+)', 'IgnoreCase') }
  if ($m.Success) {
    $candidates += [pscustomobject]@{
      PortName = $m.Groups[1].Value.ToUpperInvariant()
      Name = $name
      PnpId = [string]$entity.PNPDeviceID
    }
  }
}

if ($candidates.Count -eq 0) {
  [pscustomobject]@{
    state = 'no_port'
    port = $null
    imei = $null
    imsi = $null
    response = ''
  } | ConvertTo-Json -Compress
  exit 0
}

foreach ($candidate in $candidates) {
  $port = $null
  try {
    $port = New-Object System.IO.Ports.SerialPort $candidate.PortName,115200,'None',8,'One'
    $port.ReadTimeout = 500
    $port.WriteTimeout = 1200
    $port.DtrEnable = $true
    $port.RtsEnable = $true
    $port.Open()

    $hello = Send-At $port 'AT' 700
    if ($hello -notmatch 'OK') { continue }

    [void](Send-At $port 'ATE0' 350)
    $imeiRaw = Send-At $port 'AT+CGSN' 850
    $imsiRaw = Send-At $port 'AT+CIMI' 850
    $imeiMatch = [regex]::Match($imeiRaw, '(?<!\d)(\d{14,17})(?!\d)')
    $imsiMatch = [regex]::Match($imsiRaw, '(?<!\d)(\d{14,17})(?!\d)')
    $imei = if ($imeiMatch.Success) { $imeiMatch.Groups[1].Value } else { '' }
    $imsi = if ($imsiMatch.Success) { $imsiMatch.Groups[1].Value } else { '' }

    $identityMatches = $false
    if ($targetImei -and $imei -and $targetImei -eq $imei) { $identityMatches = $true }
    if ($targetImsi -and $imsi -and $targetImsi -eq $imsi) { $identityMatches = $true }
    if (-not $targetImei -and -not $targetImsi -and $candidates.Count -eq 1) { $identityMatches = $true }

    if (-not $identityMatches) { continue }

    # The user/network service code remains exact (for Djezzy: 99).
    # ATD and ';' are modem transport syntax and are not added to the service code itself.
    $dialRaw = Send-At $port ('ATD' + $code + ';') 9000
    $afterCnum = Send-At $port 'AT+CNUM' 1200
    [void](Send-At $port 'ATH' 500)
    $response = ($dialRaw + [Environment]::NewLine + $afterCnum).Trim()

    [pscustomobject]@{
      state = 'executed'
      port = $candidate.PortName
      imei = $imei
      imsi = $imsi
      response = $response
    } | ConvertTo-Json -Compress
    exit 0
  } catch {
    # Try the next candidate. A busy/non-AT port is expected on composite Huawei devices.
  } finally {
    if ($port) {
      try { if ($port.IsOpen) { $port.Close() } } catch {}
      try { $port.Dispose() } catch {}
    }
  }
}

[pscustomobject]@{
  state = 'identity_not_found'
  port = $null
  imei = $null
  imsi = $null
  response = ''
} | ConvertTo-Json -Compress
`;

export async function executeWindowsServiceCode(value, {
  platform = process.platform,
  execFileImpl = execFileAsync,
} = {}) {
  let envelope;
  try {
    envelope = parseServiceCodeEnvelope(value);
  } catch {
    return {
      status: "failed",
      raw_response: null,
      error_code: "SERVICE_CODE_INVALID",
      error_message: "Service code must contain digits only",
    };
  }

  if (platform !== "win32") {
    return {
      status: "review",
      raw_response: null,
      error_code: "SERVICE_CODE_WINDOWS_ONLY",
      error_message: "Service-code dialing currently requires the Windows Station Agent",
    };
  }

  try {
    const { stdout } = await execFileImpl("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-Command", POWERSHELL_SCRIPT,
    ], {
      windowsHide: true,
      timeout: 45000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        STATION_SERVICE_CODE: envelope.code,
        STATION_TARGET_IMEI: envelope.imei,
        STATION_TARGET_IMSI: envelope.imsi,
      },
    });

    const lines = String(stdout || "").trim().split(/\r?\n/).filter(Boolean);
    const result = JSON.parse(lines.at(-1) || "{}");
    const raw = text(result.response);

    if (result.state === "no_port") {
      return {
        status: "review",
        raw_response: null,
        error_code: "SERVICE_CODE_PORT_NOT_FOUND",
        error_message: "Windows does not expose a Huawei AT/COM interface for this HiLink modem",
      };
    }

    if (result.state === "identity_not_found") {
      return {
        status: "review",
        raw_response: null,
        error_code: "SERVICE_CODE_MODEM_NOT_MATCHED",
        error_message: "No AT/COM port matched the target modem or SIM identity",
      };
    }

    const phones = phoneCandidates(raw);
    if (phones.length === 1) {
      return {
        status: "success",
        raw_response: raw,
        error_code: null,
        error_message: null,
      };
    }

    return {
      status: "review",
      raw_response: raw || null,
      error_code: "SERVICE_CODE_NO_PHONE_NUMBER",
      error_message: "The service code was dialed but no single phone number was returned in the modem text response",
    };
  } catch (error) {
    return {
      status: "review",
      raw_response: null,
      error_code: "SERVICE_CODE_TRANSPORT_ERROR",
      error_message: error instanceof Error ? error.message : "Service-code transport failed",
    };
  }
}
