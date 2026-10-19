import test from "node:test";
import assert from "node:assert/strict";
import { resolveLocalAddressForModem } from "../src/hilink-ussd.js";

test("selects the Windows IPv4 on the same HiLink /24",()=>{
  const interfaces={
    "Ethernet 16":[{family:"IPv4",address:"192.168.60.100",internal:false}],
    "Ethernet 18":[{family:"IPv4",address:"192.168.85.100",internal:false}],
    "Wi-Fi":[{family:"IPv4",address:"192.168.1.20",internal:false}],
  };

  assert.equal(
    resolveLocalAddressForModem("192.168.60.1",interfaces),
    "192.168.60.100"
  );
  assert.equal(
    resolveLocalAddressForModem("192.168.85.1",interfaces),
    "192.168.85.100"
  );
});

test("returns null when no local adapter matches the modem subnet",()=>{
  const interfaces={
    "Wi-Fi":[{family:"IPv4",address:"192.168.1.20",internal:false}],
  };
  assert.equal(resolveLocalAddressForModem("192.168.60.1",interfaces),null);
});
