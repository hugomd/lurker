# First-load benchmark

Run with **Node 24**, root/client dependencies installed, `agent-browser` with
Chromium, and optionally Caddy. This measures a production client against the
real Express routes, WebSocket hub, SQLite queries and IRC connection code.
It does not benchmark process startup, migrations, or real IRC registration.

## Run

```sh
npm run client:build
amp orb service start startup-bench --command 'node --import tsx tools/startup-bench/fixture.ts'
amp orb service logs startup-bench --lines 20
```

Wait for `BENCH_MANIFEST=...` (seeding takes about two minutes). Set `MANIFEST`
to that printed path. The fixture creates a new temporary database, never uses
`data/`, and only connects to its own loopback IRC peer. It seeds six accounts:
10/100/500 channels, each with 2,000 messages, and either 20 or 2,000 unread
messages per channel. One percent of messages carry the reply-to-self highlight
stamp. Only the first channel is joined; the others are open historical buffers.
There is one network per account, no media, and no large member lists.

The manifest contains disposable session credentials: **do not publish it or
the database**. Stop the fixture normally to remove its temporary directory.
Do not expose these benchmark services through a portal or public proxy.

```sh
agent-browser --session startup open about:blank
agent-browser --session startup set viewport 1280 720 2
node tools/startup-bench/browser.mjs "$MANIFEST" /tmp/startup-results local 5
node tools/startup-bench/browser.mjs "$MANIFEST" /tmp/startup-results profile 1
```

`local` measures unthrottled loopback; `slow` uses CDP's 4× CPU slowdown,
100 ms network latency, 200,000 bytes/sec download and 100,000 bytes/sec upload.
Each repetition clears the HTTP cache for the cold load, then loads again with
the warmed cache. It does **not** clear OS/SQLite caches, restart Chrome, or
simulate DNS/TLS. Service workers are bypassed. The first channel's read pointer
is restored before each sample, since opening it changes server state.

The runner waits for the snapshot terminator and the expected sidebar row count,
then uses a real pointer click to open `#bench-0000`. It checks that fixture
messages rendered and the composer is enabled. A second animation frame marks a
paint opportunity, not a guarantee of pixels reaching a physical display.
Navigation, resources, WebSocket milestones, long tasks and DOM counts are saved
to JSON. Failed readiness checks abort instead of recording a successful sample.
Runs are paced below the real authentication rate limit. Do not run multiple
benchmark drivers or builds/tests concurrently.

`profile` captures separate Node `.cpuprofile` files and Chrome `.trace.json`
files for 10/500-buffer deep-unread accounts. Open these in DevTools' Performance
panel. Profiled timings are diagnostic, not interchangeable with baseline
timings. The server also logs snapshot phase timings (`LURKER_SNAPSHOT_SLOW_MS=0`).

## Compressed delivery and diagnostic controls

The repository's deployment Caddyfile enables gzip; direct Express does not.
Measure both rather than attributing uncompressed delivery to every deployment:

```sh
amp orb service start startup-gzip --command 'caddy run --config tools/startup-bench/Caddyfile'
STARTUP_BENCH_URL=http://127.0.0.1:8011 \
  node tools/startup-bench/browser.mjs "$MANIFEST" /tmp/startup-gzip slow 3
```

Two optional **diagnostic ablations**, not production fixes:

- `STARTUP_BENCH_BATCH=1` delivers the initial WebSocket frames together in one
  JavaScript task. This tests repeated reactive processing costs, but trades
  progressive rendering for a larger task and lacks production timeout/reconnect
  handling. Compare long tasks as well as readiness times.
- Port `8012` uses gzip and substitutes the existing `favicon-32.png` for both
  large favicon requests. Compare it with port `8011` to isolate transfer cost.

Use `STARTUP_BENCH_BUFFERS=10,500` and `STARTUP_BENCH_DEPTH=deep` to narrow the
matrix. Use a different output directory for each control; a run replaces its
mode's JSON file. Keep the browser session dedicated to this benchmark.

```sh
agent-browser --session startup close
amp orb service stop startup-gzip
amp orb service stop startup-bench
```

For non-orb use, run the fixture and Caddy in foreground terminals instead of
`amp orb service`. Small sample sets support medians and observed ranges, not
reliable p95/p99 estimates. These synthetic results do not establish real-device
or production-fleet latency.
