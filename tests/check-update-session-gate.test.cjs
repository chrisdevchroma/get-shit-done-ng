'use strict';
// Unit tests for the session-gate decision function in gsd-check-update.js
// Proves that only a genuine primary session (source=startup) with a stale cache
// spawns the npm update check. All other sources (subagents, resume, clear, compact)
// are gated out at the decision layer.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

// Set GSD_TEST_MODE before requiring the hook so it exports utilities
// and does NOT execute (no spawn, no stdin, no network).
process.env.GSD_TEST_MODE = '1';
const hook = require('../hooks/gsd-check-update.js');
const { shouldRunUpdateCheck, buildChildSource } = hook;

// ── shouldRunUpdateCheck ────────────────────────────────────────────────────

describe('shouldRunUpdateCheck', () => {
  // Shared epoch values for readability
  const NOW = 1_700_000_000;
  const TTL = 3600;
  const STALE_LAST_CHECKED = NOW - TTL;       // exactly at boundary (stale)
  const FRESH_LAST_CHECKED = NOW - TTL + 1;   // one second inside cooldown (fresh)

  // ── Non-startup sources (subagent / non-primary) ──────────────────────────

  test("source='resume' → false (subagent/non-primary)", () => {
    assert.strictEqual(
      shouldRunUpdateCheck({ source: 'resume', lastCheckedEpoch: null, nowEpoch: NOW, ttlSeconds: TTL, env: {} }),
      false,
    );
  });

  test("source='clear' → false (subagent/non-primary)", () => {
    assert.strictEqual(
      shouldRunUpdateCheck({ source: 'clear', lastCheckedEpoch: null, nowEpoch: NOW, ttlSeconds: TTL, env: {} }),
      false,
    );
  });

  test("source='compact' → false (subagent/non-primary)", () => {
    assert.strictEqual(
      shouldRunUpdateCheck({ source: 'compact', lastCheckedEpoch: null, nowEpoch: NOW, ttlSeconds: TTL, env: {} }),
      false,
    );
  });

  // ── Missing / falsy source (unparseable or absent) ────────────────────────

  test('source=undefined → false (missing source → skip)', () => {
    assert.strictEqual(
      shouldRunUpdateCheck({ source: undefined, lastCheckedEpoch: null, nowEpoch: NOW, ttlSeconds: TTL, env: {} }),
      false,
    );
  });

  test('source=null → false (missing source → skip)', () => {
    assert.strictEqual(
      shouldRunUpdateCheck({ source: null, lastCheckedEpoch: null, nowEpoch: NOW, ttlSeconds: TTL, env: {} }),
      false,
    );
  });

  test("source='' → false (empty string source → skip)", () => {
    assert.strictEqual(
      shouldRunUpdateCheck({ source: '', lastCheckedEpoch: null, nowEpoch: NOW, ttlSeconds: TTL, env: {} }),
      false,
    );
  });

  // ── Genuine primary session — startup source ──────────────────────────────

  test("source='startup' + lastCheckedEpoch=null → true (never checked → stale)", () => {
    assert.strictEqual(
      shouldRunUpdateCheck({ source: 'startup', lastCheckedEpoch: null, nowEpoch: NOW, ttlSeconds: TTL, env: {} }),
      true,
    );
  });

  test("source='startup' + lastCheckedEpoch=undefined → true (never checked → stale)", () => {
    assert.strictEqual(
      shouldRunUpdateCheck({ source: 'startup', lastCheckedEpoch: undefined, nowEpoch: NOW, ttlSeconds: TTL, env: {} }),
      true,
    );
  });

  test("source='startup' + lastCheckedEpoch older than ttlSeconds → true (stale → check)", () => {
    // lastCheckedEpoch is exactly at the boundary — (now - last) === ttl → stale
    assert.strictEqual(
      shouldRunUpdateCheck({ source: 'startup', lastCheckedEpoch: STALE_LAST_CHECKED, nowEpoch: NOW, ttlSeconds: TTL, env: {} }),
      true,
    );
  });

  test("source='startup' + lastCheckedEpoch well past ttl → true (stale → check)", () => {
    assert.strictEqual(
      shouldRunUpdateCheck({ source: 'startup', lastCheckedEpoch: NOW - TTL * 10, nowEpoch: NOW, ttlSeconds: TTL, env: {} }),
      true,
    );
  });

  test("source='startup' + lastCheckedEpoch within cooldown → false (fresh → no check)", () => {
    // (now - last) < ttl → still within cooldown
    assert.strictEqual(
      shouldRunUpdateCheck({ source: 'startup', lastCheckedEpoch: FRESH_LAST_CHECKED, nowEpoch: NOW, ttlSeconds: TTL, env: {} }),
      false,
    );
  });

  test("source='startup' + lastCheckedEpoch=NaN → true (treated as stale)", () => {
    assert.strictEqual(
      shouldRunUpdateCheck({ source: 'startup', lastCheckedEpoch: NaN, nowEpoch: NOW, ttlSeconds: TTL, env: {} }),
      true,
    );
  });

  // ── GSD_OFFLINE overrides everything ─────────────────────────────────────

  test("GSD_OFFLINE truthy + source='startup' + stale cache → false (offline always wins)", () => {
    assert.strictEqual(
      shouldRunUpdateCheck({ source: 'startup', lastCheckedEpoch: null, nowEpoch: NOW, ttlSeconds: TTL, env: { GSD_OFFLINE: '1' } }),
      false,
    );
  });

  test("GSD_OFFLINE truthy + source='startup' + no cache → false", () => {
    assert.strictEqual(
      shouldRunUpdateCheck({ source: 'startup', lastCheckedEpoch: undefined, nowEpoch: NOW, ttlSeconds: TTL, env: { GSD_OFFLINE: 'true' } }),
      false,
    );
  });

  // ── Pure function proof — no env arg still works ──────────────────────────

  test('env arg defaults gracefully when omitted (no crash)', () => {
    // Passing no env should not throw; treated as empty env
    assert.strictEqual(
      shouldRunUpdateCheck({ source: 'startup', lastCheckedEpoch: null, nowEpoch: NOW, ttlSeconds: TTL }),
      true,
    );
  });
});

// ── Structural assertions ───────────────────────────────────────────────────

test('shouldRunUpdateCheck is exported from GSD_TEST_MODE exports alongside buildChildSource', () => {
  assert.strictEqual(typeof shouldRunUpdateCheck, 'function', 'shouldRunUpdateCheck must be a function');
  assert.strictEqual(typeof buildChildSource, 'function', 'buildChildSource must still be exported');
});

test('hook source file references data.source (stdin source wired into gate)', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../hooks/gsd-check-update.js'),
    'utf8',
  );
  assert.ok(
    src.includes('data.source'),
    'hook source must reference data.source — proves stdin payload source is wired into the gate',
  );
});

test('hook source file calls shouldRunUpdateCheck(', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../hooks/gsd-check-update.js'),
    'utf8',
  );
  assert.ok(
    src.includes('shouldRunUpdateCheck('),
    'hook source must call shouldRunUpdateCheck() — proves decision fn is used, not bypassed',
  );
});
