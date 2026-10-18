// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Disposable standalone server using the real HTTP/WS/IRC paths, not production data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { Session } from 'node:inspector/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { sign } from 'cookie-signature';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-startup-'));
// Runs on normal exit and Ctrl-C/service stop; all contents belong to this run.
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.env.DATABASE_PATH = path.join(dir, 'bench.db');
process.env.SESSION_SECRET = 'disposable-startup-benchmark';
process.env.LURKER_EDITION = 'standalone';
process.env.LURKER_SNAPSHOT_SLOW_MS = '0';
process.env.LURKER_ENGINE_URL = '';
const { default: db } = await import('../../server/db/index.js');
const { createUser } = await import('../../server/db/users.js');
const { createNetwork } = await import('../../server/db/networks.js');
const { createSession } = await import('../../server/db/sessions.js');
const { insertMessage } = await import('../../server/db/messages.js');
const { setReadState } = await import('../../server/db/bufferReads.js');
const { setAutojoin } = await import('../../server/db/buffers.js');

// Minimal loopback IRC peer. No public network, messages, previews, or uploads.
const ircd = net.createServer((socket) => {
  let pending = '';
  let nick = 'bench';
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    pending += chunk.toString();
    while (pending.includes('\n')) {
      const end = pending.indexOf('\n');
      const line = pending.slice(0, end).trim();
      pending = pending.slice(end + 1);
      const [command, ...args] = line.split(' ');
      if (command === 'NICK') nick = args[0]!;
      if (command === 'CAP' && args[0] === 'LS') socket.write(`:bench CAP * LS :\r\n`);
      if (command === 'USER') {
        socket.write(
          `:bench 001 ${nick} :Welcome\r\n:bench 005 ${nick} CHANTYPES=# CASEMAPPING=ascii :supported\r\n:bench 376 ${nick} :End of MOTD\r\n`,
        );
      }
      if (command === 'PING') socket.write(`PONG ${args.join(' ')}\r\n`);
      if (command === 'JOIN') {
        for (const channel of args[0]!.split(',')) {
          socket.write(
            `:${nick}!bench@localhost JOIN ${channel}\r\n:bench 353 ${nick} = ${channel} :${nick}\r\n:bench 366 ${nick} ${channel} :End of NAMES\r\n`,
          );
        }
      }
    }
  });
});
await new Promise<void>((resolve) => ircd.listen(0, '127.0.0.1', resolve));
const ircPort = (ircd.address() as net.AddressInfo).port;
const accounts = [];
for (const buffers of [10, 100, 500]) {
  for (const depth of ['shallow', 'deep']) {
    const user = createUser(`bench${buffers}${depth}`);
    const network = createNetwork(user.id, {
      name: 'Benchmark',
      host: '127.0.0.1',
      port: ircPort,
      tls: false,
      nick: 'bench',
      autoconnect: false,
    })!;
    let firstBufferId = 0;
    db.transaction(() => {
      for (let b = 0; b < buffers; b++) {
        const target = `#bench-${String(b).padStart(4, '0')}`;
        let pointer = 0;
        for (let m = 0; m < 2000; m++) {
          const row = insertMessage({
            networkId: network.id,
            target,
            time: new Date(Date.UTC(2026, 9, 1) + m * 60_000).toISOString(),
            type: 'message',
            nick: `person${m % 30}`,
            text: `Benchmark message ${m}: deterministic plain text for startup measurements.`,
            self: false,
            replyToSelf: m % 100 === 0,
          });
          if (b === 0) firstBufferId = row.bufferId;
          if (m === 1979) pointer = Number(row.id);
        }
        if (depth === 'shallow') setReadState(user.id, network.id, target, pointer);
        // Only the first channel needs membership for the composer check.
        if (b === 0) setAutojoin(user.id, network.id, target, true);
      }
    })();
    const { token } = createSession(user.id);
    accounts.push({
      buffers,
      depth,
      userId: user.id,
      networkId: network.id,
      firstBufferId,
      cookie: `s:${sign(token, process.env.SESSION_SECRET)}`,
    });
    console.log(`Seeded ${buffers} buffers, ${depth} unread`);
  }
}
db.pragma('wal_checkpoint(TRUNCATE)');
const { buildApp } = await import('../../server/app.js');
const { attachWsHub } = await import('../../server/services/wsHub.js');
await import('../../server/services/verbs/index.js');
const { default: manager } = await import('../../server/services/ircManager.js');
const app = buildApp(process.env.SESSION_SECRET);
const profile = new Session();
profile.connect();
const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
// Loopback-only benchmark controls. The manifest contains disposable cookies.
app.post('/__bench/profile/start', async (_req, res) => {
  await profile.post('Profiler.enable');
  await profile.post('Profiler.start');
  delay.reset();
  res.json({ ok: true });
});
app.post('/__bench/profile/stop', async (_req, res) => {
  const result = await profile.post('Profiler.stop');
  res.json({ profile: result.profile, eventLoopMaxMs: delay.max / 1e6 });
});
const server = http.createServer(app);
attachWsHub(server, process.env.SESSION_SECRET);
for (const account of accounts) manager.startNetwork(account.userId, account.networkId);
await new Promise<void>((resolve) => server.listen(8010, '127.0.0.1', resolve));
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ dir, accounts }), {
  mode: 0o600,
});
console.log(`BENCH_MANIFEST=${path.join(dir, 'manifest.json')}`);
console.log('Benchmark server listening on loopback port 8010');
