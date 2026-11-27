import test from 'node:test';
import assert from 'node:assert/strict';
import { askImage } from '../lib/image-turn.js';
const cfg={HERMES_URL:'http://test',HERMES_KEY:'not-real',CONVERSATION:'test'};
function storage(){let m=new Map();globalThis.localStorage={getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,v)}}
test('image requests set a long explicit timeout',async()=>{storage();let old=globalThis.fetch;let options;globalThis.fetch=async(_url,opts)=>{options=opts;return {ok:true,text:async()=>JSON.stringify({choices:[{finish_reason:'stop',message:{content:'No image'}}]})}};try{await askImage(cfg,'show photo');assert.equal(options.timeout,600000)}finally{globalThis.fetch=old}});
test('truncated generation keeps safe prose but rejects partial image',async()=>{storage();let old=globalThis.fetch;globalThis.fetch=async()=>({ok:true,text:async()=>JSON.stringify({choices:[{finish_reason:'length',message:{content:'Partial reply. ![image](data:image/png;base64,AAAA'}}]})});try{let r=await askImage(cfg,'show photo');assert.equal(r.text,'Partial reply.');assert.equal(r.image,null);assert.match(r.reason,/incomplete/)}finally{globalThis.fetch=old}});
test('normal transcript content is never accepted as byte delivery',async()=>{storage();let old=globalThis.fetch;globalThis.fetch=async()=>({ok:true,text:async()=>JSON.stringify({choices:[{finish_reason:'stop',message:{content:'Sorry, no image available.'}}]})});try{const r=await askImage(cfg,'show photo');assert.equal(r.image,null);assert.match(r.reason,/could not be delivered/)}finally{globalThis.fetch=old}});
