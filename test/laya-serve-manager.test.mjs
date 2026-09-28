import test from "node:test";
import assert from "node:assert/strict";
import { manageLayaServe, LAYA_SERVE_LOG } from "../src/laya-serve-manager.mjs";

const okFetch = async () => ({ ok: true });
const downFetch = async () => ({ ok: false });
const fakeChild = () => ({ pid: 999999, unref() {} });

test("an already-healthy laya-serve is left alone", async () => {
  let spawned = false;
  const result = await manageLayaServe({
    host: "127.0.0.1",
    port: "8000",
    autostart: true,
    fetchFn: okFetch,
    spawnFn: () => {
      spawned = true;
      return fakeChild();
    },
  });
  assert.deepEqual(result, { managed: false });
  assert.equal(spawned, false, "a healthy instance must never be spawned over");
});

test("an unhealthy instance with autostart disabled is reported unavailable, not spawned", async () => {
  let spawned = false;
  const result = await manageLayaServe({
    host: "127.0.0.1",
    port: "8000",
    autostart: false,
    fetchFn: downFetch,
    spawnFn: () => {
      spawned = true;
      return fakeChild();
    },
  });
  assert.deepEqual(result, { managed: false, unavailable: true });
  assert.equal(spawned, false);
});

test("an unhealthy instance with autostart spawns once and waits for health", async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    return { ok: calls >= 3 };
  };
  let spawnCalls = 0;
  const result = await manageLayaServe({
    host: "127.0.0.1",
    port: "8000",
    autostart: true,
    pollIntervalMs: 1,
    startupTimeoutMs: 5000,
    fetchFn,
    spawnFn: () => {
      spawnCalls += 1;
      return fakeChild();
    },
  });
  assert.equal(spawnCalls, 1);
  assert.equal(result.managed, true);
  assert.equal(typeof result.stop, "function");
  assert.doesNotThrow(() => result.stop());
});

test("a spawn that never becomes healthy throws, naming the log file", async () => {
  await assert.rejects(
    manageLayaServe({
      host: "127.0.0.1",
      port: "8000",
      autostart: true,
      startupTimeoutMs: 0,
      fetchFn: downFetch,
      spawnFn: () => fakeChild(),
    }),
    (err) => {
      assert.match(err.message, /laya-serve did not become healthy/);
      assert.ok(err.message.includes(LAYA_SERVE_LOG));
      return true;
    },
  );
});
