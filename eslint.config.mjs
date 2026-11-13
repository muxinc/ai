import antfu from "@antfu/eslint-config";

// Applies to all of src/; a later block for the same files replaces it, so spread it there.
const SRC_RESTRICTED_SYNTAX = [{
  selector: "ImportDeclaration[source.value=/^\\.\\.?\\//]:not([source.value=/\\.(ts|json)$/])",
  message: "Relative imports inside src/ must include the .ts extension — Node's strict ESM resolver requires it when workflow externalizes helpers at runtime.",
}, {
  selector: "ExportNamedDeclaration[source.value=/^\\.\\.?\\//]:not([source.value=/\\.(ts|json)$/])",
  message: "Relative re-exports inside src/ must include the .ts extension.",
}, {
  selector: "ExportAllDeclaration[source.value=/^\\.\\.?\\//]:not([source.value=/\\.(ts|json)$/])",
  message: "Relative re-exports inside src/ must include the .ts extension.",
}];

const CLASSIFIED_ERROR_MODULES = [
  "src/lib/dependency-error.ts",
  "src/lib/elevenlabs-errors.ts",
  "src/lib/google-errors.ts",
  "src/lib/mux-ai-error.ts",
  "src/lib/mux-video-errors.ts",
  "src/lib/public-error.ts",
  "src/lib/url-signing.ts",
  "src/workflows/chapters.ts",
  "src/workflows/edit-captions.ts",
  "src/workflows/engagement-insights.ts",
  "src/workflows/summarization.ts",
  "src/workflows/translate-audio.ts",
  "src/workflows/translate-captions.ts",
];

const CLASSIFIED_ERROR_SYNTAX = [{
  selector: "ThrowStatement > :matches(NewExpression, CallExpression)[callee.name='Error']",
  message: "Throw a classified MuxAiError (or internalError()/assertNever() for this code's own failures) so the failure keeps its source across step boundaries.",
}, {
  selector: ":matches(NewExpression[callee.name='LegacyMuxAiError'], CallExpression[callee.name='legacyWrapError'])",
  message: "This module is on the classified error model: raise a MuxAiError (see docs/ERRORS.md) and pass errors up with wrapError().",
}];

export default antfu({
  type: "app",
  typescript: true,
  formatters: true,
  ignores: ["docs/**", "examples/**", "README.md", "CHANGELOG.md"],
  stylistic: {
    indent: 2,
    semi: true,
    quotes: "double",
  },
}, {
  rules: {
    "no-console": ["warn"],
    "antfu/no-top-level-await": ["off"],
    "node/prefer-global/process": ["off"],
    "node/no-process-env": ["error"],
    "perfectionist/sort-imports": ["error", {
      tsconfigRootDir: ".",
      groups: [
        "side-effect-style",
        "builtin",
        "external",
        ["internal", "internal-type"],
        ["parent", "parent-type"],
        ["sibling", "sibling-type"],
        ["index", "index-type"],
        "type",
        "side-effect",
        "object",
        "unknown",
      ],
      internalPattern: ["^@mux/ai.*"],
    }],
    "unicorn/filename-case": ["error", {
      case: "kebabCase",
      ignore: ["README.md", "^[A-Z]+\\.md$"],
    }],
    // Cuddled else: } else { on same line
    "style/brace-style": ["error", "1tbs"],
    // Operators at end of line, not beginning
    "style/operator-linebreak": ["error", "after"],
  },
}, {
  files: ["src/**/*.ts"],
  rules: {
    "no-restricted-imports": ["error", {
      patterns: [{
        group: ["@mux/ai", "@mux/ai/*"],
        message: "Use relative imports inside src/. The @mux/ai/* aliases break when the workflow runtime externalizes helpers — they're loaded as source by Node's ESM resolver, which doesn't honour tsconfig paths.",
      }],
    }],
    "no-restricted-syntax": ["error", ...SRC_RESTRICTED_SYNTAX],
  },
}, {
  // Modules on the classified error model (docs/ERRORS.md): no plain `throw new Error`
  // and no legacy errors. Add a module when its sites are migrated; once every module
  // is, this applies to all of src/ and the legacy class goes away.
  files: CLASSIFIED_ERROR_MODULES,
  rules: {
    "no-restricted-syntax": ["error", ...SRC_RESTRICTED_SYNTAX, ...CLASSIFIED_ERROR_SYNTAX],
  },
}, {
  files: ["scripts/**/*.ts"],
  rules: {
    "node/no-process-env": ["off"],
  },
});
