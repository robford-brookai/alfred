import { mock, describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// execFile controls all docker exec and execAsync calls
let execFileStdout = "{}";
const execFileFn = mock.fn((...args: any[]) => {
  const cb = args[args.length - 1] as Function;
  cb(null, execFileStdout, "");
});

// spawn is used by writeConfig (python3 writes config.yaml for surveyor)
const spawnFn = mock.fn(() => {
  const closeListeners: ((code: number) => void)[] = [];
  const errorListeners: ((err: Error) => void)[] = [];
  return {
    stderr: { on: mock.fn() },
    stdin: {
      write: mock.fn(),
      end: mock.fn(() => {
        // Simulate successful process exit after stdin closes
        setTimeout(() => closeListeners.forEach((cb) => cb(0)), 0);
      }),
    },
    on: mock.fn((event: string, cb: any) => {
      if (event === "close") closeListeners.push(cb);
      if (event === "error") errorListeners.push(cb);
    }),
  };
});

mock.module("node:child_process", {
  // execFileSync is imported by src/api/routes/system.ts; must be listed
  // even though these tests don't exercise the ssh-keygen surface.
  namedExports: { execFile: execFileFn, execFileSync: mock.fn(() => ""), spawn: spawnFn },
});

// node:fs mock (readConfig uses python3/execFile, but admin routes may need fs)
const fsMock = {
  readFileSync: mock.fn(() => ""),
  writeFileSync: mock.fn(() => {}),
  readdirSync: mock.fn(() => [] as any[]),
  mkdirSync: mock.fn(),
  existsSync: mock.fn(() => false),
  statSync: mock.fn(() => ({ mtimeMs: 0, isDirectory: () => false, isFile: () => false })),
  unlinkSync: mock.fn(),
  renameSync: mock.fn(),
  appendFileSync: mock.fn(),
  openSync: mock.fn(() => 0),
  readSync: mock.fn(() => 0),
  closeSync: mock.fn(),
  createReadStream: mock.fn(() => ({ pipe: mock.fn(), on: mock.fn() })),
  Dirent: class Dirent { name = ""; isFile() { return true; } isDirectory() { return false; } },
  promises: { mkdir: mock.fn(async () => undefined), writeFile: mock.fn(async () => undefined) },
};
mock.module("node:fs", {
  defaultExport: fsMock,
  namedExports: {
    readFileSync: fsMock.readFileSync,
    writeFileSync: fsMock.writeFileSync,
    readdirSync: fsMock.readdirSync,
    mkdirSync: fsMock.mkdirSync,
    existsSync: fsMock.existsSync,
    statSync: fsMock.statSync,
    unlinkSync: fsMock.unlinkSync,
    renameSync: fsMock.renameSync,
    appendFileSync: fsMock.appendFileSync,
    openSync: fsMock.openSync,
    readSync: fsMock.readSync,
    closeSync: fsMock.closeSync,
    createReadStream: fsMock.createReadStream,
    Dirent: fsMock.Dirent,
  },
});

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const { createApiServer } = await import("../src/api/server.js");

let server: http.Server;

before(async () => {
  server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function req(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; data: any }> {
  const addr = server.address() as AddressInfo;
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method,
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": String(Buffer.byteLength(payload)),
            }
          : {},
      },
      (res) => {
        let raw = "";
        res.on("data", (c: Buffer) => { raw += c.toString(); });
        res.on("end", () => {
          try { resolve({ status: res.statusCode!, data: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode!, data: raw }); }
        });
      }
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/v1/admin/agents", () => {
  it("returns the agent list", async () => {
    // readConfig uses python3 via execFile — return empty config
    execFileStdout = "{}";
    const { status, data } = await req("GET", "/api/v1/admin/agents");
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(data.agents), "agents should be an array");
    assert.ok(data.agents.length > 0, "should have at least one agent");
    assert.ok(
      data.agents.every((a: any) => a.id && a.label && a.description),
      "each agent should have id, label, description"
    );
  });

  it("includes surveyor config", async () => {
    execFileStdout = "{}";
    const { status, data } = await req("GET", "/api/v1/admin/agents");
    assert.strictEqual(status, 200);
    assert.ok(data.surveyor, "should include surveyor");
    assert.ok(typeof data.surveyor.labeler_model === "string");
  });
});

describe("GET /api/v1/admin/agents/:agentId", () => {
  it("returns 400 for an unknown agent", async () => {
    const { status, data } = await req("GET", "/api/v1/admin/agents/nonexistent-agent");
    assert.strictEqual(status, 400);
    assert.ok(data.error.message.includes("Unknown agent"));
  });

  it("returns surveyor config for the surveyor agent", async () => {
    execFileStdout = "{}";
    const { status, data } = await req("GET", "/api/v1/admin/agents/surveyor");
    assert.strictEqual(status, 200);
    assert.ok(typeof data.labeler_model === "string");
    assert.ok(typeof data.embedder_model === "string");
  });
});

