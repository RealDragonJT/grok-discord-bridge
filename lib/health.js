'use strict';
// Pure gateway health logic (no discord.js import) so it can be unit-tested offline.
// bot.js feeds it a snapshot of the gateway every HEALTH_INTERVAL_MS; it says whether to keep going or exit
// (exit code EXIT_UNHEALTHY lets the supervisor (Docker restart policy, systemd, or scripts/run-forever.sh) restart the bridge immediately).

const STATUS_NAMES = ['READY', 'CONNECTING', 'RECONNECTING', 'IDLE', 'NEARLY', 'DISCONNECTED', 'WAITING_FOR_GUILDS', 'IDENTIFYING', 'RESUMING'];
const statusName = (n) => (typeof n === 'number' && STATUS_NAMES[n]) || (n === undefined || n === null ? 'NONE' : String(n));

const EXIT_UNHEALTHY = 75; // EX_TEMPFAIL: "gateway unhealthy, restart me right away"

const DEFAULTS = {
  intervalMs: 30000,
  jumpMs: 60000,          // wall-clock gap between ticks that means "box was suspended / process was frozen"
  consecutive: 2,         // bad ticks in a row before exiting
  loginGraceMs: 120000,   // time allowed for the very first login before "not ready" counts
  settleMs: 90000,        // after (re)entering READY, wait this long before judging ping / heartbeat acks
  ackStaleMs: 120000,     // heartbeat is ~41s; no ack for this long while READY == dead socket
  wakeVerifyMs: 45000,    // after a clock jump, a fresh heartbeat ack / event must show up within this long
};

const validPing = (p) => typeof p === 'number' && Number.isFinite(p) && p >= 0;

class HealthMonitor {
  constructor(opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.lastTick = null;
    this.badNotReady = 0;
    this.badPing = 0;
    this.badAck = 0;
    this.wake = null; // { at, gapMs } while waiting for the gateway to prove itself after a clock jump
  }

  reset() { this.lastTick = null; this.badNotReady = this.badPing = this.badAck = 0; this.wake = null; }

  // snap: { hasClient, status: 'READY'|..., ping, ackAt, lastEventAt, readyAt, connectStartedAt, everReady }
  // returns { action: 'ok'|'exit', reasons: [...], notes: [...] }
  tick(now, snap) {
    const notes = []; const reasons = [];
    const gap = this.lastTick === null ? 0 : now - this.lastTick;
    this.lastTick = now;
    if (!snap.hasClient) { this.badNotReady = this.badPing = this.badAck = 0; this.wake = null; return { action: 'ok', reasons, notes }; }

    if (gap > this.o.jumpMs) {
      this.wake = { at: now, gapMs: gap };
      notes.push(`clock jumped ${Math.round(gap / 1000)}s between health ticks (expected ${Math.round(this.o.intervalMs / 1000)}s): box suspended or process frozen; verifying gateway`);
    }

    const ready = snap.status === 'READY';
    const inLoginGrace = !snap.everReady && snap.connectStartedAt && now - snap.connectStartedAt < this.o.loginGraceMs;
    this.badNotReady = (!ready && !inLoginGrace) ? this.badNotReady + 1 : 0;
    if (this.badNotReady) reasons.push(`ws_status=${snap.status} (${this.badNotReady}/${this.o.consecutive})`);

    const settled = ready && snap.readyAt && now - snap.readyAt > this.o.settleMs;
    this.badPing = (settled && !validPing(snap.ping)) ? this.badPing + 1 : 0;
    if (this.badPing) reasons.push(`ws_ping=${snap.ping} (${this.badPing}/${this.o.consecutive})`);

    const ackAge = snap.ackAt ? now - snap.ackAt : Infinity;
    this.badAck = (settled && ackAge > this.o.ackStaleMs) ? this.badAck + 1 : 0;
    if (this.badAck) reasons.push(`no heartbeat ack for ${ackAge === Infinity ? 'ever' : Math.round(ackAge / 1000) + 's'} (${this.badAck}/${this.o.consecutive})`);

    let wakeFailed = false;
    if (this.wake) {
      const fresh = Math.max(snap.ackAt || 0, snap.lastEventAt || 0) >= this.wake.at;
      if (ready && fresh) { notes.push(`gateway verified healthy after clock jump (fresh heartbeat/event ${Math.round((now - Math.max(snap.ackAt || 0, snap.lastEventAt || 0)) / 1000)}s ago)`); this.wake = null; }
      else if (now - this.wake.at >= this.o.wakeVerifyMs) { wakeFailed = true; reasons.push(`gateway not verified healthy ${Math.round((now - this.wake.at) / 1000)}s after clock jump`); }
    }

    const c = this.o.consecutive;
    const exit = wakeFailed || this.badNotReady >= c || this.badPing >= c || this.badAck >= c;
    return { action: exit ? 'exit' : 'ok', reasons, notes };
  }
}

module.exports = { HealthMonitor, STATUS_NAMES, statusName, EXIT_UNHEALTHY, DEFAULTS, validPing };
