/* eslint-disable node/no-process-env */
import { execSync } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";

import env from "../src/env";

interface EvaliteEnvelope {
  repo: string;
  sha: string;
  ref: string;
  githubRunId?: number;
  githubRunAttempt?: number;
  status: "completed";
  evaliteVersion?: string;
  results: unknown;
}

function execGit(command: string) {
  return execSync(command, { encoding: "utf8" }).trim();
}

function parseRepoFromRemote(remoteUrl: string) {
  const githubMatch = remoteUrl.match(/github\.com[:/](.+?)(?:\.git)?$/i);
  return githubMatch ? githubMatch[1] : null;
}

function resolveRepo() {
  if (process.env.GITHUB_REPOSITORY) {
    return process.env.GITHUB_REPOSITORY;
  }

  try {
    const remote = execGit("git config --get remote.origin.url");
    const parsed = parseRepoFromRemote(remote);
    if (parsed) {
      return parsed;
    }
  } catch {
    // Ignore git lookup failures.
  }

  return null;
}

function resolveSha() {
  if (process.env.GITHUB_SHA) {
    return process.env.GITHUB_SHA;
  }

  try {
    return execGit("git rev-parse HEAD");
  } catch {
    return null;
  }
}

function resolveRef() {
  if (process.env.GITHUB_REF_NAME) {
    return process.env.GITHUB_REF_NAME;
  }

  if (process.env.GITHUB_REF) {
    return process.env.GITHUB_REF.replace("refs/heads/", "");
  }

  try {
    return execGit("git rev-parse --abbrev-ref HEAD");
  } catch {
    return null;
  }
}

interface Options {
  dryRun: boolean;
  keepFile: boolean;
}

const program = new Command();

program
  .name("post-evalite-results")
  .description("Post evalite results to the configured endpoint")
  .option("-d, --dry-run", "Print the payload without posting to the endpoint", false)
  .option("-k, --keep-file", "Skip deleting evalite-results.json after posting", false)
  .action(async (options: Options) => {
    try {
      const endpoint = env.EVALITE_RESULTS_ENDPOINT;
      if (!endpoint && !options.dryRun) {
        throw new Error("Missing EVALITE_RESULTS_ENDPOINT. Set it to the API URL (or use --dry-run).");
      }

      if (!env.EVALITE_INGEST_SECRET && !options.dryRun) {
        throw new Error("Missing EVALITE_INGEST_SECRET. Set it to the ingest secret (or use --dry-run).");
      }

      const repo = resolveRepo();
      const sha = resolveSha();
      const ref = resolveRef();

      if (!repo || !sha || !ref) {
        throw new Error("Unable to resolve repo/sha/ref metadata for eval run.");
      }

      const resultsPath = path.resolve(process.cwd(), "evalite-results.json");
      const raw = await readFile(resultsPath, "utf8");
      const results = JSON.parse(raw) as unknown;

      const payload: EvaliteEnvelope = {
        repo,
        sha,
        ref,
        githubRunId: process.env.GITHUB_RUN_ID ? Number(process.env.GITHUB_RUN_ID) : undefined,
        githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT ? Number(process.env.GITHUB_RUN_ATTEMPT) : undefined,
        status: "completed",
        evaliteVersion: process.env.EVALITE_VERSION,
        results,
      };

      if (options.dryRun) {
        console.warn("🔍 Dry run – payload that would be sent:\n");
        console.warn(JSON.stringify(payload, null, 2));
        console.warn(`\n📍 Would POST to: ${endpoint ?? "(no endpoint configured)"}`);
        return;
      }

      const response = await fetch(endpoint!, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-evalite-secret": env.EVALITE_INGEST_SECRET ?? "",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Evalite results POST failed: ${response.status} ${errorText}`);
      }

      if (options.keepFile) {
        console.warn(`✅ Posted evalite results to ${endpoint} (kept ${resultsPath})`);
      } else {
        await unlink(resultsPath);
        console.warn(`✅ Posted evalite results to ${endpoint}`);
      }
    } catch (error) {
      console.error("❌ Failed to post evalite results:", error);
      process.exit(1);
    }
  });

program.parse();
