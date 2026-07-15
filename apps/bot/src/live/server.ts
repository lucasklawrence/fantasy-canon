/**
 * The localhost dashboard for the live draft advisor. A tiny `node:http` server that binds to
 * 127.0.0.1 only and serves two things: the single-page UI at `/` and the current {@link AdviceView}
 * as JSON at `/state`, which the page polls once a second and re-renders. No framework, no build
 * step, no external assets — the page is one inline HTML string so it works offline mid-draft.
 *
 * Display-only and local by construction: it never talks to ESPN and exposes nothing but the
 * advisor state the runner hands it via `getState`. It is the read-side twin of the read-only
 * capture — together they let you watch "best available" update without touching the ESPN tab.
 */

import http from 'node:http';
import type { AdviceView } from './advice.js';

/** What the runner exposes to the page each tick. */
export interface ServeState {
  /** The current projection, or undefined before the first successful read. */
  view?: AdviceView;
  /** Human status line, e.g. "watching draft", "waiting for the draft to start", "capture error". */
  status: string;
  /** ISO timestamp of the last update (stamped by the runner). */
  updatedAt: string;
  /** The ESPN tab URL the capture is attached to, for display/confirmation. */
  source?: string;
}

export interface AdviceServerHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** What to send for a request — a pure value so routing is testable without a real socket. */
export interface HttpReply {
  status: number;
  contentType: string;
  body: string;
}

/**
 * Route one request URL to its reply. Pure: `/state` serializes the current {@link ServeState},
 * `/` serves the dashboard page, anything else 404s. This is the whole server minus the transport,
 * so it's unit-tested directly (no port, no `fetch`, no lingering sockets).
 */
export function routeRequest(url: string, getState: () => ServeState): HttpReply {
  if (url === '/state') {
    return { status: 200, contentType: 'application/json', body: JSON.stringify(getState()) };
  }
  if (url === '/' || url.startsWith('/?') || url === '/index.html') {
    return { status: 200, contentType: 'text/html; charset=utf-8', body: PAGE_HTML };
  }
  return { status: 404, contentType: 'text/plain; charset=utf-8', body: 'not found' };
}

/**
 * Start the dashboard. `getState` is called fresh on every `/state` request so the page always sees
 * the latest projection. Resolves once bound; binds to 127.0.0.1 (never the network).
 */
