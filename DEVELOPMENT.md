# Developing @mux/ai 📼 🤝 🤖

```bash
# Clone and install
git clone https://github.com/muxinc/mux-ai.git
cd mux-ai
npm install  # Automatically sets up git hooks

# Linting and type checking
npm run lint
npm run lint:fix
npm run typecheck

# Run tests
npm test
# Run the integration tests for all the workflows in a Workflow DevKit environment
npm test:integration-workflowdevkit
```

This project uses ESLint with `@antfu/eslint-config`, TypeScript strict mode, and automated pre-commit hooks.

## Workflow DevKit Compatability

Also note that the functions exported in this SDK are compatible with [Workflow DevKit](https://useworkflow.dev/).

To keep that compatibility, we need to follow some strict guidelines.

- Functions exported from `./workflows` MUST be `async` and contain the `"use workflow"` directive in the very first line of the function body.
- Functions exported from `./primitives` MUST be `async` and contain the `"use step"` directive in the very first line of the function body.
- Top-level `"use workflow"` functions MUST be simple functions and they MUST NOT rely on the full Node runtime, which means the `npm` packages that it depends on is limited. [See here about the workflow environment](https://useworkflow.dev/docs/foundations/workflows-and-steps#workflow-functions)
- Any function with `"use step"` MUST be `async` and MUST receive ONLY primitive Javascript values and return ONLY primitive Javascript values.
  - This is because the input and output of each step has to be serialized, so you cannot pass in or return references to functions, instances of classes, and things like that. [See here for details on serialization](https://useworkflow.dev/docs/foundations/serialization)
- Every top-level `"use workflow"` function MUST have an accompanying integration test

### Writing Integration Tests for WorkflowDevKit

- Create a test file that ends in `test.workflowdevkit.ts`
- See for example `summarization.test.workflowdevkit.ts`
- There are two test commands in `package.json` one for "regular" Node, and one for Workflow DevKit
- The files that follow this naming convention are only run in the Workflow DevKit tests
- You MUST call `start(workflowName, [args..])` and test that you get a `run.runId` string back
- And you MUST actually run the workflow by calling `await run.returnValue` -- and check the return value.
