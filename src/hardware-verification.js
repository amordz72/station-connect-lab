// Nonfinancial local snapshot validation before reporting detected SIMs.
// ICCID identifies the registered SIM; PIN/phone/account stay server-owned.
// USB index, MAC, IP and Windows adapter name are NEVER SIM identifiers.
const id = value => String(value ?? "").trim();

export function selectUniqueHardwareBindings(readings) {
  const accepted = [];
  const rejected = [];
  const rows = Array.isArray(readings) ? readings : [];
  const counts = { modem: new Map(), sim: new Map(), adapter: new Map() };
  const valid = [];

  for (const item of rows) {
    const modemId = id(item?.hardware?.imei || item?.hardware?.serial_number);
    const iccid = id(item?.hardware?.iccid);
    const adapter = Number(item?.target?.interface_index);
    if (!modemId || !iccid || !Number.isInteger(adapter) || adapter <= 0) {
      rejected.push({ target: item?.target || null, reason: "MISSING_MODEM_OR_SIM_IDENTITY" });
      continue;
    }
    const row = { target: item.target, hardware: item.hardware, modemId, iccid, adapter };
    valid.push(row);
    for (const [kind, key] of [["modem", modemId], ["sim", iccid], ["adapter", adapter]]) {
      const map = counts[kind];
      map.set(key, (map.get(key) || 0) + 1);
    }
  }
  for (const row of valid) {
    const conflicts = Object.entries({
      DUPLICATE_MODEM_IDENTITY: counts.modem.get(row.modemId) > 1,
      DUPLICATE_SIM_IDENTITY: counts.sim.get(row.iccid) > 1,
      MULTIPLE_MODEMS_PER_ADAPTER: counts.adapter.get(row.adapter) > 1,
    }).filter(([, conflicted]) => conflicted).map(([reason]) => reason);
    if (conflicts.length) {
      rejected.push({ target: row.target, reason: conflicts.join("+") });
    } else {
      accepted.push({ target: row.target, hardware: row.hardware });
    }
  }
  return { accepted, rejected };
}