describe("PATCH /api/v1/admin/agents/:agentId/model", () => {
  it("returns 400 when model field is missing", async () => {
    const { status, data } = await req(
      "PATCH",
      "/api/v1/admin/agents/main/model",
      { other: "field" }
    );
    assert.strictEqual(status, 400);
    assert.ok(data.error.message.includes("model"));
  });

  it("returns 400 when model is an empty string", async () => {
    const { status, data } = await req(
      "PATCH",
      "/api/v1/admin/agents/main/model",
      { model: "   " }
    );
    assert.strictEqual(status, 400);
  });

  it("returns 400 for unknown agent", async () => {
    const { status, data } = await req(
      "PATCH",
      "/api/v1/admin/agents/ghost-agent/model",
      { model: "anthropic/claude-opus-4" }
    );
    assert.strictEqual(status, 400);
    assert.ok(data.error.message.includes("Unknown agent"));
  });

  it("returns 200 when updating a valid agent model", async () => {
    // patchScript returns success, restart also succeeds
    execFileStdout = JSON.stringify({ ok: true, agent: "main", model: "anthropic/claude-opus-4" });
    execFileFn.mock.resetCalls();
    const { status, data } = await req(
      "PATCH",
      "/api/v1/admin/agents/main/model",
      { model: "anthropic/claude-opus-4" }
    );
    assert.strictEqual(status, 200);
    assert.ok(data.message.includes("anthropic/claude-opus-4"));
    assert.ok(data.agent?.id === "main");
  });
});

describe("POST /api/v1/agents/main/task (spawn_alfred_task)", () => {
  // Regression: the handler shelled out to the retired OpenClaw cron interface
  // (`cron add --agent/--at/--delete-after-run/--message/--announce/--channel/
  // --to/--best-effort-deliver/--no-deliver/--json`). The current Hermes CLI
  // rejects every one of those flags, so spawn_alfred_task returned HTTP 500 on
  // every tenant. These lock in the current `cron create` grammar.
  const cronArgv = () =>
    execFileFn.mock.calls
      .map((c: any) => c.arguments)
      .find((a: any) => Array.isArray(a?.[1]) && a[1].includes("cron"))?.[1] as string[] | undefined;

  it("uses `hermes -p main cron create <schedule> <prompt> --deliver`, not the retired `cron add` flags", async () => {
    execFileStdout = "Created job: abc123\n  Name: unit-test-job\n  Schedule: once in 1m";
    execFileFn.mock.resetCalls();
    const { status } = await req("POST", "/api/v1/agents/main/task", {
      task: "do the thing", announce: false, name: "unit-test-job",
    });
    assert.strictEqual(status, 202);
    const argv = cronArgv();
    assert.ok(argv, "expected an execFile call invoking the hermes cron CLI");
    assert.ok(argv!.includes("create"), "must use `cron create`");
    assert.ok(!argv!.includes("add"), "must NOT use the retired `cron add`");
    assert.ok(argv!.includes("-p") && argv![argv!.indexOf("-p") + 1] === "main", "targets `-p main`");
    assert.ok(argv!.some((x) => /^\d+m$/.test(x)), "positional duration schedule (e.g. `1m`)");
    assert.ok(argv!.includes("do the thing"), "prompt passed as a positional, not `--message`");
    // announce:false → silent local delivery
    const di = argv!.indexOf("--deliver");
    assert.ok(di >= 0 && argv![di + 1] === "local", "announce:false → `--deliver local`");
    // every retired flag must be gone
    for (const dead of [
      "--agent", "--at", "--delete-after-run", "--message",
      "--best-effort-deliver", "--announce", "--channel", "--to",
      "--no-deliver", "--json",
    ]) {
      assert.ok(!argv!.includes(dead), `retired flag ${dead} must not be passed`);
    }
  });

  it("maps an announced delivery to `--deliver <channel>:<to>`", async () => {
    execFileStdout = "Created job: x";
    execFileFn.mock.resetCalls();
    const { status } = await req("POST", "/api/v1/agents/main/task", {
      task: "hi", announce: true, channel: "telegram", to: "12345",
    });
    assert.strictEqual(status, 202);
    const argv = cronArgv();
    const di = argv!.indexOf("--deliver");
    assert.ok(di >= 0 && argv![di + 1] === "telegram:12345", "announce + to → `--deliver telegram:12345`");
  });
});
