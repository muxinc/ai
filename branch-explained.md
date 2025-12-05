# Branch Summary: Publish Evals as Main Changes

## What This PR Does

This PR adds **automated eval publishing infrastructure** so that every push to `main` runs our AI workflow evaluations and publishes the results to GitHub Pages.

### Changes

1. **New GitHub Actions Workflow** (`.github/workflows/publish-evals-ui.yml`)
   - Runs `npx evalite run` on every push to `main`
   - Exports the Evalite UI as static files
   - Deploys to GitHub Pages at https://muxinc.github.io/ai/

2. **New Evals Documentation** (`docs/EVALS.md`)
   - Documents our "3 E's" eval framework: **Efficacy**, **Efficiency**, **Expense**
   - Explains how to run evals locally (`npm run test:eval`)
   - Provides guidance on adding evals for new workflows
   - Includes model pricing reference table

3. **Test Timeout Increase** (`vitest.config.ts`)
   - Bumped from 60s → 120s to accommodate longer-running integration tests

## Why

- **Visibility**: Persistent dashboard of eval results at a public URL
- **Standards**: Establishes that no new workflow ships without eval coverage
- **Decision-making**: Enables data-driven model selection across OpenAI, Anthropic, and Google

## How to Review

1. Check the workflow file for correctness (secrets, permissions, steps)
2. Review the documentation for clarity and accuracy
3. Confirm the timeout increase is appropriate for our test suite
