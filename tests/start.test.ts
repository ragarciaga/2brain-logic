import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { startServer } from "../src/server/start.js";

let server: Server | undefined;

afterEach(async () => {
  const current = server;
  server = undefined;
  if (current) await new Promise<void>((resolve) => current.close(() => resolve()));
});

const app = createApp({ writer: { write: async () => ({ path: "x.md", commit: "abc" }) } });

describe("startServer", () => {
  it("binds to 127.0.0.1 when no host is given", async () => {
    server = await startServer(app, { port: 0 });
    expect((server.address() as AddressInfo).address).toBe("127.0.0.1");
  });

  it("honors the given HOST", async () => {
    server = await startServer(app, { host: "0.0.0.0", port: 0 });
    expect((server.address() as AddressInfo).address).toBe("0.0.0.0");
  });

  it("serves /health over the socket", async () => {
    server = await startServer(app, { host: "127.0.0.1", port: 0 });
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});
