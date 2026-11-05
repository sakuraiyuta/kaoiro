import "../../../scripts/test/fixtures/test-isolation.mjs";
import {expect,it,vi} from "vitest";
import {permissionSyncFailure,retirePermissionSyncInput} from "../src/permission_sync_failure.js";
import {DeliveryAcknowledgement} from "../src/delivery_ack.js";
import type {Envelope} from "@kaoiro/protocol";
it("projects safe first-attempt and recovery failures and leaves no unretired ACK gap",()=>{
 const stderr=vi.spyOn(process.stderr,"write").mockImplementation(()=>true);
 try {
  expect(permissionSyncFailure()).toMatchObject({is_error:true,error_subtype:"error_during_execution",error_detail:expect.stringContaining("No execution was started")});
  expect(permissionSyncFailure(true).error_detail).toContain("earlier attempt may have executed");expect(stderr).toHaveBeenCalledTimes(2);
  const item={delivery_seq:1} as unknown as Envelope, events:string[]=[], watermark:number[]=[];
  const ack=new DeliveryAcknowledgement(seq=>watermark.push(seq));ack.observe({acked_seq:0});
  retirePermissionSyncInput({envelopes:[item],retire:items=>{expect(items).toEqual([item]);events.push("retire");return true;},forgetStages:()=>events.push("forget"),clearInjection:()=>events.push("clear")});
  expect(events).toEqual(["retire","forget","clear"]);const noDelivery=vi.fn();retirePermissionSyncInput({envelopes:[],retire:noDelivery,clearInjection:()=>{}});expect(noDelivery).not.toHaveBeenCalled();ack.acknowledgeEnvelope({delivery_seq:2} as unknown as Envelope);expect(watermark).toEqual([]);
  ack.observe({acked_seq:1,skipped_ranges:[[1,1]]});expect(watermark).toEqual([2]);
  retirePermissionSyncInput({envelopes:[item],retire:()=>false,clearInjection:()=>{}});expect(stderr.mock.calls.flat().join("")).toContain("retirement unavailable");
 }finally{stderr.mockRestore();}
});
