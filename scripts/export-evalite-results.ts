import { runEvalite } from "evalite/runner";

async function runEvals() {
  try {
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

runEvals();
