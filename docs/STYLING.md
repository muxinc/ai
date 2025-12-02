# Styling & Code Standards

This project uses automated tooling to enforce consistent code style across the codebase.

## Linting & Formatting

We use [ESLint](https://eslint.org/) with [@antfu/eslint-config](https://github.com/antfu/eslint-config) which includes:

- **Code Quality**: TypeScript best practices, import validation, etc.
- **Formatting**: Replaces Prettier with ESLint stylistic rules
- **Auto-fixing**: Most issues can be fixed automatically

### Configuration

See `eslint.config.mjs` for the full configuration. Key rules:

#### Stylistic
- **Indentation**: 2 spaces
- **Semicolons**: Required
- **Quotes**: Double quotes
- **Brace style**: 1TBS (cuddled else) - `} else {` on same line
- **Operators**: At end of line, not beginning

#### Code Quality
- **No console.log**: Discouraged (warning only)
- **process.env**: Must use config pattern, not direct access
- **Import sorting**: Automatic with `perfectionist/sort-imports`
- **Filenames**: Must use kebab-case (except `README.md`)

### Running Linting

```bash
# Check for issues
npm run lint

# Auto-fix issues
npm run lint:fix

# Type checking
npm run typecheck
```

## Pre-commit Hooks

We use [Husky](https://typicode.github.io/husky/) to automatically install git pre-commit hooks that catch issues before they're committed.

### Setup

Hooks are **automatically installed** when you run `npm install`:

```bash
npm install  # Husky installs git hooks automatically
```

The pre-commit hook runs:
1. ✅ ESLint on staged files (with `--max-warnings=0`)
2. ✅ TypeScript type checking
3. ✅ Filename convention validation (kebab-case)
4. ⚠️  Console.log detection (warning only)

### Bypassing Hooks

If you need to commit despite hook failures (not recommended):

```bash
git commit --no-verify
```

**Note**: CI will still run these checks, so bypassing locally just delays the feedback.

## Editor Integration

### VS Code

Install the [ESLint extension](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint):

```bash
code --install-extension dbaeumer.vscode-eslint
```

Add to `.vscode/settings.json`:

```json
{
  "editor.formatOnSave": false,
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": "explicit"
  },
  "eslint.validate": [
    "javascript",
    "typescript",
    "javascriptreact",
    "typescriptreact"
  ]
}
```

### Other Editors

- **WebStorm/IntelliJ**: ESLint support is built-in, enable it in Settings → Languages & Frameworks → JavaScript → Code Quality Tools → ESLint
- **Vim/Neovim**: Use [ALE](https://github.com/dense-analysis/ale) or [coc-eslint](https://github.com/neoclide/coc-eslint)
- **Sublime Text**: Install [SublimeLinter-eslint](https://packagecontrol.io/packages/SublimeLinter-eslint)

## Naming Conventions

### Files
- **Source files**: `kebab-case.ts`
- **Test files**: `kebab-case.test.ts`
- **Type definition files**: `kebab-case.d.ts`
- **Configuration files**: Various formats (follow existing patterns)

### Code
- **Variables/Functions**: `camelCase`
- **Classes/Types**: `PascalCase`
- **Constants**: `UPPER_SNAKE_CASE` (exported constants) or `camelCase` (local)
- **Private fields**: Prefix with `_` or use TypeScript `private`

### Examples

```typescript
// ✅ Good
export const DEFAULT_TIMEOUT = 5000;
export class VideoAnalyzer { }
export function analyzeVideo() { }

// ❌ Bad
export const defaultTimeout = 5000;
export class video_analyzer { }
export function analyze_video() { }
```

## Import Sorting

Imports are automatically sorted by ESLint using the following order:

1. Side-effect style imports (CSS, etc.)
2. Built-in Node.js modules (`fs`, `path`)
3. External dependencies (`@mux/mux-node`, `ai`)
4. Internal packages (`@mux/ai/*`)
5. Parent imports (`../`)
6. Sibling imports (`./`)
7. Index imports (`./index`)
8. Type imports
9. Side-effect imports
10. Object imports

**Example:**

```typescript
// Side effects
import 'dotenv/config';

// Built-in
import { readFileSync } from 'node:fs';

// External
import { generateObject } from 'ai';
import Mux from '@mux/mux-node';

// Internal
import { createPromptBuilder } from '@mux/ai/lib';

// Relative
import { fetchTranscript } from '../primitives';
import { analyzeVideo } from './analyzer';

// Types
import type { VideoAsset } from '../types';
```

## TypeScript

### Strict Mode

The project uses TypeScript strict mode:

```json
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "noImplicitOverride": true
}
```

### Type Safety Rules

- No `any` types (use `unknown` and narrow)
- Explicit return types on exported functions
- No non-null assertions (`!`) without justification
- Prefer `interface` for object shapes, `type` for unions/intersections

## CI Enforcement

All styling checks run in CI on every pull request:

```yaml
- name: Lint
  run: npm run lint

- name: Type check
  run: npm run typecheck
```

PRs with linting or type errors will fail CI checks.

## Troubleshooting

### "ESLint couldn't determine the plugin"

Run `npm install` to ensure all dependencies are installed.

### "Filename must use kebab-case"

Rename the file to use kebab-case:
- `MyComponent.ts` → `my-component.ts`
- `user_service.ts` → `user-service.ts`

### "node/no-process-env" error

Don't access `process.env` directly. Use the config pattern:

```typescript
// ❌ Bad
const apiKey = process.env.OPENAI_API_KEY;

// ✅ Good
interface Config {
  openaiApiKey?: string;
}

function myFunction(config: Config) {
  const apiKey = config.openaiApiKey || process.env.OPENAI_API_KEY;
}
```

### Hooks not running

If git hooks aren't running after `npm install`:

1. Ensure Husky was installed:
   ```bash
   npm install  # Re-run to trigger Husky setup
   ```

2. Verify the hook exists and is executable:
   ```bash
   ls -la .husky/pre-commit  # Should be executable (-rwxr-xr-x)
   ```

3. Check if Husky is properly configured:
   ```bash
   cat .husky/pre-commit  # Should contain our pre-commit checks
   ```

4. If hooks still don't work, Git may have disabled them:
   ```bash
   git config core.hooksPath  # Should output: .husky
   ```
