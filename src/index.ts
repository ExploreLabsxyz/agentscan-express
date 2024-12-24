import express, { Express } from "express";
import { createServer } from "http";
import { config } from "./config";
import { redis } from "./initalizers/redis";

import cors from "cors";
import { pool } from "./initalizers/postgres";
import privy from "./initalizers/privy";

import { getUsersByIds } from "./services/user";

import dotenv from "dotenv";
import { Socket } from "socket.io";
import { amplitudeClient } from "./initalizers/amplitude";
import { initializeDiscord } from "./initalizers/discord";
import { initializeTelegram } from "./initalizers/telegram";

dotenv.config();

export async function createApp(): Promise<Express> {
  const app = express();
  
  app.use(express.json({ limit: "15mb" }));
  app.use(express.urlencoded({ limit: "10mb", extended: true }));
  
  app.use(cors());
  
  app.use("/", require("./routes").default);
  
  return app;
}

async function initServer(): Promise<void> {
  const app = await createApp();
  const httpServer = createServer(app);
  
  amplitudeClient;
  httpServer.listen(config.server.port, () => {
    console.log(`Server running on port ${config.server.port}`);
  });
  await initializeDiscord();

  try {
    await initializeTelegram();
    console.log("Telegram initialization completed successfully");
  } catch (error) {
    console.error("Failed to initialize Telegram:", error);
  }
}

initServer().catch(console.error);
