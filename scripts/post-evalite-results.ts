/* eslint-disable node/no-process-env */
import { execSync } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";

import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { Command } from "commander";
import dedent from "dedent";
import { z } from "zod";

import env from "../src/env";

interface EvaliteSuite {
  name?: string;
  filepath?: string;
  status?: string;
  averageScore?: number;
  duration?: number;
  createdAt?: string;
  evals?: unknown[];
}

interface EvaliteScoreRecord {
  name?: string;
  score?: number;
}

interface EvaliteRecord {
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  expected?: Record<string, unknown>;
  scores?: EvaliteScoreRecord[];
  averageScore?: number;
  duration?: number;
  caseIndex?: number;
  colOrder?: number;
}

interface ProviderStats {
  provider: string;
  model?: string;
  models?: string[];
  caseCount: number;
  avgLatencyMs?: number;
  avgCostUsd?: number;
  avgScore?: number;
  scorerAverages?: Record<string, number>;
  confidence?: {
    positiveAvg?: number;
    negativeAvg?: number;
    positiveRange?: [number, number];
    negativeRange?: [number, number];
  };
}

interface ProviderRecommendation {
  provider: string;
  model?: string;
}

interface WorkflowInsightStats {
  workflowKey: string;
  workflowName: string;
  suiteStatus?: string;
  suiteAverageScore?: number;
  suiteDurationMs?: number;
  suiteCreatedAt?: string;
  caseCount: number;
  assetCount?: number;
  providerCount: number;
  providers: ProviderStats[];
  scorerAverages?: Record<string, number>;
  recommendations?: {
    quality?: ProviderRecommendation;
    latency?: ProviderRecommendation;
    expense?: ProviderRecommendation;
  };
  notes?: string[];
}

interface WorkflowInsightPayload {
  workflowKey: string;
  workflowName: string;
  summaryMarkdown: string;
  tldr?: string;
  caveat?: string;
  stats: WorkflowInsightStats;
  recommendations?: {
    quality?: ProviderRecommendation;
    latency?: ProviderRecommendation;
    expense?: ProviderRecommendation;
  };
}

