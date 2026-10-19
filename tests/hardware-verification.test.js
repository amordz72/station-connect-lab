import test from "node:test";
import assert from "node:assert/strict";
import { selectUniqueHardwareBindings } from "../src/hardware-verification.js";

function observation({ adapter = 5, ip = "192.168.10.1", imei = "000000000000000",
  iccid = "000000000001" } = {}) {
  return {
    target: { modem_ip: ip, interface_index: adapter },
    hardware: { modem_ip: ip, imei, iccid, msisdn: "0600000000" },
  };
}

test("same ICCID is accepted after swapping the SIM between USB adapters", () => {
  const before = selectUniqueHardwareBindings([observation()]);
  const after = selectUniqueHardwareBindings([
    observation({ adapter: 7, ip: "192.168.70.70", imei: "111111111111111" }),
  ]);
  assert.equal(before.accepted.length, 1);
  assert.equal(after.accepted.length, 1);
  assert.equal(after.accepted[0].hardware.iccid, before.accepted[0].hardware.iccid);
  assert.equal(after.accepted[0].target.interface_index, 7);
  assert.equal(after.rejected.length, 0);
});

test("two different SIMs with one factory MAC can still be identified by ICCID", () => {
  const result = selectUniqueHardwareBindings([
    observation(),
    observation({ adapter: 7, ip: "192.168.70.70",
      imei: "111111111111111", iccid: "000000000002" }),
  ]);
  assert.equal(result.accepted.length, 2);
});

test("duplicate ICCID on simultaneous interfaces is rejected on both", () => {
  const result = selectUniqueHardwareBindings([
    observation(),
    observation({ adapter: 7, ip: "192.168.70.70", imei: "111111111111111" }),
  ]);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected.length, 2);
  assert.ok(result.rejected.every(x => x.reason.includes("DUPLICATE_SIM_IDENTITY")));
});

test("duplicate modem IMEI on different interfaces is rejected", () => {
  const result = selectUniqueHardwareBindings([
    observation(),
    observation({ adapter: 7, ip: "192.168.70.70", iccid: "000000000002" }),
  ]);
  assert.equal(result.accepted.length, 0);
  assert.ok(result.rejected.every(x => x.reason.includes("DUPLICATE_MODEM_IDENTITY")));
});

test("without ICCID never assume registered SIM from telephone number or USB ID", () => {
  const result = selectUniqueHardwareBindings([
    observation({ iccid: "" }),
  ]);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0].reason, "MISSING_MODEM_OR_SIM_IDENTITY");
});

test("one adapter cannot publish two different modem identities at once", () => {
  const result = selectUniqueHardwareBindings([
    observation(),
    observation({ adapter: 5, ip: "192.168.10.2",
      imei: "111111111111111", iccid: "000000000002" }),
  ]);
  assert.equal(result.accepted.length, 0);
  assert.ok(result.rejected.every(x => x.reason.includes("MULTIPLE_MODEMS_PER_ADAPTER")));
});
