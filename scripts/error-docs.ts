/**
 * Generates the tables in docs/ERRORS.md from the source: each value's TSDoc
 * comment on `MUX_AI_ERROR_TYPES`, `MUX_AI_ERROR_SOURCES`, `MUX_AI_ERROR_DEPENDENCIES`
 * and `MUX_AI_ERROR_CODES`, plus each code's classification in `MUX_AI_ERROR_CATALOG`
 * and whether `MUX_AI_ERROR_PUBLIC_MAPPINGS` makes it public.
 *
 * Usage:
 *   npm run docs:errors   # rewrite the generated tables in docs/ERRORS.md
 *
 * tests/unit/errors-doc.test.ts fails when the committed tables are out of date.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import {
  MUX_AI_ERROR_CATALOG,
  MUX_AI_ERROR_CODES,
  MUX_AI_ERROR_DEPENDENCIES,
  MUX_AI_ERROR_SOURCES,
  MUX_AI_ERROR_TYPES,
} from "../src/lib/mux-ai-error.ts";
import { MUX_AI_ERROR_PUBLIC_MAPPINGS } from "../src/lib/public-error.ts";

export const ERRORS_DOC_PATH = fileURLToPath(new URL("../docs/ERRORS.md", import.meta.url));
const ERROR_SOURCE_PATH = fileURLToPath(new URL("../src/lib/mux-ai-error.ts", import.meta.url));

/** Each key's TSDoc comment on the `as const` object literal named `name`. */
function keyComments(source: ts.SourceFile, name: string): Record<string, string> {
  const comments: Record<string, string> = {};
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      let initializer = node.initializer;
      while (initializer && ts.isAsExpression(initializer)) {
        initializer = initializer.expression;
      }
      if (initializer && ts.isObjectLiteralExpression(initializer)) {
        for (const property of initializer.properties) {
          const docs = ts.getJSDocCommentsAndTags(property).filter(ts.isJSDoc);
          comments[property.name!.getText(source)] = docs
            .map(doc => ts.getTextOfJSDocComment(doc.comment) ?? "")
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return comments;
}

const cell = (text: string) => text.replaceAll("|", "\\|");
const code = (value: string | undefined) => (value ? `\`${value}\`` : "");

interface GeneratedTable {
  /** Marker name in docs/ERRORS.md. */
  name: string;
  render: (source: ts.SourceFile) => string[];
}

/** Rows for a lookup object whose keys each document their value. */
function describedValues(objectName: string, values: Record<string, string>, header: string): GeneratedTable["render"] {
  return (source) => {
    const comments = keyComments(source, objectName);
    return [
      `| ${header} | Meaning |`,
      "|---|---|",
      ...Object.entries(values).map(([key, value]) => {
        if (!comments[key]) {
          throw new Error(`${objectName}.${key} has no TSDoc comment describing it.`);
        }
        return `| ${code(value)} | ${cell(comments[key])} |`;
      }),
    ];
  };
}

const TABLES: GeneratedTable[] = [
  { name: "error types", render: describedValues("MUX_AI_ERROR_TYPES", MUX_AI_ERROR_TYPES, "Type") },
  { name: "error sources", render: describedValues("MUX_AI_ERROR_SOURCES", MUX_AI_ERROR_SOURCES, "Source") },
  { name: "error dependencies", render: describedValues("MUX_AI_ERROR_DEPENDENCIES", MUX_AI_ERROR_DEPENDENCIES, "Dependency") },
  {
    name: "error codes",
    render: (source) => {
      const comments = keyComments(source, "MUX_AI_ERROR_CODES");
      return [
        "| Code | Type | Source | Dependency | Public | Condition |",
        "|---|---|---|---|---|---|",
        ...Object.entries(MUX_AI_ERROR_CODES).map(([key, value]) => {
          const entry: { type: string; source: string; dependency?: string } = MUX_AI_ERROR_CATALOG[value];
          if (!comments[key]) {
            throw new Error(`MUX_AI_ERROR_CODES.${key} has no TSDoc comment describing its condition.`);
          }
          const isPublic = value in MUX_AI_ERROR_PUBLIC_MAPPINGS ? "yes" : "no";
          return `| ${code(value)} | ${code(entry.type)} | ${code(entry.source)} | ${code(entry.dependency)} | ${isPublic} | ${cell(comments[key])} |`;
        }),
      ];
    },
  },
];

const begin = (name: string) => `<!-- BEGIN GENERATED: ${name}. Don't edit by hand: run \`npm run docs:errors\`. -->`;
const end = (name: string) => `<!-- END GENERATED: ${name} -->`;

/** docs/ERRORS.md with every generated table rewritten from the source. */
export function withGeneratedErrorTables(doc: string): string {
  const source = ts.createSourceFile(ERROR_SOURCE_PATH, readFileSync(ERROR_SOURCE_PATH, "utf8"), ts.ScriptTarget.Latest, true);
  return TABLES.reduce((text, table) => {
    const start = text.indexOf(begin(table.name));
    const stop = text.indexOf(end(table.name));
    if (start === -1 || stop === -1) {
      throw new Error(`docs/ERRORS.md is missing the markers for the generated ${table.name} table.`);
    }
    const generated = [begin(table.name), "", ...table.render(source), "", end(table.name)].join("\n");
    return `${text.slice(0, start)}${generated}${text.slice(stop + end(table.name).length)}`;
  }, doc);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(ERRORS_DOC_PATH, withGeneratedErrorTables(readFileSync(ERRORS_DOC_PATH, "utf8")));
  console.warn("Updated the generated tables in docs/ERRORS.md.");
}