interface EvaliteEnvelope {
  repo: string;
  sha: string;
  ref: string;
  githubRunId?: number;
  githubRunAttempt?: number;
  status: "completed";
  evaliteVersion?: string;
  packageVersion?: string;
  results: unknown;
  insights: {
    generatedAt: string;
    model?: {
      provider?: string;
      modelId?: string;
    };
    workflows: WorkflowInsightPayload[];
  };
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

const WORKFLOW_MATCHERS = [
  { key: "burned_in_captions", regex: /burned[- ]in[- ]captions/i },
  { key: "translate_captions", regex: /translate[- ]captions/i },
  { key: "summarization", regex: /summarization/i },
] as const;

const WorkflowInsightSchema = z.object({
  summaryMarkdown: z.string().min(1),
  tldr: z.string().min(1).optional(),
  caveat: z.string().min(1).optional(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function resolveWorkflowKey(suite: EvaliteSuite): string | null {
  const haystack = `${suite.name ?? ""} ${suite.filepath ?? ""}`.toLowerCase();
  for (const matcher of WORKFLOW_MATCHERS) {
    if (matcher.regex.test(haystack)) {
      return matcher.key;
    }
  }
  return null;
}

function coerceNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function computeWorkflowStats(suite: EvaliteSuite, workflowKey: string): WorkflowInsightStats {
  const evals = Array.isArray(suite.evals) ? suite.evals : [];
  const providerStats = new Map<string, {
    provider: string;
    models: Set<string>;
    caseCount: number;
    latencySum: number;
    latencyCount: number;
    costSum: number;
    costCount: number;
    avgScoreSum: number;
    avgScoreCount: number;
    scorerSums: Map<string, { sum: number; count: number }>;
    confidencePositiveSum: number;
    confidencePositiveCount: number;
    confidencePositiveMin?: number;
    confidencePositiveMax?: number;
    confidenceNegativeSum: number;
    confidenceNegativeCount: number;
    confidenceNegativeMin?: number;
    confidenceNegativeMax?: number;
  }>();
  const overallScorers = new Map<string, { sum: number; count: number }>();
  const providers = new Set<string>();
  const assets = new Set<string>();
  let suiteDurationMs = coerceNumber(suite.duration);
  let suiteDurationFallbackSum = 0;
  let suiteDurationFallbackCount = 0;

  for (const item of evals) {
    if (!isRecord(item)) {
      continue;
    }

    const evalRecord = item as EvaliteRecord;
    const input = isRecord(evalRecord.input) ? evalRecord.input : {};
    const output = isRecord(evalRecord.output) ? evalRecord.output : {};
    const expected = isRecord(evalRecord.expected) ? evalRecord.expected : {};

    const assetId =
      typeof input.assetId === "string" ?
        input.assetId :
        typeof output.assetId === "string" ?
          output.assetId :
          undefined;
    if (assetId) {
      assets.add(assetId);
    }

    const provider =
      typeof output.provider === "string" ?
        output.provider :
        typeof input.provider === "string" ?
          input.provider :
          undefined;
    const model =
      typeof output.model === "string" ?
        output.model :
        typeof input.model === "string" ?
          input.model :
          undefined;

    if (!provider) {
      continue;
    }

    providers.add(provider);
    const stats = providerStats.get(provider) ?? {
      provider,
      models: new Set<string>(),
      caseCount: 0,
      latencySum: 0,
      latencyCount: 0,
      costSum: 0,
      costCount: 0,
      avgScoreSum: 0,
      avgScoreCount: 0,
      scorerSums: new Map(),
      confidencePositiveSum: 0,
      confidencePositiveCount: 0,
      confidencePositiveMin: undefined,
      confidencePositiveMax: undefined,
      confidenceNegativeSum: 0,
      confidenceNegativeCount: 0,
      confidenceNegativeMin: undefined,
      confidenceNegativeMax: undefined,
    };

    stats.caseCount += 1;
    if (model) {
      stats.models.add(model);
    }

    const latency =
      coerceNumber(output.latencyMs) ??
      coerceNumber(evalRecord.duration);
    if (typeof latency === "number") {
      stats.latencySum += latency;
      stats.latencyCount += 1;
    }

    const duration = coerceNumber(evalRecord.duration);
    if (typeof duration === "number") {
      suiteDurationFallbackSum += duration;
      suiteDurationFallbackCount += 1;
    }

    const cost = coerceNumber(output.estimatedCostUsd);
    if (typeof cost === "number") {
      stats.costSum += cost;
      stats.costCount += 1;
    }

    const avgScore = coerceNumber(evalRecord.averageScore);
    if (typeof avgScore === "number") {
      stats.avgScoreSum += avgScore;
      stats.avgScoreCount += 1;
    }

    if (Array.isArray(evalRecord.scores)) {
      for (const scoreItem of evalRecord.scores) {
        if (!scoreItem) {
          continue;
        }
        const scorerName = typeof scoreItem.name === "string" ? scoreItem.name : undefined;
        const scoreValue = coerceNumber(scoreItem.score);
        if (!scorerName || typeof scoreValue !== "number") {
          continue;
        }
        const scorer = stats.scorerSums.get(scorerName) ?? { sum: 0, count: 0 };
        scorer.sum += scoreValue;
        scorer.count += 1;
        stats.scorerSums.set(scorerName, scorer);

        const overall = overallScorers.get(scorerName) ?? { sum: 0, count: 0 };
        overall.sum += scoreValue;
        overall.count += 1;
        overallScorers.set(scorerName, overall);
      }
    }

    if (workflowKey === "burned_in_captions") {
      const expectedHasCaptions = typeof expected.hasBurnedInCaptions === "boolean" ?
        expected.hasBurnedInCaptions :
        undefined;
      const confidence = coerceNumber(output.confidence);
      if (typeof expectedHasCaptions === "boolean" && typeof confidence === "number") {
        if (expectedHasCaptions) {
          stats.confidencePositiveSum += confidence;
          stats.confidencePositiveCount += 1;
          stats.confidencePositiveMin =
            typeof stats.confidencePositiveMin === "number" ?
                Math.min(stats.confidencePositiveMin, confidence) :
              confidence;
          stats.confidencePositiveMax =
            typeof stats.confidencePositiveMax === "number" ?
                Math.max(stats.confidencePositiveMax, confidence) :
              confidence;
        } else {
          stats.confidenceNegativeSum += confidence;
          stats.confidenceNegativeCount += 1;
          stats.confidenceNegativeMin =
            typeof stats.confidenceNegativeMin === "number" ?
                Math.min(stats.confidenceNegativeMin, confidence) :
              confidence;
          stats.confidenceNegativeMax =
            typeof stats.confidenceNegativeMax === "number" ?
                Math.max(stats.confidenceNegativeMax, confidence) :
              confidence;
        }
      }
    }

    providerStats.set(provider, stats);
  }

  if (!suiteDurationMs && suiteDurationFallbackCount > 0) {
    suiteDurationMs = suiteDurationFallbackSum;
  }

  const providerSummaries: ProviderStats[] = Array.from(providerStats.values()).map((stats) => {
    const scorerAverages: Record<string, number> = {};
    for (const [name, scorer] of stats.scorerSums.entries()) {
      if (scorer.count > 0) {
        scorerAverages[name] = scorer.sum / scorer.count;
      }
    }

    const confidence =
      stats.confidencePositiveCount || stats.confidenceNegativeCount ?
          {
            positiveAvg:
          stats.confidencePositiveCount > 0 ?
            stats.confidencePositiveSum / stats.confidencePositiveCount :
            undefined,
            negativeAvg:
          stats.confidenceNegativeCount > 0 ?
            stats.confidenceNegativeSum / stats.confidenceNegativeCount :
            undefined,
            positiveRange:
          typeof stats.confidencePositiveMin === "number" &&
          typeof stats.confidencePositiveMax === "number" ?
              [stats.confidencePositiveMin, stats.confidencePositiveMax] as [number, number] :
            undefined,
            negativeRange:
          typeof stats.confidenceNegativeMin === "number" &&
          typeof stats.confidenceNegativeMax === "number" ?
              [stats.confidenceNegativeMin, stats.confidenceNegativeMax] as [number, number] :
            undefined,
          } :
        undefined;

    const models = Array.from(stats.models);
    return {
      provider: stats.provider,
      model: models.length === 1 ? models[0] : undefined,
      models: models.length > 1 ? models : undefined,
      caseCount: stats.caseCount,
      avgLatencyMs:
        stats.latencyCount > 0 ? stats.latencySum / stats.latencyCount : undefined,
      avgCostUsd: stats.costCount > 0 ? stats.costSum / stats.costCount : undefined,
      avgScore:
        stats.avgScoreCount > 0 ? stats.avgScoreSum / stats.avgScoreCount : undefined,
      scorerAverages: Object.keys(scorerAverages).length > 0 ? scorerAverages : undefined,
      confidence,
    };
  });

  const recommendationFromSummary = (summary: ProviderStats): ProviderRecommendation => ({
    provider: summary.provider,
    model: summary.model ?? summary.models?.[0],
  });

  const qualityCandidate = providerSummaries
    .filter(summary => typeof summary.avgScore === "number")
    .sort((a, b) => (b.avgScore ?? 0) - (a.avgScore ?? 0))[0];
  const latencyCandidate = providerSummaries
    .filter(summary => typeof summary.avgLatencyMs === "number")
    .sort(
      (a, b) =>
        (a.avgLatencyMs ?? Number.POSITIVE_INFINITY) -
        (b.avgLatencyMs ?? Number.POSITIVE_INFINITY),
    )[0];
  const expenseCandidate = providerSummaries
    .filter(summary => typeof summary.avgCostUsd === "number")
    .sort(
      (a, b) =>
        (a.avgCostUsd ?? Number.POSITIVE_INFINITY) -
        (b.avgCostUsd ?? Number.POSITIVE_INFINITY),
    )[0];

  const recommendations = {
    quality: qualityCandidate ? recommendationFromSummary(qualityCandidate) : undefined,
    latency: latencyCandidate ? recommendationFromSummary(latencyCandidate) : undefined,
    expense: expenseCandidate ? recommendationFromSummary(expenseCandidate) : undefined,
  };

  const overallScorerAverages: Record<string, number> = {};
  for (const [name, scorer] of overallScorers.entries()) {
    if (scorer.count > 0) {
      overallScorerAverages[name] = scorer.sum / scorer.count;
    }
  }

  const notes: string[] = [];
  if (evals.length > 0 && evals.length < 10) {
    notes.push("Small sample size (<10 cases).");
  }

  return {
    workflowKey,
    workflowName: suite.name ?? workflowKey,
    suiteStatus: suite.status,
    suiteAverageScore: coerceNumber(suite.averageScore),
    suiteDurationMs,
    suiteCreatedAt: suite.createdAt,
    caseCount: evals.length,
    assetCount: assets.size || undefined,
    providerCount: providers.size,
    providers: providerSummaries,
    scorerAverages: Object.keys(overallScorerAverages).length > 0 ?
      overallScorerAverages :
      undefined,
    recommendations:
      recommendations.quality || recommendations.latency || recommendations.expense ?
        recommendations :
        undefined,
    notes: notes.length > 0 ? notes : undefined,
  };
}

async function generateWorkflowInsights(suites: EvaliteSuite[]) {
  const model = openai("gpt-5.1");
  const insights: WorkflowInsightPayload[] = [];
  const systemPrompt = dedent`
    <role>
      You are an analyst summarizing AI evaluation results for engineering stakeholders.
    </role>
    <constraints>
      Use ASCII-only Markdown.
      Do not invent numbers or claims that are not in the provided metrics.
      Omit sections that lack supporting data.
    </constraints>
    <style>
      Concise, factual, and practical.
      Prefer 1-3 bullets per section.
    </style>`;

  for (const suite of suites) {
    const workflowKey = resolveWorkflowKey(suite);
    if (!workflowKey) {
      continue;
    }

    const stats = computeWorkflowStats(suite, workflowKey);
    const userPrompt = dedent`
      <task>
        Write a concise evaluation summary for the workflow using the metrics JSON.
      </task>
      <output_format>
        Return a JSON object with:
        - summaryMarkdown: full Markdown summary
        - tldr: a single-sentence takeaway (optional)
        - caveat: a concise caveat (optional)
      </output_format>
      <markdown_template>
        **{Workflow Name} Evals Summary ({caseCount} runs, {providerCount} providers)**

        **Accuracy**
        - ...

        **Latency**
        - ...

        **Cost**
        - ...

        **Caveat**
        - ...

        **TLDR**
        - ...
      </markdown_template>
      <rules>
        If notes mention small sample size, include a caveat in summaryMarkdown and caveat.
      </rules>
      <metrics_json>
        ${JSON.stringify(stats, null, 2)}
      </metrics_json>`;

    const result = await generateObject({
      model,
      schema: WorkflowInsightSchema,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    insights.push({
      workflowKey,
      workflowName: stats.workflowName,
      summaryMarkdown: result.object.summaryMarkdown.trim(),
      tldr: result.object.tldr?.trim(),
      caveat: result.object.caveat?.trim(),
      stats,
      recommendations: stats.recommendations,
    });
  }

  return {
    model: { provider: "openai", modelId: "gpt-5.1" },
    insights,
  };
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
      const packageJsonPath = path.resolve(process.cwd(), "package.json");
      const packageJsonRaw = await readFile(packageJsonPath, "utf8");
      const packageJson = JSON.parse(packageJsonRaw) as {
        version?: string;
        devDependencies?: Record<string, string>;
      };
      const packageVersion = packageJson.version;
      const evaliteVersion = packageJson.devDependencies?.evalite;
      const suites = isRecord(results) && Array.isArray(results.suites) ?
          (results.suites as EvaliteSuite[]) :
          [];

      const { model, insights } = await generateWorkflowInsights(suites);

      const payload: EvaliteEnvelope = {
        repo,
        sha,
        ref,
        githubRunId: process.env.GITHUB_RUN_ID ? Number(process.env.GITHUB_RUN_ID) : undefined,
        githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT ? Number(process.env.GITHUB_RUN_ATTEMPT) : undefined,
        status: "completed",
        evaliteVersion,
        packageVersion,
        results,
        insights: {
          generatedAt: new Date().toISOString(),
          model,
          workflows: insights,
        },
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
