import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const executor=readFileSync(new URL("../src/command-executor.js",import.meta.url),"utf8");
const modem=readFileSync(new URL("../src/hilink-ussd.js",import.meta.url),"utf8");
test("transport receives values from server, never chooses network account or financial success",()=>{
  assert.match(executor,/session\.startShort\(value\)/);
  assert.match(modem,/async startShort\(code\)/);
  for(const item of [executor,modem]){
    assert.doesNotMatch(item,/SUPABASE_SERVICE_ROLE_KEY|stationSecret|station_connect_admin_send_arsselli_630|distributor_account_code|financial_result: "success"/);
    assert.doesNotMatch(item,/https:\/\/wqyebqzbbpohbnznqdjj/);
  }
});
test("short modem send does not wait for a USSD GET network reply",()=>{
  const part=modem.split("async startShort(code) {")[1]?.split("async closeShort() {")[0];
  assert.ok(part);
  assert.doesNotMatch(part,/waitForReply|\/api\/ussd\/get|setInterval/);
});
