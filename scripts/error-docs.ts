/**
 * Generates the code table in docs/ERRORS.md from the source: each code's TSDoc
 * comment on `MUX_AI_ERROR_CODES`, its classification in `MUX_AI_ERROR_CATALOG`,
 * and whether `MUX_AI_ERROR_PUBLIC_MAPPINGS` makes it public.
 *
 * Usage:
 *   npx tsx scripts/error-docs.ts   # rewrite the table in docs/ERRORS.md
 *
 * tests/unit/errors-doc.test.ts fails when the committed table is out of date.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { MUX_AI_ERROR_CATALOG, MUX_AI_ERROR_CODES } from "../src/lib/mux-ai-error.ts";
import { MUX_AI_ERROR_PUBLIC_MAPPINGS } from "../src/lib/public-error.ts";

export const ERRORS_DOC_PATH = fileURLToPath(new URL("../docs/ERRORS.md", import.meta.url));
const ERROR_SOURCE_PATH = fileURLToPath(new URL("../src/lib/mux-ai-error.ts", import.meta.url));

const BEGIN = "<!-- BEGIN GENERATED: error codes. Don't edit by hand: generated from the TSDoc on MUX_AI_ERROR_CODES by `npm run docs:errors`. -->";
const END = "<!-- END GENERATED: error codes -->";

/** Each `MUX_AI_ERROR_CODES` key's TSDoc comment, by key. */
function codeComments(): Record<string, string> {
  const source = ts.createSourceFile(ERROR_SOURCE_PATH, readFileSync(ERROR_SOURCE_PATH, "utf8"), ts.ScriptTarget.Latest, true);
  const comments: Record<string, string> = {};
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "MUX_AI_ERROR_CODES") {
      let initializer = node.initializer;
      while (initializer && ts.isAsExpression(initializer)) {
        initializer = initializer.expression;
      }
      if (initializer && ts.isObjectLiteralExpression(initializer)) {
        for (const property of initializer.properties) {
          const docs = ts.getJSDocCommentsAndTags(property).filter(ts.isJSDoc);
          const text = docs.map(doc => ts.getTextOfJSDocComment(doc.comment) ?? "").join(" ").replace(/\s+/g, " ").trim();
          comments[property.name!.getText(source)] = text;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return comments;
}

/** The generated code table, between its markers. */
export function renderErrorCodeTable(): string {
  const comments = codeComments();
  const rows = Object.entries(MUX_AI_ERROR_CODES).map(([key, code]) => {
    const entry: { type: string; source: string; dependency?: string } = MUX_AI_ERROR_CATALOG[code];
    const comment = comments[key];
    if (!comment) {
      throw new Error(`MUX_AI_ERROR_CODES.${key} has no TSDoc comment describing its condition.`);
    }
    const isPublic = code in MUX_AI_ERROR_PUBLIC_MAPPINGS ? "yes" : "no";
    return `| \`${code}\` | \`${entry.type}\` | \`${entry.source}\` | ${entry.dependency ? `\`${entry.dependency}\`` : ""} | ${isPublic} | ${comment.replaceAll("|", "\\|")} |`;
  });
  return [
    BEGIN,
    "",
    "| Code | Type | Source | Dependency | Public | Condition |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    END,
  ].join("\n");
}

/** docs/ERRORS.md with its generated table replaced by `table`. */
export function withErrorCodeTable(doc: string, table: string): string {
  const start = doc.indexOf(BEGIN);
  const end = doc.indexOf(END);
  if (start === -1 || end === -1) {
    throw new Error(`docs/ERRORS.md is missing the ${BEGIN} / ${END} markers.`);
  }
  return `${doc.slice(0, start)}${table}${doc.slice(end + END.length)}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const doc = readFileSync(ERRORS_DOC_PATH, "utf8");
  writeFileSync(ERRORS_DOC_PATH, withErrorCodeTable(doc, renderErrorCodeTable()));
  console.warn("Updated the code table in docs/ERRORS.md.");
}
