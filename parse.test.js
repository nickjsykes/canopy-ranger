// node --test ranger-app/parse.test.js   — lines copied from the formats in firmware/src/ranger/main.cpp
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLine, LineSplitter, cleanName, distanceM } = require('./parse.js');

test('ping, heard', () => {
  assert.deepEqual(parseLine('#12  SNR -3  GOOD  (-112 dBm)'),
    { kind: 'ping', seq: 12, heard: true, snr: -3, verdict: 'GOOD', rssi: -112, survey: null });
});

test('ping, positive SNR, during a survey', () => {
  const e = parseLine('#40  SNR +7  GOOD  (-88 dBm)  [trap3 4/10]');
  assert.equal(e.snr, 7);
  assert.deepEqual(e.survey, { name: 'trap3', n: 4, of: 10 });
});

test('ping, no reply, during a magnet survey', () => {
  const e = parseLine('#41  no reply  [SPOT_2 5/10]');
  assert.equal(e.heard, false);
  assert.equal(e.verdict, 'NO LINK');
  assert.deepEqual(e.survey, { name: 'SPOT_2', n: 5, of: 10 });
});

test('survey start and summary (em dash)', () => {
  assert.deepEqual(parseLine('>> Surveying trap3 — hold still, 10 pings (~50 s)'),
    { kind: 'start', name: 'trap3', samples: 10 });
  assert.deepEqual(parseLine('== trap3: MARGINAL — 9/10 heard, worst SNR -6, average -2'),
    { kind: 'summary', name: 'trap3', verdict: 'MARGINAL', heard: 9, sent: 10, snrWorst: -6, snrAvg: -2 });
  assert.deepEqual(parseLine('== SPOT_1: NO LINK — 0/10 heard'),
    { kind: 'summary', name: 'SPOT_1', verdict: 'NO LINK', heard: 0, sent: 10, snrWorst: null, snrAvg: null });
});

test('status, hello, warning', () => {
  assert.deepEqual(parseLine('868.000 MHz SF10 22 dBm | pinging | heard 30/31 | spots 2 | batt 3.98 V'),
    { kind: 'status', heard: 30, sent: 31, spots: 2, batt: 3.98 });
  assert.equal(parseLine('CANOPY RANGER 3.0.0 | 868.000 MHz SF10 | pinging').sf, 10);
  assert.equal(parseLine('! TX failed — check the antenna').kind, 'warn');
  assert.equal(parseLine('spot,verdict,heard,sent,snr_worst,snr_avg,rssi_avg').kind, 'other');
});

test('thresholds line (HELP output, %+.0f formatting)', () => {
  assert.deepEqual(parseLine('SNR -5 or better GOOD, -10 to -5 MARGINAL, below -10 POOR'),
    { kind: 'thresholds', good: -5, marginal: -10 });
  assert.equal(parseLine('SNR +0 or better GOOD, -5 to +0 MARGINAL, below -5 POOR').good, 0);
});

test('splitter rejoins lines and em dashes cut across 20-byte chunks', () => {
  const push = LineSplitter();
  const bytes = new TextEncoder().encode('== trap3: GOOD — 10/10 heard, worst SNR +5, average +7\r\n#5  no reply\r\n');
  const out = [];
  for (let i = 0; i < bytes.length; i += 20) out.push(...push(bytes.slice(i, i + 20)));
  assert.equal(out.length, 2);
  assert.equal(parseLine(out[0]).snrWorst, 5);
  assert.equal(parseLine(out[1]).heard, false);
});

test('cleanName fits the firmware and stays CSV-safe', () => {
  assert.equal(cleanName(' trap 3, oak '), 'trap_3_oak');
  assert.equal(cleanName('a-very-long-spot-name'), 'a-very-long-spo');
});

test('distance', () => {
  // ~111 m per 0.001 deg latitude
  const d = distanceM({ lat: 54.25, lon: -3.0 }, { lat: 54.251, lon: -3.0 });
  assert.ok(Math.abs(d - 111.2) < 1, d);
});
