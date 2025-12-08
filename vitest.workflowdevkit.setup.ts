import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { setTimeout } from 'timers/promises';

let nitroServer: ChildProcess | null = null;

export async function setup() {
  console.log('Starting Nitro server for workflow execution...');

  // Start nitro dev server
  nitroServer = spawn('npx', ['nitro', 'dev', '--port', '3000'], {
    stdio: 'pipe',
    detached: false,
    cwd: process.cwd(),
  });

  let serverReady = false;

  // Listen for server output
  nitroServer.stdout?.on('data', (data) => {
    const output = data.toString();
    console.log('[nitro]', output);

    if (output.includes('listening') || output.includes('ready') || output.includes('Nitro')) {
      serverReady = true;
    }
  });

  nitroServer.stderr?.on('data', (data) => {
    console.error('[nitro]', data.toString());
  });

  nitroServer.on('error', (error) => {
    console.error('Failed to start Nitro server:', error);
  });

  // Wait for server to be ready (or timeout after 15 seconds)
  const startTime = Date.now();
  while (!serverReady && Date.now() - startTime < 15000) {
    await setTimeout(500);
  }

  // Give it an extra moment to fully initialize
  await setTimeout(2000);

  console.log('Nitro server started and ready for workflow execution');

  // Set the base URL for local workflow execution
  process.env.WORKFLOW_LOCAL_BASE_URL = 'http://localhost:3000';
}

export async function teardown() {
  if (nitroServer) {
    console.log('Stopping Nitro server...');
    nitroServer.kill('SIGTERM');

    // Give it a moment to shut down gracefully
    await setTimeout(1000);

    // Force kill if still running
    if (!nitroServer.killed) {
      nitroServer.kill('SIGKILL');
    }

    nitroServer = null;
  }
}

