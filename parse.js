// Canopy Ranger — line parser.
// Turns the Ranger firmware's human-readable lines (firmware/src/ranger/main.cpp,
// onResult / startSurvey / finishSurvey / STATUS) into events. The firmware is
// the source of truth: if its wording changes, change these patterns with it.
// Shared by the app (browser) and parse.test.js (node).

(function (root) {
  'use strict';

  const SURVEY_TAIL = String.raw`(?:\s+\[(.+) (\d+)\/(\d+)\])?\s*$`;

  const RE = {
    ping:    new RegExp(String.raw`^#(\d+)\s+SNR\s+([+-]?\d+)\s+(GOOD|MARGINAL|POOR)\s+\((-?\d+) dBm\)` + SURVEY_TAIL),
    miss:    new RegExp(String.raw`^#(\d+)\s+no reply` + SURVEY_TAIL),
    start:   /^>> Surveying (.+?) — hold still, (\d+) pings/,
    summary: /^== (.+?): (GOOD|MARGINAL|POOR|NO LINK) — (\d+)\/(\d+) heard(?:, worst SNR ([+-]?\d+), average ([+-]?\d+))?/,
    status:  /\| heard (\d+)\/(\d+) \| spots (\d+) \| batt ([\d.]+) V/,
    hello:   /^CANOPY RANGER (\S+) \| ([\d.]+) MHz SF(\d+) \| (pinging|paused)/,
    thresholds: /^SNR ([+-]?\d+) or better GOOD, ([+-]?\d+) to ([+-]?\d+) MARGINAL, below ([+-]?\d+) POOR/,
    warn:    /^! (.*)$/,
  };

  function survey(m, i) {
    return m[i] ? { name: m[i], n: +m[i + 1], of: +m[i + 2] } : null;
  }

  function parseLine(line) {
    line = line.replace(/[\r\n]+$/, '');
    let m;
    if ((m = RE.ping.exec(line)))
      return { kind: 'ping', seq: +m[1], heard: true, snr: +m[2], verdict: m[3], rssi: +m[4], survey: survey(m, 5) };
    if ((m = RE.miss.exec(line)))
      return { kind: 'ping', seq: +m[1], heard: false, snr: null, verdict: 'NO LINK', rssi: null, survey: survey(m, 2) };
    if ((m = RE.start.exec(line)))
      return { kind: 'start', name: m[1], samples: +m[2] };
    if ((m = RE.summary.exec(line)))
      return { kind: 'summary', name: m[1], verdict: m[2], heard: +m[3], sent: +m[4],
               snrWorst: m[5] != null ? +m[5] : null, snrAvg: m[6] != null ? +m[6] : null };
    if ((m = RE.status.exec(line)))
      return { kind: 'status', heard: +m[1], sent: +m[2], spots: +m[3], batt: +m[4] };
    if ((m = RE.hello.exec(line)))
      return { kind: 'hello', fw: m[1], mhz: +m[2], sf: +m[3], pinging: m[4] === 'pinging' };
    if ((m = RE.thresholds.exec(line)))
      return { kind: 'thresholds', good: +m[1], marginal: +m[2] };
    if ((m = RE.warn.exec(line)))
      return { kind: 'warn', text: m[1] };
    return { kind: 'other', text: line };
  }

  // BLE notifications arrive in 20-byte chunks that can split a line, or a
  // multi-byte character like the em dash. Feed raw bytes in, get whole lines out.
  function LineSplitter() {
    const dec = new TextDecoder('utf-8');
    let buf = '';
    return function push(bytes) {
      buf += dec.decode(bytes, { stream: true });
      const parts = buf.split(/\r?\n/);
      buf = parts.pop();
      return parts.filter(l => l.length > 0);
    };
  }

  // Spot names travel as "MARK name" and come back in LIST as CSV, so keep
  // them to what the firmware stores (15 chars) and nothing CSV-breaking.
  function cleanName(s) {
    return (s || '').trim().replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 15);
  }

  function distanceM(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 +
              Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  const api = { parseLine, LineSplitter, cleanName, distanceM };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RangerParse = api;
})(this);
