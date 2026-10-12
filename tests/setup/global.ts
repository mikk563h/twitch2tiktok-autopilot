import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import EmbeddedPostgres from "embedded-postgres";
import { RedisMemoryServer } from "redis-memory-server";
import type { TestProject } from "vitest/node";

/** Real PostgreSQL + Redis for integration tests (no Docker needed). */
export default async function setup(project: TestProject) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t2t-test-"));
  const port = 55000 + Math.floor(Math.random() * 2000);
  const pg = new EmbeddedPostgres({ databaseDir: path.join(root, "pg"), user: "t2t", password: "t2t", port, persistent: false, onLog: () => {}, onError: () => {} });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("t2t_test");
  const redis = await RedisMemoryServer.create();
  project.provide("databaseUrl", `postgres://t2t:t2t@127.0.0.1:${port}/t2t_test`);
  project.provide("redisUrl", `redis://${await redis.getHost()}:${await redis.getPort()}`);
  project.provide("dataDir", path.join(root, "data"));
  return async () => {
    await redis.stop();
    await pg.stop();
    fs.rmSync(root, { recursive: true, force: true });
  };
}

declare module "vitest" {
  export interface ProvidedContext { databaseUrl: string; redisUrl: string; dataDir: string }
}
