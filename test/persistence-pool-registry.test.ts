import { test } from "node:test";
import assert from "node:assert/strict";
import { sharedPgPool } from "../src/persistence/pg-pool.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "requires DATABASE_URL";

test("sharedPgPool memoizes one pool per connection string and refcounts close", { skip }, async () => {
  const a = sharedPgPool(URL!, ["SELECT 1"]);
  const b = sharedPgPool(URL!, ["SELECT 1"]);
  assert.equal(a, b, "same connection string returns the same PgPool");
  const c = sharedPgPool("postgres://other.invalid/x", []);
  assert.notEqual(a, c);
  await a.close();
  await b.query("SELECT 1");
  await b.close();
  await assert.rejects(() => b.query("SELECT 1"));
});

test("sharedPgPool accumulates DDL from later callers on the same connection string", { skip }, async () => {
  const first = sharedPgPool(URL!, ["CREATE TABLE IF NOT EXISTS shared_registry_t1(id TEXT PRIMARY KEY)"]);
  await first.query("SELECT 1");
  const second = sharedPgPool(URL!, ["CREATE TABLE IF NOT EXISTS shared_registry_t2(id TEXT PRIMARY KEY)"]);
  assert.equal(first, second, "same memoized pool");
  await second.query("INSERT INTO shared_registry_t2(id) VALUES ('x')");
  await first.query("DROP TABLE IF EXISTS shared_registry_t1, shared_registry_t2");
  await first.close();
  await second.close();
});
