// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Connect to agent-browser's Chrome; CDP supplies cache controls and precise timing.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WebSocket } from 'ws';
import Database from 'better-sqlite3';

const [manifestPath, outputDir, mode = 'local', repeatsArg = '5'] = process.argv.slice(2);
const base = process.env.STARTUP_BENCH_URL || 'http://127.0.0.1:8010';
const batchSnapshot = process.env.STARTUP_BENCH_BATCH === '1';
if (new URL(base).hostname !== '127.0.0.1') throw new Error('Benchmark only on loopback');
if (!manifestPath || !outputDir || !['local', 'slow', 'profile'].includes(mode)) {
  throw new Error(
    'Usage: node tools/startup-bench/browser.mjs MANIFEST OUTPUT_DIR [local|slow|profile] [repeats=5]',
  );
}
const { dir, accounts } = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (!path.basename(dir).startsWith('lurker-startup-') || !path.isAbsolute(dir)) {
  throw new Error('Only a disposable startup fixture may be benchmarked');
}
const db = new Database(path.join(dir, 'bench.db'), { fileMustExist: true });
fs.mkdirSync(outputDir, { recursive: true });
const endpoint = execFileSync('agent-browser', ['--session', 'startup', 'get', 'cdp-url'], {
  encoding: 'utf8',
}).trim();
const targets = await (
  await fetch(`${endpoint.replace(/^ws:/, 'http:').split('/devtools/')[0]}/json/list`)
).json();
const target = targets.find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve) => ws.once('open', resolve));
let nextId = 0;
const pending = new Map();
const events = new Map();
ws.on('message', (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.id) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  } else events.get(message.method)?.(message.params);
});
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 60_000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(expression) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await sleep(50);
  }
  throw new Error(
    `Readiness timeout: ${expression}; ${await evaluate('document.body.innerText.slice(0, 700)')}`,
  );
}

function instrument(expectedBuffers, batchInitialFrames) {
  const b = (window.startupBenchmark = { marks: {}, longTasks: [], wsBytes: 0, expectedBuffers });
  const mark = (name) => {
    if (b.marks[name] == null) {
      b.marks[name] = performance.now();
      performance.mark(`bench:${name}`);
    }
  };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries())
      b.longTasks.push({ start: e.startTime, duration: e.duration });
  }).observe({ type: 'longtask', buffered: true });
  const Original = window.WebSocket;
  window.WebSocket = new Proxy(Original, {
    construct(Target, args) {
      mark('wsConstruct');
      const socket = new Target(...args);
      // Diagnostic ablation only: same initial frames, delivered in one JS task.
      // This is not a proposed production implementation (no timeout/reconnect policy).
      if (batchInitialFrames) {
        let queue = [];
        let collecting = true;
        socket.addEventListener('message', (event) => {
          if (!collecting || !event.isTrusted) return;
          event.stopImmediatePropagation();
          queue.push(event.data);
          if (event.data.includes('"kind":"backlog-complete"')) {
            collecting = false;
            for (const data of queue) socket.dispatchEvent(new MessageEvent('message', { data }));
            queue = [];
          }
        });
      }
      socket.addEventListener('open', () => mark('wsOpen'));
      socket.addEventListener('message', ({ data }) => {
        if (typeof data !== 'string') return;
        b.wsBytes += data.length;
        mark('wsFirstFrame');
        if (data.includes('"kind":"backlog-complete"')) {
          mark('snapshotReceived');
          scheduleCheck();
        }
        if (data.includes('"kind":"history"')) mark('historyReceived');
      });
      return socket;
    },
  });
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.target.closest('.channels li')) mark('channelClick');
    },
    true,
  );
  let scheduled = false;
  function scheduleCheck() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (document.querySelector('.buffer-list')) mark('appMounted');
      if (
        b.marks.snapshotReceived &&
        document.querySelectorAll('.channels li').length === expectedBuffers
      )
        mark('sidebarReady');
      if (
        b.marks.channelClick &&
        document.querySelector('.message-list')?.textContent.includes('Benchmark message')
      ) {
        mark('historyDOM');
        // A second animation frame provides a paint opportunity, not proof of pixel presentation.
        requestAnimationFrame(() => mark('historyPaintOpportunity'));
      }
      if (b.marks.channelClick && document.querySelector('textarea:not(:disabled)'))
        mark('composerReady');
    });
  }
  new MutationObserver(scheduleCheck).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
  });
}

