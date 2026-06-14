import { createServer, type Server } from "node:http";
import { logger } from "./pkg/logger.js";
import { libsql } from "./db/client.js";
import { mastra } from "./mastra/index.js";

const log = logger.child({ mod: "server" });
const PORT = Number(process.env.PORT ?? 8080);

/**
 * Single-process entry point (ROADMAP §2): eventually hosts the Mastra/admin
 * HTTP server, the grammY bot, and the cron scheduler. For now it is a minimal
 * health server that proves the process boots and libSQL/Mastra are wired.
 */
function main(): void {
  // Touch the Mastra instance so storage/vector are constructed at boot.
  void mastra;

  const server: Server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "jarvis" }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  server.listen(PORT, () => log.info({ port: PORT }, "jarvis server started"));

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "graceful shutdown");
    server.close(() => {
      libsql.close();
      log.info("shutdown complete");
      process.exit(0);
    });
    // Safety net if connections don't drain in time.
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
