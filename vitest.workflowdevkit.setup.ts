import { execSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import type { ChildProcess } from "node:child_process";

import "dotenv/config";

let nitroServer: ChildProcess | null = null;

const PORT = "4000";

export async function setup() {
  // Build the project first so nitro can use compiled dist/
  // eslint-disable-next-line no-console
  console.log("Building project before starting Nitro server...");
  execSync("npm run build", { stdio: "inherit" });

  // eslint-disable-next-line no-console
  console.log("Starting Nitro server for workflow execution...");

  // Start nitro dev server with inherited environment variables
  nitroServer = spawn("npx", ["nitro", "dev", "--port", PORT], {
    stdio: "pipe",
    detached: false,
    cwd: "test-server",
    // eslint-disable-next-line node/no-process-env
    env: process.env,
  });

  // Use a promise to wait for server readiness
  const serverReadyPromise = new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), 15000);

    // Listen for server output
    nitroServer?.stdout?.on("data", (data) => {
      const output = data.toString();
      // eslint-disable-next-line no-console
      console.log("[nitro]", output);

      if (output.includes("listening") || output.includes("ready") || output.includes("Nitro")) {
        clearTimeout(timeout);
        resolve(true);
      }
    });

    nitroServer?.stderr?.on("data", (data) => {
      console.error("[nitro]", data.toString());
    });

    nitroServer?.on("error", (error) => {
      console.error("Failed to start Nitro server:", error);
      clearTimeout(timeout);
      resolve(false);
    });
  });

  await serverReadyPromise;

  // Give it an extra moment to fully initialize
  await delay(2000);

  // eslint-disable-next-line no-console
  console.log("Nitro server started and ready for workflow execution");

  // Set the base URL and data dir for local workflow execution
  // eslint-disable-next-line node/no-process-env
  process.env.WORKFLOW_LOCAL_BASE_URL = `http://localhost:${PORT}`;
  // eslint-disable-next-line node/no-process-env
  process.env.WORKFLOW_LOCAL_DATA_DIR = "./test-server/.workflow-data";
}

export async function teardown() {
  if (nitroServer) {
    // eslint-disable-next-line no-console
    console.log("Stopping Nitro server...");
    nitroServer.kill("SIGTERM");

    // Give it a moment to shut down gracefully
    await delay(1000);

    // Force kill if still running
    if (!nitroServer.killed) {
      nitroServer.kill("SIGKILL");
    }

    nitroServer = null;
  }
}
