import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPage, makePage, installStorage, settingsFor, startGateway, sseHeaders, sseFrame, runEvent, waitFor, delay } from './page-harness.mjs';

const def = await loadPage();
function mic() {
  const instances = [];
  globalThis.SpeechRecognition = class {
    constructor() { instances.push(this); }
    start() {}
    abort() { this.aborted = true; }
    stop() { this.onend?.(); }
    words(text) { this.onresult?.({ results: [[{ transcript: text }]], resultIndex: 0 }); }
    finish() { this.onend?.(); }
  };
  return instances;
}
async function setup(t) {
  let release;
  const gate = new Promise(r => { release = r; });
  const gw = await startGateway(async (req, res, record) => {
    if (record.path === '/v1/runs' && req.method === 'POST') {
      const id = 'r' + gw.requests.filter(x => x.path === '/v1/runs').length;
      res.writeHead(202, {'content-type':'application/json'}).end(JSON.stringify({run_id:id,status:'started'})); return;
    }
    if (record.path.endsWith('/events')) {
      const id = record.path.split('/')[3];
      sseHeaders(res); res.write(': open\n\n');
      if (id === 'r1') await gate;
      res.write(sseFrame(0, runEvent(id,0,'run.completed',{output:'answer',completed:true}))); res.end(); return;
    }
    if (record.path.endsWith('/stop')) { res.writeHead(200).end('{}'); return; }
    res.writeHead(404).end('{}');
  });
  t.after(async () => { release(); await gw.close(); });
  installStorage({'hermes.settings':settingsFor(gw.base)});
  const instances = mic();
  const page = makePage(def); page.onLoad({});
  const first = page.send('first');
  await waitFor(() => gw.requests.some(x => x.path.endsWith('/events')));
  page.primaryAction();
  return {page,instances,first,release,gw};
}

test('swipe discards queued capture and next tap opens microphone again', async t => {
  const {page,instances,first,release} = await setup(t);
  assert.equal(page.queueListening,true);
  page.flipPage(1);
  assert.equal(page.queueListening,false);
  assert.equal(instances[0].aborted,true);
  page.primaryAction();
  assert.equal(instances.length,2);
  page.stopListening(true); release(); await first;
});

test('cancelling while capturing stops the microphone and drops the queued words', async t => {
  const {page,instances,first,release,gw} = await setup(t);
  instances[0].words('do not send');
  page.cancelRequest();
  release(); await first;
  assert.equal(instances[0].aborted,true);
  assert.equal(page.queueListening,false);
  assert.deepEqual(page.queue,[]);
  assert.equal(gw.requests.filter(x => x.path === '/v1/runs').length,1);
});

test('reply arriving during capture waits, then sends queued question', async t => {
  const {page,instances,first,release,gw} = await setup(t);
  instances[0].words('second');
  release();
  await delay(100);
  assert.equal(page.queueListening,true);
  assert.equal(page.data.state,'thinking');
  instances[0].finish();
  await first;
  await waitFor(() => gw.requests.filter(x => x.path === '/v1/runs').length === 2);
  const requests = gw.requests.filter(x => x.path === '/v1/runs');
  assert.deepEqual(requests.map(x => x.body.input),['first','second']);
  await waitFor(() => page.data.state === 'idle');
});
