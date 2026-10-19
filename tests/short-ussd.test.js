import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {StationCommandExecutor} from "../src/command-executor.js";

const code="*000#"; // Synthetic TEST-ONLY value; not a real PIN.

test("short USSD invokes ONLY startShort and records transport ACK, not an SMS balance",async()=>{
  const calls=[];
  const session={
    shortOnly:false,
    async start(){throw Error("interactive start must NOT be invoked");},
    async reply(){throw Error("USSD reply must NOT be invoked");},
    async startShort(v){
      calls.push(["send",v]);
      this.shortOnly=true;
      return JSON.stringify({
        transport:"hilink_ussd_send",ack:"modem_http_accepted_not_network_balance",
        send_ack_at:"2026-10-19T20:00:00Z",elapsed_ms:73
      });
    },
    async closeShort(){calls.push(["release"]);this.shortOnly=false;},
    async close(){throw Error("interactive close must NOT be invoked");},
  };
  const executor=new StationCommandExecutor({
    sessionFactory:()=>session,releaseModem:async()=>{throw Error("unexpected release fallback");},
  });
  const start=await executor.execute({
    command_uuid:"short-1",session_uuid:"only-632",action:"ussd_send_short",
    value:code,modem_ip:"192.168.70.70"
  });
  assert.equal(start.status,"success");
  assert.equal(JSON.parse(start.raw_response).ack,"modem_http_accepted_not_network_balance");
  assert.deepEqual(calls,[["send",code]]);
  const release=await executor.execute({
    command_uuid:"release-1",session_uuid:"only-632",action:"ussd_release",
    modem_ip:"192.168.70.70"
  });
  assert.equal(release.status,"success");
  assert.deepEqual(calls,[["send",code],["release"]]);
  assert.equal(executor.sessions.size,0);
  assert.equal(JSON.parse(release.raw_response).stage,"short_ussd_release");
  assert.ok(JSON.parse(release.raw_response).elapsed_ms>=0);
  assert.ok(JSON.parse(release.raw_response).finished_at_utc);
});

test("short USSD rejection preserves failure evidence and does not redial or invoke money",async()=>{
  let sends=0,releases=0;
  const executor=new StationCommandExecutor({
    sessionFactory:()=>({
      shortOnly:false,
      async startShort(){
        sends++;
        this.shortOnly=true;
        throw Object.assign(new Error("ambiguous modem reply"),
          {details:{executionStarted:true,hilinkCode:"111019"}});
      },
      async closeShort(){releases++;this.shortOnly=false;},
    }),
    releaseModem:async()=>{throw Error("must use the retained short session");},
  });
  const result=await executor.execute({
    command_uuid:"short-2",session_uuid:"short-session",action:"ussd_send_short",
    value:code,modem_ip:"192.168.70.70"
  });
  assert.equal(result.status,"review");
  assert.equal(result.error_code,"HILINK_111019");
  const errorTrace=JSON.parse(result.raw_response).diagnostic;
  assert.equal(errorTrace.stage,"ussd_send_short");
  assert.ok(errorTrace.started_at_utc);
  assert.equal(errorTrace.error_code,"HILINK_111019");
  assert.equal(sends,1);
  assert.equal(executor.sessions.size,1,
    "unknown send outcome must retain the physical short-session handle");
  const release=await executor.execute({
    command_uuid:"release-after-uncertain-send",session_uuid:"short-session",
    action:"ussd_release",modem_ip:"192.168.70.70"
  });
  assert.equal(release.status,"success");
  assert.equal(releases,1);
  assert.equal(sends,1,"release must NEVER redial the nonfinancial 632");
  assert.equal(executor.sessions.size,0);
});

test("short USSD release transport error is REVIEW and frees stale in-memory handle",async()=>{
  const session={
    shortOnly:false,
    async startShort(){this.shortOnly=true;return "ACK";},
    async closeShort(){throw Object.assign(new Error("release not confirmed"),
      {details:{executionStarted:true}});},
  };
  const executor=new StationCommandExecutor({sessionFactory:()=>session});
  await executor.execute({
    command_uuid:"short-3",session_uuid:"s3",action:"ussd_send_short",
    value:code,modem_ip:"192.168.70.70"
  });
  const release=await executor.execute({
    command_uuid:"release-3",session_uuid:"s3",action:"ussd_release",
    modem_ip:"192.168.70.70"
  });
  assert.equal(release.status,"review");
  assert.equal(executor.sessions.size,0);
});

test("short HiLink transport source has no USSD GET/poll loop and never stores PIN",()=>{
  const src=readFileSync(new URL("../src/hilink-ussd.js",import.meta.url),"utf8");
  const start=src.split("async startShort(code) {")[1]?.split("async closeShort() {")[0];
  assert.ok(start,"startShort must be explicitly present");
  assert.doesNotMatch(start,/waitForReply|\/api\/ussd\/get|setInterval/);
  assert.match(start,/send\(this\.modemIp, code, this\.session/);
  assert.match(start,/send_ack_at:/);
  assert.match(start,/elapsed_ms:/);
  assert.doesNotMatch(start,/JSON\.stringify\(\{[\s\S]*code,|pin:|service_pin:/i);
});

test("SMS read saves per-step timing without touching source SMS data",async()=>{
  const messages=[{index:"test-1",date:"2026-10-19",sender:"TEST",content:"Synthetic inbox response"}];
  const executor=new StationCommandExecutor({
    readSmsInboxFn:async()=>messages,sessionFactory:()=>{throw Error("no USSD");},
  });
  const result=await executor.execute({
    command_uuid:"sms-diag-1",session_uuid:"sms-s1",action:"sms_read",
    value:"0",modem_ip:"192.168.70.70"
  });
  assert.equal(result.status,"success");
  const response=JSON.parse(result.raw_response);
  assert.deepEqual(response.messages,messages);
  assert.equal(response.diagnostic.stage,"sms_inbox_read");
  assert.equal(response.diagnostic.message_count,1);
  assert.equal(response.diagnostic.wait_ms,0);
  assert.ok(response.diagnostic.started_at_utc && response.diagnostic.finished_at_utc);
  assert.ok(response.diagnostic.elapsed_ms>=0);
  assert.doesNotMatch(JSON.stringify(response.diagnostic),/service_pin|00000|Synthetic inbox response/);
});
