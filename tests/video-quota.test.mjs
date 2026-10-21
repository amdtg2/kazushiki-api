import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { allowance, monthKeyUTC, reserve, refund } from "../src/video-quota.ts";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/0001_video_review_quota.sql", import.meta.url), "utf8"));
  const env = {
    VIDEO_QUOTA_DB: {
      prepare(statement) {
        return {
          bind(...args) {
            return {
              first() {
                return db.prepare(statement).get(...args) ?? null;
              },
              run() {
                return db.prepare(statement).run(...args);
              },
            };
          },
        };
      },
    },
  };
  return { env, db };
}

test("tier allowances are 1 free and 10 Pro", () => {
  assert.equal(allowance(false), 1);
  assert.equal(allowance(true), 10);
});

test("UTC calendar month rolls over at midnight on the first", () => {
  assert.equal(monthKeyUTC(new Date("2026-10-31T23:59:59.999Z")), "2026-10");
  assert.equal(monthKeyUTC(new Date("2026-11-01T00:00:00.000Z")), "2026-11");
});

test("free user cannot claim a second credit in one month", async () => {
  const { env, db } = fixture();
  const free = { id: "Production:free-account", tier: "free", limit: 1 };
  assert.equal(await reserve(env, free, "2026-10"), 1);
  assert.equal(await reserve(env, free, "2026-10"), null);
  assert.equal(db.prepare("SELECT used FROM video_review_quota").get().used, 1);
  db.close();
});

test("Pro has exactly ten credits per month", async () => {
  const { env, db } = fixture();
  const pro = { id: "Production:pro-account", tier: "pro", limit: 10 };
  for (let i = 1; i <= 10; i++) {
    assert.equal(await reserve(env, pro, "2026-10"), i);
  }
  assert.equal(await reserve(env, pro, "2026-10"), null);
  db.close();
});

test("upgrade from free to Pro shares the same monthly count", async () => {
  const { env, db } = fixture();
  const id = "Production:upgrade-account";
  assert.equal(await reserve(env, { id, tier: "free", limit: 1 }, "2026-10"), 1);
  for (let i = 2; i <= 10; i++) {
    assert.equal(await reserve(env, { id, tier: "pro", limit: 10 }, "2026-10"), i);
  }
  assert.equal(await reserve(env, { id, tier: "pro", limit: 10 }, "2026-10"), null);
  db.close();
});

test("failed review refunds credit without going negative", async () => {
  const { env, db } = fixture();
  const user = { id: "Production:refund-account", tier: "free", limit: 1 };
  assert.equal(await reserve(env, user, "2026-10"), 1);
  await refund(env, user.id, "2026-10");
  assert.equal(await reserve(env, user, "2026-10"), 1);
  db.close();
});

test("new month and other Apple accounts get separate credits", async () => {
  const { env, db } = fixture();
  const first = { id: "Production:person-a", tier: "free", limit: 1 };
  const second = { id: "Production:person-b", tier: "free", limit: 1 };
  assert.equal(await reserve(env, first, "2026-10"), 1);
  assert.equal(await reserve(env, first, "2026-10"), null);
  assert.equal(await reserve(env, first, "2026-11"), 1);
  assert.equal(await reserve(env, second, "2026-10"), 1);
  db.close();
});
