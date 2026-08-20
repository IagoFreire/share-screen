import { createServer } from "node:http";
import { createApp } from "./app.js";
import { attachWebSocketServer } from "./ws/wsServer.js";
import { config } from "./config.js";

const app = createApp();
const httpServer = createServer(app);
attachWebSocketServer(httpServer);

httpServer.listen(config.port, () => {
  console.log(
    `ScreenShare-Bot server listening on port ${config.port} (${config.nodeEnv}), public origin: ${config.publicOrigin}`,
  );
});
