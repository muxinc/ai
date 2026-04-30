import antfu from "@antfu/eslint-config";

export default antfu({
  type: "app",
  typescript: true,
  formatters: true,
  ignores: ["docs/**", "examples/**", "README.md"],
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
    "no-restricted-syntax": ["error", {
      selector: "ImportDeclaration[source.value=/^\\.\\.?\\//]:not([source.value=/\\.(ts|json)$/])",
      message: "Relative imports inside src/ must include the .ts extension — Node's strict ESM resolver requires it when workflow externalizes helpers at runtime.",
    }, {
      selector: "ExportNamedDeclaration[source.value=/^\\.\\.?\\//]:not([source.value=/\\.(ts|json)$/])",
      message: "Relative re-exports inside src/ must include the .ts extension.",
    }, {
      selector: "ExportAllDeclaration[source.value=/^\\.\\.?\\//]:not([source.value=/\\.(ts|json)$/])",
      message: "Relative re-exports inside src/ must include the .ts extension.",
    }],
  },
}, {
  files: ["scripts/**/*.ts"],
  rules: {
    "node/no-process-env": ["off"],
  },
});
