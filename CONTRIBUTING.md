# Contributing to @mux/ai

Thank you for your interest in contributing to `@mux/ai`! We welcome contributions from the community.

## Table of Contents

- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Running Examples](#running-examples)
- [Testing](#testing)
- [Code Style](#code-style)
- [Submitting Changes](#submitting-changes)
- [Reporting Issues](#reporting-issues)

## Getting Started

Before contributing, please:

1. Check existing [issues](https://github.com/muxinc/ai/issues) to see if your idea or bug has been discussed
2. For major changes, open an issue first to discuss your approach
3. Read through this guide to understand our development workflow

## Development Setup

### Prerequisites

- Node.js ≥ 21.0.0
- npm or yarn
- Git

### Clone and Install

```bash
# Clone the repository
git clone https://github.com/muxinc/ai.git
cd ai

# Install dependencies (also sets up git hooks automatically)
npm install
```

### Environment Configuration

```bash
# Copy the example environment file
cp .env.example .env

# Edit .env with your credentials
# You'll need:
# - Mux credentials (MUX_TOKEN_ID, MUX_TOKEN_SECRET)
# - At least one AI provider API key (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.)
# - S3 credentials if testing translation workflows
```

> **💡 Tip:** You don't need all credentials—only those for the workflows you're testing.

### Project Structure

```
.
├── src/
│   ├── workflows/        # Pre-built workflow functions
│   ├── primitives/       # Low-level building blocks
│   ├── providers/        # AI provider integrations
│   └── types/           # TypeScript type definitions
├── tests/
│   ├── unit/            # Unit tests
│   ├── integration/     # Integration tests
│   └── eval/            # LLM evaluation tests
├── examples/            # Example scripts
└── docs/               # Documentation
```

## Running Examples

The repository includes working examples for all workflows. These are great for testing changes:

```bash
# Video summarization
npm run example:summarization
npm run example:summarization:compare  # Compare providers

# Chapter generation
npm run example:chapters
npm run example:chapters:compare

# Content moderation
npm run example:moderation
npm run example:moderation:compare

# Burned-in caption detection
npm run example:burned-in
npm run example:burned-in:compare

# Video embeddings
npm run example:embeddings

# Caption translation
npm run example:translate-captions

# Audio dubbing
npm run example:translate-audio

# Signed playback
npm run example:signed-playback
npm run example:signed-playback:summarization
```

## Testing

We use [Vitest](https://vitest.dev/) for testing.

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with UI
npm run test:ui

# Run only unit tests
npm run test:unit

# Run only integration tests
npm run test:integration

# Run LLM evaluation tests
npm run test:eval
```

### Writing Tests

- **Unit tests** go in `tests/unit/` and should test individual functions in isolation
- **Integration tests** go in `tests/integration/` and test full workflows with real API calls
- **Evaluation tests** go in `tests/eval/` and use [Evalite](https://evalite.dev/) to test LLM outputs

Example unit test:

```typescript
import { describe, expect, it } from "vitest";

import { myFunction } from "../src/myFunction";

describe("myFunction", () => {
  it("should do something", () => {
    const result = myFunction("input");
    expect(result).toBe("expected output");
  });
});
```

### Test Coverage

We aim for high test coverage on core functionality. Run coverage reports with:

```bash
npm test -- --coverage
```

## Code Style

We use ESLint with [@antfu/eslint-config](https://github.com/antfu/eslint-config) for code style.

### Linting

```bash
# Check for issues
npm run lint

# Auto-fix issues
npm run lint:fix
```

### Type Checking

```bash
# Run TypeScript type checker
npm run typecheck
```

### Pre-commit Hooks

Git hooks are automatically set up via [Husky](https://typicode.github.io/husky/) when you run `npm install`. These hooks will:

- Run linting on staged files
- Run type checking
- Ensure tests pass before commits

### Code Style Guidelines

- Use TypeScript for all new code
- Follow existing patterns in the codebase
- Add JSDoc comments for public APIs
- Keep functions small and focused
- Prefer explicit types over implicit ones
- Use meaningful variable and function names

## Submitting Changes

### Branch Naming

Use descriptive branch names:

```
feature/add-new-workflow
fix/resolve-moderation-bug
docs/update-readme
chore/upgrade-dependencies
```

### Commit Messages

Write clear, concise commit messages:

```
feat: add support for Gemini 2.0 models
fix: resolve timeout issue in long videos
docs: add examples for custom prompts
chore: update dependencies
test: add unit tests for summarization
```

We loosely follow [Conventional Commits](https://www.conventionalcommits.org/).

### Pull Request Process

1. **Create a branch** from `main` for your changes
2. **Make your changes** following the code style guidelines
3. **Add tests** for any new functionality
4. **Update documentation** if you changed APIs or behavior
5. **Run the full test suite** to ensure nothing broke
6. **Push your branch** and create a Pull Request
7. **Describe your changes** in the PR description:
   - What problem does this solve?
   - How did you solve it?
   - Any breaking changes?
   - Screenshots/examples if applicable

### PR Review Process

- A maintainer will review your PR
- Address any feedback or requested changes
- Once approved, a maintainer will merge your PR

## Reporting Issues

### Bug Reports

When reporting bugs, please include:

- **Clear title and description** of the issue
- **Steps to reproduce** the problem
- **Expected behavior** vs actual behavior
- **Environment details**: Node.js version, OS, package version
- **Code snippet** demonstrating the issue (if applicable)
- **Error messages** or stack traces

### Feature Requests

For feature requests, please describe:

- **Use case**: What problem would this solve?
- **Proposed solution**: How should it work?
- **Alternatives considered**: Other approaches you thought about
- **Additional context**: Any other relevant information

### Security Issues

For security vulnerabilities, please **do not** open a public issue. Instead:

- Email security@mux.com with details
- We'll work with you to address the issue
- We'll credit you in release notes (if desired)

## Development Workflow

### Building

```bash
# Build the package
npm run build

# Build and watch for changes
npm run dev
```

### Local Testing

To test your changes in another project:

```bash
# In the @mux/ai directory
npm run build
npm link

# In your test project
npm link @mux/ai
```

### Adding a New Workflow

1. Create your workflow function in `src/workflows/`
2. Export it from `src/workflows/index.ts`
3. Add TypeScript types in the workflow file
4. Write unit tests in `tests/unit/`
5. Write integration tests in `tests/integration/`
6. Add example in `examples/`
7. Document in `docs/WORKFLOWS.md` and `docs/API.md`
8. Update the README table

### Adding a New Provider

1. Create provider integration in `src/providers/`
2. Add provider types
3. Update workflow options to include the new provider
4. Add tests
5. Document the new provider in relevant docs

## Questions?

- Open an [issue](https://github.com/muxinc/ai/issues) for questions
- Check existing issues and PRs for similar discussions
- Review the [documentation](./docs/)

Thank you for contributing to `@mux/ai`!
