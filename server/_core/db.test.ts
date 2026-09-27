import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDB } from "./db";

// db.ts 在模块加载时就按 env.dbDriver 建 driver。两个 driver 都 mock 掉，于是这个
// 测试问的是"atomic 把语句交给了谁"，而不是"能不能连上库"。
const batch = vi.fn(async (qs: unknown[]) => qs.map(() => []));
const transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({ tx: true }));

vi.mock("@neondatabase/serverless", () => ({ neon: () => ({}) }));
vi.mock("drizzle-orm/neon-http", () => ({ drizzle: () => ({ batch }) }));
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: () => ({ transaction }) }));
const poolConfigs: Record<string, unknown>[] = [];
vi.mock("pg", () => ({
  default: {
    Pool: class {
      constructor(config: Record<string, unknown>) {
        poolConfigs.push(config);
      }
      on() {}
    },
  },
}));

async function loadWith(driver: "http" | "tcp", dbPoolMax = 5) {
  vi.resetModules();
  poolConfigs.length = 0;
  vi.doMock("./env", () => ({
    env: { dbDriver: driver, databaseUrl: "postgres://x", dbPoolMax },
  }));
  return await import("./db");
}

beforeEach(() => {
  batch.mockClear();
  transaction.mockClear();
});

describe("atomic", () => {
  it("http: 一个 batch —— 一个 HTTP 请求里的服务端事务", async () => {
    const { atomic } = await loadWith("http");
    await atomic((() => ["q1", "q2"]) as never);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0][0]).toEqual(["q1", "q2"]);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("tcp: 真事务，且 builder 绑在 tx 上而不是 db 上", async () => {
    const { atomic } = await loadWith("tcp");
    const seen: unknown[] = [];
    await atomic(((d: unknown) => {
      seen.push(d);
      return [Promise.resolve("r1")];
    }) as never);
    expect(transaction).toHaveBeenCalledTimes(1);
    // 这一条是这个测试存在的理由：build 收到 db 的话语句就跑在事务外面，
    // 名字叫 atomic 而行为不是 —— 比直接报错更糟。
    expect(seen[0]).toEqual({ tx: true });
    expect(batch).not.toHaveBeenCalled();
  });
});

// 类型层禁令，不是运行时测试：这个函数体从不会被调用（下面只 `void` 它，不执行它），
// 纯粹是给 tsc 检查用的。一旦 AppDB 的 Omit 漏掉 "transaction" 或 "batch" 中的任何一个，
// 对应那行 @ts-expect-error 就会因为"没有错误可抑制"而报错，pnpm typecheck 就会失败——
// 这是防止 `batch`（只存在于 http 驱动）在另一个方法上重演 `transaction`
// （只存在于 tcp 驱动）那种 dev 编译通过、prod 运行时 TypeError 的分裂。
function _typeOnlyBannedMethodsStayBanned(appDb: AppDB) {
  // @ts-expect-error transaction only exists on the tcp driver — banned from AppDB, see db.ts
  appDb.transaction;
  // @ts-expect-error batch only exists on the http driver — banned from AppDB, see db.ts
  appDb.batch;
}
void _typeOnlyBannedMethodsStayBanned;

// The pool is BOUNDED on purpose. On the platform each app has its own database
// on ONE shared Postgres cluster, so the ceiling that matters is (apps under
// active iteration x max) — node-postgres' default of 10 is sized for an app
// that owns its server, and a handful of them exhausts the cluster's slots.
describe("tcp pool", () => {
  it("caps connections at env.dbPoolMax", async () => {
    await loadWith("tcp", 3);
    expect(poolConfigs).toHaveLength(1);
    expect(poolConfigs[0].max).toBe(3);
    expect(poolConfigs[0].connectionString).toBe("postgres://x");
  });

  it("opens no pool at all on http", async () => {
    await loadWith("http");
    expect(poolConfigs).toHaveLength(0);
  });
});
