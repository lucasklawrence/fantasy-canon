/**
 * The draft dashboard page, served at `/`. One self-contained HTML string — inline CSS + vanilla JS,
 * no framework, no build step, no external assets — so it works offline and drops straight into the
 * Discord Activity iframe once the proxy mapping is wired (ADR 0005).
 *
 * Transport is **WebSocket** (`/api/ws`), the only push channel that survives the Activity proxy
 * sandbox; it falls back to polling `/api/state` if the socket drops. A small manual-entry form
 * (`POST /api/pick`) makes the board usable standalone for mock-draft testing. The client script uses
 * string concatenation (no backticks / no ${…}) so it lives in this outer template literal cleanly.
 *
 * NEXT PHASE (ADR 0005): before this renders inside Discord it needs the Embedded App SDK handshake
 * (ready → authorize → server-side token exchange → authenticate) and API/WS calls routed through the
 * `/.proxy` prefix. That adapter is deliberately out of this scaffold; here the board runs in dev
 * mode against the local backend.
 */
export const BOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Draft Dashboard</title>
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
  .entry { grid-column: 1 / -1; display: flex; gap: 8px; flex-wrap: wrap; }
  .entry input { flex: 1; min-width: 180px; padding: 9px 12px; border-radius: 9px; border: 1px solid #2a3145;
    background: #10141d; color: #e7e9ee; font-size: 14px; }
  .entry button { padding: 9px 14px; border-radius: 9px; border: 1px solid #2a3145; background: #1b2233;
    color: #cdd4e4; font-size: 13px; font-weight: 600; cursor: pointer; }
  .entry button.ghost { background: transparent; color: #8b93a9; }
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
  <h1>Draft Dashboard</h1>
  <span id="status" class="pill">connecting…</span>
  <div class="clock" id="clock"></div>
</header>
<main>
  <form class="entry" id="entry">
    <input id="playerName" type="text" placeholder="Enter the next pick — player name…" autocomplete="off" />
    <button type="submit">Add pick</button>
    <button type="button" class="ghost" id="reset">Reset</button>
  </form>
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

  function fill(id, items, mk, emptyText) {
    var node = document.getElementById(id);
    clear(node);
    if (!items || items.length === 0) { node.appendChild(el("div", "empty", emptyText)); return; }
    items.forEach(function (it) { node.appendChild(mk(it)); });
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
      head.appendChild(el("span", "name", " " + c.name));
      head.appendChild(el("span", "tag " + c.recommend, " " + c.recommend));
      rec.appendChild(head);
      rec.appendChild(el("div", "meta", [tierStr(c), adpStr(c), "VONA " + c.vona].filter(Boolean).join(" · ")));
      rec.appendChild(el("div", "reason", c.reason));
    } else {
      rec.appendChild(el("div", "empty", "No players left on the board."));
    }

    fill("alts", v.alternatives, candRow, "No alternatives.");
    fill("byneed", (v.byNeed || []).map(function (x) { return x.candidate; }), candRow, "Skill starters filled.");

    var needs = document.getElementById("needs");
    clear(needs);
    if (!v.needs || v.needs.length === 0) {
      needs.appendChild(el("span", "need none", "Skill starters set"));
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
      recent.appendChild(el("div", "empty", "No picks entered yet."));
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
    bits.push("updated " + new Date(state.updatedAt).toLocaleTimeString());
    meta.textContent = bits.join("  ·  ");
  }

  // --- transport: WebSocket push, with a polling fallback if the socket drops ---
  var pollTimer = null;
  function poll() {
    fetch("/api/state", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(render)
      .catch(function () { setStatus("backend offline", "err"); });
  }
  function startPolling() { if (!pollTimer) { poll(); pollTimer = setInterval(poll, 2000); } }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  function connect() {
    poll(); // paint immediately from the current state, don't wait for the first push
    var proto = location.protocol === "https:" ? "wss://" : "ws://";
    var ws;
    try { ws = new WebSocket(proto + location.host + "/api/ws"); }
    catch (e) { startPolling(); return; }
    ws.onopen = function () { stopPolling(); };
    ws.onmessage = function (ev) {
      try { render(JSON.parse(ev.data)); } catch (e) { /* ignore malformed frame */ }
    };
    ws.onclose = function () { startPolling(); setTimeout(connect, 3000); };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  // --- manual entry (POST /api/pick) — makes the board usable standalone for mock-draft testing ---
  document.getElementById("entry").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var input = document.getElementById("playerName");
    var name = input.value.trim();
    if (!name) return;
    fetch("/api/pick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerName: name })
    }).then(function () { input.value = ""; input.focus(); poll(); })
      .catch(function () { setStatus("could not add pick", "err"); });
  });
  document.getElementById("reset").addEventListener("click", function () {
    fetch("/api/reset", { method: "POST" }).then(poll).catch(function () {});
  });

  connect();
})();
</script>
</body>
</html>`;
