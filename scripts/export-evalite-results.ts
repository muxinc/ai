import { Command } from "commander";
import { runEvalite } from "evalite/runner";

import { LANGUAGE_MODELS, resolveEvalModelConfigsFromEnv } from "../src/lib/providers";
import type { EvalModelSelection } from "../src/lib/providers";

interface Options {
  modelSet: EvalModelSelection;
  models?: string;
}

function formatResolvedModelConfigs() {
  return resolveEvalModelConfigsFromEnv()
    .map(({ provider, modelId }) => `${provider}:${modelId}`)
    .join(", ");
}

async function runEvals(options: Options) {
  try {
    process.env.MUX_AI_EVAL_MODEL_SET = options.modelSet;
    if (options.models?.trim()) {
      process.env.MUX_AI_EVAL_MODELS = options.models.trim();
    } else {
      delete process.env.MUX_AI_EVAL_MODELS;
    }

    console.warn(`Running evals with model set: ${options.modelSet}`);
    if (options.models?.trim()) {
      console.warn(`Using explicit model list: ${options.models.trim()}`);
    } else {
      const available = Object.entries(LANGUAGE_MODELS)
        .flatMap(([provider, models]) => models.map(model => `${provider}:${model}`))
        .join(", ");
      console.warn(`Available models: ${available}`);
    }
    console.warn(`Resolved eval model configs: ${formatResolvedModelConfigs()}`);

    await runEvalite({
      mode: "run-once-and-exit",
      scoreThreshold: 75, // Fail if average score < 75
      outputPath: "./evalite-results.json", // Export results
    });
    console.warn("All evals passed!");
  } catch (error) {
    console.error("Evals failed:", error);
    process.exit(1);
  }
}

const program = new Command();

program
  .name("export-evalite-results")
  .description("Run evalite once and export results JSON")
  .option(
    "--model-set <set>",
    "Model selection mode for eval suites (default: provider defaults only)",
    (value: string) => {
      if (value !== "default" && value !== "all") {
        throw new Error(`Invalid --model-set value "${value}". Use "default" or "all".`);
      }
      return value;
    },
    "default",
  )
  .option(
    "--models <pairs>",
    "Explicit comma-separated provider:model list (overrides --model-set), e.g. openai:gpt-5.1,google:gemini-2.5-flash",
  )
  .action(async (options: Options) => {
    await runEvals(options);
  });

program.parse();
