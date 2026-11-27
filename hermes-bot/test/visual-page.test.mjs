import test from 'node:test';
import assert from 'node:assert/strict';
import {loadPage,makePage,installStorage,installScanner,startGateway,sseHeaders,sseFrame,runEvent,settingsFor} from './page-harness.mjs';
const def=await loadPage();

test('real page accepts a streamed chart and removes machine payload from reply',async t=>{
 const id='chart_run';const output='Three measured values. <visual>{"type":"chart","points":[1,2,3],"caption":"Sample 1-3: volts"}</visual>';
 const gw=await startGateway(async(req,res,r)=>{
  if(req.method==='POST'&&r.path==='/v1/runs'){res.writeHead(202,{'content-type':'application/json'}).end(JSON.stringify({run_id:id,status:'started'}));return;}
  if(req.method==='GET'&&r.path===`/v1/runs/${id}/events`){sseHeaders(res);res.write(sseFrame(1,runEvent(id,1,'message.delta',{delta:output})));res.write(sseFrame(2,runEvent(id,2,'run.completed',{output})));res.end();return;}
  res.writeHead(404).end('{}');
 });t.after(()=>gw.close());installStorage({'hermes.settings':settingsFor(gw.base)});installScanner();const page=makePage(def);page.onLoad({});
 await page.send('Explain the three measured values');assert.equal(page.data.visualType,'chart');assert.equal(page.data.visualCaption,'Sample 1-3: volts');assert.deepEqual(page.data.visualPoints,[{x:0,value:1},{x:1,value:2},{x:2,value:3}]);assert.equal(page.data.answer,'Three measured values.');
});

test('real page accepts a streamed formula and never stores its wire payload as spoken text',async t=>{
 const id='visual_run'; const output='Energy equals mass times light speed squared. <visual>{"type":"formula","tex":"E=mc^2"}</visual>';
 const gw=await startGateway(async(req,res,r)=>{
  if(req.method==='POST'&&r.path==='/v1/runs'){res.writeHead(202,{'content-type':'application/json'}).end(JSON.stringify({run_id:id,status:'started'}));return;}
  if(req.method==='GET'&&r.path===`/v1/runs/${id}/events`){sseHeaders(res);res.write(sseFrame(1,runEvent(id,1,'message.delta',{delta:output})));res.write(sseFrame(2,runEvent(id,2,'run.completed',{output})));res.end();return;}
  res.writeHead(404).end('{}');
 });t.after(()=>gw.close());
 installStorage({'hermes.settings':settingsFor(gw.base)});installScanner();const page=makePage(def);page.onLoad({});
 await page.send('show the energy equation');
 assert.equal(page.data.visualType,'formula');assert.equal(page.data.visualFormula,'E=mc^2');
 assert.equal(page.data.answer,'Energy equals mass times light speed squared.');
 assert.doesNotMatch(page.data.answer,/<visual>/);
});
