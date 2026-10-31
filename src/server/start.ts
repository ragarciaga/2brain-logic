import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import type { Env, Hono } from "hono";

export interface StartOptions {
  /** Defaults to loopback so a local run is not exposed to the network. */
  host?: string;
  port: number;
}

/** Start listening and resolve once the socket is bound. */
export function startServer<E extends Env>(
  app: Hono<E>,
  { host = "127.0.0.1", port }: StartOptions,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port, hostname: host }, () =>
      resolve(server as Server),
    );
    server.once("error", reject);
  });
}
