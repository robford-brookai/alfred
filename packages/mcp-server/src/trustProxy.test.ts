import assert from "node:assert/strict";
import test from "node:test";

import { resolveTrustProxy } from "./trustProxy.js";

test("defaults to the single Caddy hop", () => {
  assert.equal(resolveTrustProxy(undefined, true), 1);
});
test("accepts bounded hop counts", () => {
  assert.equal(resolveTrustProxy("0", true), 0);
  assert.equal(resolveTrustProxy("2", true), 2);
  assert.throws(() => resolveTrustProxy("6", true), /bounded integer/);
});
test("production rejects permissive trust values", () => {
  assert.throws(() => resolveTrustProxy("true", true), /Unsafe TRUST_PROXY_HOPS/);
  assert.throws(() => resolveTrustProxy("0.0.0.0/0", true), /Unsafe TRUST_PROXY_HOPS/);
});
test("development fails closed instead of enabling permissive trust", () => {
  assert.equal(resolveTrustProxy("true", false), 0);
});