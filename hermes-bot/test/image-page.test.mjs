import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, makePage, installStorage, settingsFor, startGateway, readStore } from './page-harness.mjs';
import { wantsImage, safeReply } from '../lib/image-turn.js';

const def = await loadPage();
const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]).toString('base64');

test('explicit visual questions route correctly and paths are hidden', () => {
  assert.equal(wantsImage('Show me a photo of a robot'), true);
  assert.equal(wantsImage('Plot a graph of y squared'), false);
  assert.equal(wantsImage('Show an image of a graph'), true);
  assert.equal(wantsImage('Explain the equation'), false);
  assert.doesNotMatch(safeReply('Here\nMEDIA:C:\\private\\image.png'), /private/);
});

test('actual page receives gateway image, draws and keeps bytes out of history', async t => {
  const gw = await startGateway((req,res) => res.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:`Here it is. ![image](data:image/png;base64,${png})`}}]})));
  t.after(()=>gw.close());
  const store=installStorage({'hermes.settings':settingsFor(gw.base)});
  const calls=[];
  globalThis.__wx.createCanvasContext=()=>({clearRect(){},drawImage(){calls.push('draw')},flush(){calls.push('flush')}});
  globalThis.createImageBitmap=async()=>({width:100,height:50,close(){calls.push('close')}});
  const page=makePage(def);page.onLoad({});await page.send('Show a picture of a robot');
  assert.equal(page.data.visualType,'image');
  assert.equal(page.status, null, 'image turns do not claim a streaming run status');
  assert.deepEqual(calls,['draw','flush','close']);
  assert.equal(gw.requests[0].path,'/v1/chat/completions');
  assert.equal(gw.requests[0].headers['x-hermes-session-id'],'rokid-glasses-test');
  assert.equal(gw.requests[0].body.stream,false);
  assert.doesNotMatch(JSON.stringify(readStore(store,'hermes.history')),/base64|iVBOR/);
});

test('failed byte delivery is explicit and never speaks a path', async t => {
  const gw=await startGateway((req,res)=>res.writeHead(200).end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'Here\nMEDIA:C:\\secret\\x.png'}}]})));
  t.after(()=>gw.close());installStorage({'hermes.settings':settingsFor(gw.base)});
  globalThis.createImageBitmap=async()=>({});
  const page=makePage(def);page.onLoad({});await page.send('Show a picture');
  assert.equal(page.data.visualType,'');assert.match(page.data.answer,/could not be delivered/);assert.doesNotMatch(page.data.answer,/secret/);
});

test('legacy conversation never silently forks',async()=>{
  let calls=0;const old=globalThis.fetch;globalThis.fetch=async()=>{calls++;throw Error('unexpected')};
  try {
    installStorage({'hermes.settings':settingsFor('http://localhost'), 'hermes.history':{conversations:[{id:'rokid-glasses-test',turns:[{q:'hi',a:'hi',at:1}],updated:1}]}});
    globalThis.createImageBitmap=async()=>({});const p=makePage(def);p.onLoad({});await p.send('Show a picture');
    assert.match(p.data.error,/regular reply first/);assert.equal(calls,0);
  } finally { globalThis.fetch=old; }
});
