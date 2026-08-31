import { config } from "./config.js";
import { buildServer } from "./server.js";
import { startTurnWorker } from "./workers/turn.js";
import { startFollowupWorker } from "./workers/followups.js";
import { startSweepWorker } from "./workers/sweep.js";

const app = buildServer();

await app.listen({ port: config.port, host: "0.0.0.0" });

// Single-process for now. Split the workers onto their own dyno when inbound
// volume starts competing with webhook latency.
startTurnWorker();
startFollowupWorker();
startSweepWorker();