const results = [];
let initId;
try {
  await cdp('Page.enable');
  await cdp('Network.enable');
  await cdp('Network.setBypassServiceWorker', { bypass: true });
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 720,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await cdp('Emulation.setCPUThrottlingRate', { rate: mode === 'slow' ? 4 : 1 });
  await cdp('Network.emulateNetworkConditions', {
    offline: false,
    latency: mode === 'slow' ? 100 : 0,
    downloadThroughput: mode === 'slow' ? 200_000 : -1,
    uploadThroughput: mode === 'slow' ? 100_000 : -1,
  });
  for (const account of accounts) {
    if (
      process.env.STARTUP_BENCH_BUFFERS &&
      !process.env.STARTUP_BENCH_BUFFERS.split(',').includes(String(account.buffers))
    )
      continue;
    if (process.env.STARTUP_BENCH_DEPTH && process.env.STARTUP_BENCH_DEPTH !== account.depth)
      continue;
    if (mode === 'profile' && (account.depth !== 'deep' || account.buffers === 100)) continue;
    if (initId) await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: initId });
    ({ identifier: initId } = await cdp('Page.addScriptToEvaluateOnNewDocument', {
      source: `(${instrument.toString()})(${account.buffers}, ${batchSnapshot})`,
    }));
    await cdp('Network.setCookie', {
      name: 'lurker_session',
      value: account.cookie,
      url: base,
      httpOnly: true,
      sameSite: 'Lax',
    });
    for (let repeat = 0; repeat < Number(repeatsArg); repeat++) {
      for (const cache of ['cold', 'warm']) {
        await cdp('Page.navigate', { url: 'about:blank' });
        await sleep(100);
        // Opening the channel advances its read pointer; restore the same input each run.
        const pointer =
          account.depth === 'deep'
            ? 0
            : db
                .prepare(
                  "SELECT id FROM messages WHERE buffer_id = ? AND type = 'message' ORDER BY id LIMIT 1 OFFSET 1979",
                )
                .get(account.firstBufferId).id;
        db.prepare(
          'UPDATE buffer_reads SET last_read_message_id = ? WHERE user_id = ? AND buffer_id = ?',
        ).run(pointer, account.userId, account.firstBufferId);
        if (cache === 'cold') await cdp('Network.clearBrowserCache');
        const label = `${mode}-${account.buffers}-${account.depth}-${repeat}-${cache}`;
        let traceEvents = [];
        if (mode === 'profile') {
          events.set('Tracing.dataCollected', ({ value }) => traceEvents.push(...value));
          await cdp('Tracing.start', {
            categories:
              'devtools.timeline,v8.execute,blink.user_timing,disabled-by-default-v8.cpu_profiler',
            transferMode: 'ReportEvents',
          });
          await fetch('http://127.0.0.1:8010/__bench/profile/start', { method: 'POST' });
        }
        await cdp('Page.navigate', { url: `${base}/` });
        await until('window.startupBenchmark?.marks.sidebarReady');
        const point = await evaluate(
          `(() => { const e = [...document.querySelectorAll('.channels li')].find(e => e.textContent.includes('bench-0000')); const r = e.getBoundingClientRect(); return { x: r.x + 30, y: r.y + r.height / 2 }; })()`,
        );
        await cdp('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          button: 'left',
          clickCount: 1,
          ...point,
        });
        await cdp('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          button: 'left',
          clickCount: 1,
          ...point,
        });
        await until(
          'window.startupBenchmark?.marks.historyPaintOpportunity && window.startupBenchmark?.marks.composerReady',
        );
        await sleep(100);
        const sample = await evaluate(
          `({ ...window.startupBenchmark, resources: performance.getEntriesByType('resource').map(e => ({name: new URL(e.name).pathname, start: e.startTime, end: e.responseEnd, transfer: e.transferSize, encoded: e.encodedBodySize, decoded: e.decodedBodySize})), navigation: performance.getEntriesByType('navigation')[0].toJSON(), paints: performance.getEntriesByType('paint').map(e => ({name:e.name, at:e.startTime})), domNodes: document.querySelectorAll('*').length })`,
        );
        results.push({
          label,
          base,
          batchSnapshot,
          buffers: account.buffers,
          depth: account.depth,
          cache,
          repeat,
          ...sample,
        });
        fs.writeFileSync(path.join(outputDir, `${mode}.json`), JSON.stringify(results, null, 2));
        console.log(
          `${label}: sidebar=${sample.marks.sidebarReady.toFixed(0)}ms channel=${(sample.marks.historyPaintOpportunity - sample.marks.channelClick).toFixed(0)}ms longTasks=${sample.longTasks.length}`,
        );
        if (mode === 'profile') {
          const server = await (
            await fetch('http://127.0.0.1:8010/__bench/profile/stop', { method: 'POST' })
          ).json();
          fs.writeFileSync(
            path.join(outputDir, `${label}.cpuprofile`),
            JSON.stringify(server.profile),
          );
          const complete = new Promise((resolve) => events.set('Tracing.tracingComplete', resolve));
          await cdp('Tracing.end');
          await complete;
          fs.writeFileSync(
            path.join(outputDir, `${label}.trace.json`),
            JSON.stringify({ traceEvents }),
          );
          console.log(`Profile event-loop max: ${server.eventLoopMaxMs.toFixed(1)}ms`);
        }
        // Keep repeated successful navigations below the real 60/min auth limit.
        await sleep(1100);
      }
    }
  }
} finally {
  if (initId) await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: initId });
  await cdp('Emulation.setCPUThrottlingRate', { rate: 1 });
  await cdp('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  ws.close();
  db.close();
}
