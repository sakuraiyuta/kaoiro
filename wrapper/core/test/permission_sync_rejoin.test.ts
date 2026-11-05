import "../../../scripts/test/fixtures/test-isolation.mjs";
import {expect,it} from "vitest";
import {ServerLink} from "../src/transport.js";
import {phoenixLoopback} from "../../codex/test/fixtures/phoenix_loopback.js";
import type {Envelope} from "@kaoiro/protocol";

it("keeps the latest never-sent error through a real long rejoin and restores the ready snapshot once",async()=>{
  let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  const wire=await phoenixLoopback(async count=>{
    if(count>1) await held;
    return {inter_agent_reply_basis:"v1",delivery_resync:"skip-v1",delivery:{issued_seq:0,acked_seq:0}};
  });
  let mode="pending";
  const link=new ServerLink(wire.url,"rejoin-error",{personaId:"p",interAgentReplyBasis:"v1",onReplyBasisMode:value=>{mode=value;}});
  const until=async(check:()=>boolean)=>{
    const end=performance.now()+5_000;
    while(!check()){if(performance.now()>end)throw Error("rejoin observation timed out");await new Promise(resolve=>setTimeout(resolve,5));}
  };
  const make=(type:Envelope["type"],text:string):Envelope=>({version:"0",agent_id:"rejoin-error",display_name:"P",persona:{id:"p",name:"P",sprite_set:"p"},ts:"T",type,state:type==="state_change"?"waiting_input":"error",payload:type==="result"?{text,is_error:true,error_detail:text}:{},ext:{}});
  const results=()=>wire.received.filter(item=>item.event==="envelope"&&item.payload.type==="result");
  try{
    await until(()=>mode==="v1");link.send(make("state_change",""));
    link.send(make("result","connected control"));await until(()=>results().length===1);
    wire.drop();await until(()=>mode==="pending");
    link.send(make("result","superseded"));link.send(make("result","latest fixed failure"));
    link.send(make("state_change",""));
    await new Promise(resolve=>setTimeout(resolve,11_000));
    expect(results()).toHaveLength(1);
    release();await until(()=>mode==="v1");await link.requestDirectory();
    expect(results().map(item=>(item.payload.payload as {text:string}).text)).toEqual(["connected control","latest fixed failure"]);
    const frames=wire.received.filter(item=>item.event==="envelope");
    const lastError=frames.findIndex(item=>(item.payload.payload as {text?:string}).text==="latest fixed failure");
    expect(frames.slice(lastError+1).some(item=>item.payload.type==="state_change"&&item.payload.state==="waiting_input")).toBe(true);
    wire.drop();await until(()=>mode==="pending");await until(()=>mode==="v1");await link.requestDirectory();
    expect(results()).toHaveLength(2);
  }finally{release();link.close();await wire.close();}
},20_000);
