import test from "node:test";
import assert from "node:assert/strict";
import { StationCommandExecutor } from "../src/command-executor.js";

class MockSession {
  constructor(modemIp, replies) {
    this.modemIp=modemIp;
    this.replies=[...replies];
    this.calls=[];
    this.closed=false;
  }
  async start(value){
    this.calls.push(["start",String(value)]);
    return this.replies.shift() ?? "";
  }
  async reply(value){
    this.calls.push(["reply",String(value)]);
    return this.replies.shift() ?? "";
  }
  async close(){
    this.calls.push(["close"]);
    this.closed=true;
  }
}

test("command executor keeps one USSD session across server commands",async()=>{
  const created=[];
  const executor=new StationCommandExecutor({
    sessionFactory:modemIp=>{
      const session=new MockSession(modemIp,[
        "Veuillez entrer votre mot de passe",
        "1.Sama Mix 100\n0:Suivant",
        "Le Sama Mix 100 a été transféré avec succès"
      ]);
      created.push(session);
      return session;
    },
    releaseModem:async()=>{}
  });

  const start=await executor.execute({
    command_uuid:"c1",
    session_uuid:"s1",
    action:"ussd_start",
    value:"*665*1*0600000000#",
    modem_ip:"192.168.86.1"
  });
  assert.equal(start.status,"success");
  assert.equal(start.raw_response,"Veuillez entrer votre mot de passe");

  const pin=await executor.execute({
    command_uuid:"c2",
    session_uuid:"s1",
    action:"ussd_reply",
    value:"1234",
    modem_ip:"192.168.86.1"
  });
  assert.equal(pin.status,"success");
  assert.equal(pin.raw_response,"1.Sama Mix 100\n0:Suivant");

  const choice=await executor.execute({
    command_uuid:"c3",
    session_uuid:"s1",
    action:"ussd_reply",
    value:"1",
    modem_ip:"192.168.86.1"
  });
  assert.equal(choice.status,"success");
  assert.equal(choice.raw_response,"Le Sama Mix 100 a été transféré avec succès");

  const release=await executor.execute({
    command_uuid:"c4",
    session_uuid:"s1",
    action:"ussd_release",
    value:null,
    modem_ip:"192.168.86.1"
  });
  assert.equal(release.status,"success");

  assert.equal(created.length,1);
  assert.deepEqual(created[0].calls,[
    ["start","*665*1*0600000000#"],
    ["reply","1234"],
    ["reply","1"],
    ["close"]
  ]);
});

test("reply without a local session returns review instead of guessing",async()=>{
  const executor=new StationCommandExecutor({
    sessionFactory:()=>{throw new Error("not used");},
    releaseModem:async()=>{}
  });

  const result=await executor.execute({
    command_uuid:"c2",
    session_uuid:"missing",
    action:"ussd_reply",
    value:"1",
    modem_ip:"192.168.86.1"
  });

  assert.equal(result.status,"review");
  assert.equal(result.error_code,"LOCAL_SESSION_MISSING");
});

test("release is idempotent when local session is already absent",async()=>{
  let releases=0;
  const executor=new StationCommandExecutor({
    sessionFactory:()=>{throw new Error("not used");},
    releaseModem:async()=>{releases++;}
  });

  const result=await executor.execute({
    command_uuid:"c3",
    session_uuid:"s3",
    action:"ussd_release",
    value:null,
    modem_ip:"192.168.86.1"
  });

  assert.equal(result.status,"success");
  assert.equal(releases,1);
});


test("sms_read returns the raw inbox without classifying messages",async()=>{
  const rawMessages=[
    {
      index:"70001",
      sender:"Mobilis",
      date:"2026-09-22 08:00:00",
      content:"Votre Balance:\nGTS est : 30.00 DZD .",
      sms_type:"1"
    },
    {
      index:"70002",
      sender:"Mobilis",
      date:"2026-09-22 08:00:05",
      content:"Vous avez recharger un montant de 50.00 DZD vers le 600000000.",
      sms_type:"1"
    }
  ];

  const executor=new StationCommandExecutor({
    sessionFactory:()=>{throw new Error("not used");},
    releaseModem:async()=>{},
    readSmsInboxFn:async()=>rawMessages
  });

  const result=await executor.execute({
    command_uuid:"sms1",
    session_uuid:"sms-session",
    action:"sms_read",
    value:null,
    modem_ip:"192.168.87.1"
  });

  assert.equal(result.status,"success");
  const payload=JSON.parse(result.raw_response);
  assert.deepEqual(payload.messages,rawMessages);
});


test("service_code_dial delegates exact code envelope to Windows transport", async()=>{
  let received=null;
  const executor=new StationCommandExecutor({
    sessionFactory:()=>{throw new Error("not used");},
    releaseModem:async()=>{},
    executeServiceCodeFn:async(value,context)=>{
      received={value,context};
      return {
        status:"success",
        raw_response:"Votre numero est 0700000000",
        error_code:null,
        error_message:null
      };
    }
  });

  const value=JSON.stringify({code:"99",imei:"000000000000000",imsi:"000000000000000"});
  const result=await executor.execute({
    command_uuid:"svc1",
    session_uuid:"svc-session",
    action:"service_code_dial",
    value,
    modem_ip:"192.168.60.1"
  });

  assert.equal(result.status,"success");
  assert.equal(result.raw_response,"Votre numero est 0700000000");
  assert.equal(received.value,value);
  assert.deepEqual(received.context,{modemIp:"192.168.60.1"});
});