export function startAdviceServer(
  getState: () => ServeState,
  opts: { port?: number; host?: string } = {},
): Promise<AdviceServerHandle> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 4599;

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reply = routeRequest(req.url ?? '/', getState);
      res.statusCode = reply.status;
      res.setHeader('Content-Type', reply.contentType);
      res.setHeader('Cache-Control', 'no-store');
      res.end(reply.body);
    });

    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const boundPort = address && typeof address === 'object' ? address.port : port;
      resolve({
        url: `http://${host}:${boundPort}/`,
        port: boundPort,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

// The dashboard page. One self-contained string: inline CSS + vanilla JS that polls /state. The
// client script deliberately uses string concatenation (no backticks / no ${…}) so this file can
// hold it in a template literal without escaping games.
const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Live Draft Advisor</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0f1115; color: #e7e9ee; }
  header { padding: 14px 20px; border-bottom: 1px solid #222634; display: flex; align-items: center;
    gap: 14px; flex-wrap: wrap; position: sticky; top: 0; background: #0f1115; z-index: 5; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; letter-spacing: .2px; color: #aab2c5; }
  .pill { font-size: 12px; padding: 3px 9px; border-radius: 999px; background: #1b2130; color: #9aa4bd; }
  .pill.live { background: #113526; color: #4ade80; }
  .pill.err { background: #3a1620; color: #f87171; }
  .clock { margin-left: auto; font-size: 13px; color: #9aa4bd; text-align: right; }
  .clock b { color: #e7e9ee; }
  main { max-width: 1100px; margin: 0 auto; padding: 18px 20px 48px; display: grid;
    grid-template-columns: 1fr 300px; gap: 18px; }
  @media (max-width: 860px) { main { grid-template-columns: 1fr; } }
  .turn { grid-column: 1 / -1; padding: 12px 16px; border-radius: 12px; background: #151a24;
    border: 1px solid #222634; font-size: 14px; color: #b9c1d4; }
  .turn.mine { background: #12261b; border-color: #1f5138; color: #d6ffe6; }
  .turn b { color: #fff; }
  section { background: #141821; border: 1px solid #212636; border-radius: 12px; padding: 14px 16px; }
  section h2 { margin: 0 0 10px; font-size: 12px; text-transform: uppercase; letter-spacing: .8px;
    color: #7c869e; font-weight: 600; }
  .rec { border-color: #2b3550; background: linear-gradient(180deg,#182034,#141821); }
  .rec .name { font-size: 26px; font-weight: 700; }
  .rec .meta { color: #9aa4bd; font-size: 14px; margin-top: 2px; }
  .rec .reason { margin-top: 8px; font-size: 14px; color: #cdd4e4; }
  .row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-top: 1px solid #1c2130; }
  .row:first-of-type { border-top: 0; }
  .row .nm { font-weight: 600; }
  .row .sub { color: #7c869e; font-size: 12px; margin-left: auto; text-align: right; }
  .pos { font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 5px; background: #232a3b;
    color: #aeb7cd; min-width: 30px; text-align: center; }
  .pos.RB { background: #12332a; color: #5be6b1; } .pos.WR { background: #142b3c; color: #6cc6ff; }
  .pos.QB { background: #331d2c; color: #ff8fc0; } .pos.TE { background: #33290f; color: #f2b955; }
  .tag { font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 999px; }
  .tag.value { background: #123322; color: #4ade80; } .tag.reach { background: #33260f; color: #fbbf24; }
  .tag.wait { background: #21283a; color: #93a0bd; }
  .side { display: flex; flex-direction: column; gap: 18px; }
  .badges { display: flex; flex-wrap: wrap; gap: 6px; }
  .need { font-size: 12px; font-weight: 700; padding: 3px 8px; border-radius: 6px; background: #33260f;
    color: #fbbf24; }
  .need.none { background: #123322; color: #4ade80; }
  .recent .row { font-size: 13px; padding: 5px 0; }
  .recent .ov { color: #7c869e; min-width: 34px; font-variant-numeric: tabular-nums; }
  .recent .row.mine .nm { color: #7ee7ad; }
  .empty { color: #6b7590; font-size: 14px; padding: 8px 0; }
  footer { max-width: 1100px; margin: 0 auto; padding: 0 20px 30px; color: #5c657d; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>Live Draft Advisor</h1>
  <span id="status" class="pill">connecting…</span>
  <div class="clock" id="clock"></div>
</header>
<main>
  <div class="turn" id="turn"></div>
  <section class="rec" id="rec-wrap" style="grid-column:1 / -1">
    <h2>Recommended pick</h2>
    <div id="rec"></div>
  </section>
  <section>
    <h2>Alternatives</h2>
    <div id="alts"></div>
  </section>
  <div class="side">
    <section>
      <h2>Fill a need</h2>
      <div id="byneed"></div>
    </section>
    <section>
      <h2>Your roster</h2>
      <div class="badges" id="needs" style="margin-bottom:10px"></div>
      <div id="roster"></div>
    </section>
  </div>
  <section class="recent" style="grid-column:1 / -1">
    <h2>Recent picks</h2>
    <div id="recent"></div>
  </section>
</main>
<footer id="meta"></footer>
<script>
(function () {
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function adpStr(c) { return c.adp != null ? "ADP " + Math.round(c.adp) : "no ADP"; }
  function tierStr(c) { return c.tier != null ? "Tier " + c.tier : ""; }

  function candRow(c) {
    var r = el("div", "row");
    r.appendChild(el("span", "pos " + c.position, c.position));
    r.appendChild(el("span", "nm", c.name));
    r.appendChild(el("span", "tag " + c.recommend, c.recommend));
    var sub = [tierStr(c), adpStr(c)].filter(Boolean).join(" · ");
    r.appendChild(el("span", "sub", sub));
    return r;
  }

  function setStatus(text, kind) {
    var s = document.getElementById("status");
    s.textContent = text;
    s.className = "pill" + (kind ? " " + kind : "");
  }

  function render(state) {
    var v = state.view;
    if (!v) {
      setStatus(state.status || "waiting", "err");
      document.getElementById("turn").textContent = state.status || "Waiting for the draft…";
      return;
    }
    setStatus(v.complete ? "draft complete" : (state.status || "watching draft"), "live");

    var clock = document.getElementById("clock");
    clear(clock);
    var line1 = el("div");
    line1.innerHTML = "Round <b>" + v.round + "</b> · Pick <b>" + v.pickInRound + "</b> · Overall <b>" + v.currentOverall + "</b>";
    clock.appendChild(line1);
    clock.appendChild(el("div", null, v.remaining + " players left · pool " + v.poolSize));

    var turn = document.getElementById("turn");
    clear(turn);
    turn.className = "turn" + (v.isMyPick ? " mine" : "");
    if (v.isMyPick) {
      turn.innerHTML = "<b>You're on the clock</b> — pick " + v.currentOverall + ".";
    } else {
      var until = v.picksUntilMine;
      var nextTxt = v.myNextOverall != null
        ? "Your next pick: overall <b>" + v.myNextOverall + "</b>" + (until != null ? " (in " + until + " pick" + (until === 1 ? "" : "s") + ")" : "")
        : "No more picks for you.";
      turn.innerHTML = "Slot <b>" + v.onTheClockSlot + "</b> on the clock. " + nextTxt;
    }

    var rec = document.getElementById("rec");
    clear(rec);
    if (v.recommended) {
      var c = v.recommended;
      var head = el("div");
      head.appendChild(el("span", "pos " + c.position, c.position));
      var nm = el("span", "name", " " + c.name);
      head.appendChild(nm);
      head.appendChild(el("span", "tag " + c.recommend, " " + c.recommend));
      rec.appendChild(head);
      rec.appendChild(el("div", "meta", [tierStr(c), adpStr(c), "VONA " + c.vona].filter(Boolean).join(" · ")));
      rec.appendChild(el("div", "reason", c.reason));
    } else {
      rec.appendChild(el("div", "empty", "No players left on the board."));
    }

    fill("alts", v.alternatives, candRow, "No alternatives.");
    fill("byneed", (v.byNeed || []).map(function (x) { return x.candidate; }), candRow, "Starters filled.");

    var needs = document.getElementById("needs");
    clear(needs);
    if (!v.needs || v.needs.length === 0) {
      needs.appendChild(el("span", "need none", "Starters set"));
    } else {
      v.needs.forEach(function (p) { needs.appendChild(el("span", "need", p)); });
    }

    var roster = document.getElementById("roster");
    clear(roster);
    if (!v.myRoster || v.myRoster.length === 0) {
      roster.appendChild(el("div", "empty", "No picks yet."));
    } else {
      v.myRoster.forEach(function (spot) {
        var r = el("div", "row");
        r.appendChild(el("span", "pos " + spot.position, spot.position));
        r.appendChild(el("span", "nm", spot.name));
        r.appendChild(el("span", "sub", "#" + spot.overall));
        roster.appendChild(r);
      });
    }

    var recent = document.getElementById("recent");
    clear(recent);
    if (!v.recentPicks || v.recentPicks.length === 0) {
      recent.appendChild(el("div", "empty", "No picks captured yet."));
    } else {
      v.recentPicks.forEach(function (p) {
        var r = el("div", "row" + (p.mine ? " mine" : ""));
        r.appendChild(el("span", "ov", "#" + p.overall));
        r.appendChild(el("span", "nm", p.name));
        r.appendChild(el("span", "sub", "slot " + p.slot));
        recent.appendChild(r);
      });
    }

    var meta = document.getElementById("meta");
    var bits = [];
    if (v.adp) bits.push("ADP " + v.adp.asOf + " (" + v.adp.sampleSize + " drafts)");
    if (state.source) bits.push("source " + state.source);
    bits.push("updated " + new Date(state.updatedAt).toLocaleTimeString());
    meta.textContent = bits.join("  ·  ");
  }

  function fill(id, items, mk, emptyText) {
    var node = document.getElementById(id);
    clear(node);
    if (!items || items.length === 0) { node.appendChild(el("div", "empty", emptyText)); return; }
    items.forEach(function (it) { node.appendChild(mk(it)); });
  }

  function tick() {
    fetch("/state", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(render)
      .catch(function () { setStatus("advisor offline", "err"); });
  }

  setInterval(tick, 1200);
  tick();
})();
</script>
</body>
</html>`;
