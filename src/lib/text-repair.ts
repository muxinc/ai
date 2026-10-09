import type { TextLengthLimit } from "./text-length.ts";
import { findGenerateTextLengthViolation, measureGenerateTextLength } from "./text-length.ts";

const PARAGRAPH_SEPARATOR = /(\r?\n(?:[\t ]*\r?\n)+)/;
const INVALID_REPLACEMENT = /\\[nr]|\r?\n[\t ]*\r?\n/;

function headroom(limit: TextLengthLimit) {
  return Math.min(limit.unit === "words" ? 5 : 10, Math.floor(limit.value * 0.1));
}

export interface RepairSpan {
  id: string;
  text: string;
  budgets: TextLengthLimit[];
}

export interface RepairPlan {
  spans: RepairSpan[];
  protectedTerms: string[];
}

// Preserve separators as well as paragraphs, including CRLF and blank-line spacing.
function split(content: string) {
  return content.split(PARAGRAPH_SEPARATOR);
}

export function planTextRepair(content: string, limits: readonly TextLengthLimit[], protectedTerms: readonly string[] = []): RepairPlan | null {
  if (!findGenerateTextLengthViolation(content, [...limits]))
    return null;
  const parts = split(content);
  const ranked = parts.map((text, index) => ({ text, index }))
    .filter(span => span.index % 2 === 0 && span.text.trim())
    .sort((a, b) => Math.max(...limits.map(limit => measureGenerateTextLength(b.text, limit.unit) / limit.value)) -
      Math.max(...limits.map(limit => measureGenerateTextLength(a.text, limit.unit) / limit.value)));
  const selected = new Set<number>();
  // Prefer several gentle edits to an extreme cut in one paragraph.
  for (const span of ranked) {
    selected.add(span.index);
    const fixed = parts.map((text, index) => selected.has(index) ? "" : text).join("");
    const gentleEnough = limits.every((limit) => {
      const selectedLength = [...selected].reduce((sum, index) => sum + measureGenerateTextLength(parts[index], limit.unit), 0);
      const allowance = limit.value - measureGenerateTextLength(fixed, limit.unit) - headroom(limit);
      return allowance >= selectedLength * 0.7;
    });
    if (gentleEnough)
      break;
  }
  const fixed = parts.map((text, index) => selected.has(index) ? "" : text).join("");
  const spans = [...selected].sort((a, b) => a - b).map(index => ({
    id: `p_${index}`,
    text: parts[index],
    budgets: limits.map((limit) => {
      const total = [...selected].reduce((sum, selectedIndex) => sum + measureGenerateTextLength(parts[selectedIndex], limit.unit), 0);
      const allowance = limit.value - measureGenerateTextLength(fixed, limit.unit) - headroom(limit);
      if (allowance < selected.size)
        return { unit: limit.unit, value: 0 };
      // Reserve a positive budget for every span before weighting the remainder.
      // Short or zero-word paragraphs must not make an otherwise feasible plan fail.
      const remaining = allowance - selected.size;
      const length = measureGenerateTextLength(parts[index], limit.unit);
      const share = total === 0 ? remaining / selected.size : length * remaining / total;
      return { unit: limit.unit, value: Math.min(Math.max(1, length), 1 + Math.floor(share)) };
    }),
  }));
  if (!spans.length || spans.some(span => span.budgets.some(budget => budget.value < 1)))
    return null;
  const editedText = spans.map(span => span.text).join("\n\n");
  return { spans, protectedTerms: protectedTerms.filter(term => term.length > 0 && editedText.includes(term)) };
}

// Constrain edit fields, not prose length at decoding: hard character patterns
// produced clipped/garbled endings in the live experiment. Count after assembly.
export function repairJsonSchema(plan: RepairPlan) {
  return {
    type: "object" as const,
    additionalProperties: false,
    required: plan.spans.map(span => span.id),
    properties: Object.fromEntries(plan.spans.map(span => [span.id, { type: "string" as const }])),
  };
}

export function applyTextRepair(content: string, plan: RepairPlan, replacements: unknown) {
  if (!replacements || typeof replacements !== "object" || Array.isArray(replacements))
    return { accepted: false, reason: "Invalid replacement object" } as const;
  const values = replacements as Record<string, unknown>;
  if (Object.keys(values).length !== plan.spans.length || Object.keys(values).some(key => !plan.spans.some(span => span.id === key)))
    return { accepted: false, reason: "Unexpected or missing span IDs" } as const;
  const parts = split(content);
  for (const span of plan.spans) {
    const index = Number(span.id.slice(2));
    const replacement = values[span.id];
    if (parts[index] !== span.text)
      return { accepted: false, reason: "Stale repair plan" } as const;
    if (typeof replacement !== "string" || !replacement.trim() || INVALID_REPLACEMENT.test(replacement))
      return { accepted: false, reason: "Empty or incompatible paragraph replacement" } as const;
    parts[index] = replacement;
  }
  const editedText = plan.spans.map(span => values[span.id]).join("\n\n");
  if (plan.protectedTerms.some(term => !editedText.includes(term)))
    return { accepted: false, reason: "Protected term removed from edited spans" } as const;
  return { accepted: true, content: parts.join("") } as const;
}

export interface RepairCall<Usage> {
  replacements?: unknown;
  usage?: Usage;
  elapsedMs: number;
  error?: string;
}

// Model-agnostic kernel. The caller owns generation, accounting, semantic review,
// and durable step boundaries. A failed candidate is never returned as success.
export interface RepairAttempt<Usage> {
  plan: RepairPlan;
  call: RepairCall<Usage>;
  rejection?: string;
}

/** Current repair policy: paragraph edits and at most two generation calls. */
export interface RepairOptions<Usage> {
  content: string;
  limits: TextLengthLimit[];
  protectedTerms?: string[];
  generate: (plan: RepairPlan) => Promise<RepairCall<Usage>>;
  maxAttempts?: number;
}

export type RepairResult<Usage> =
  | { status: "valid"; content: string; attempts: RepairAttempt<Usage>[] } |
  { status: "failed"; attempts: RepairAttempt<Usage>[]; reason: string };

/** Orchestrates paragraph repair through a caller-supplied generation callback. */
export async function runTextRepairLoop<Usage>(options: RepairOptions<Usage>): Promise<RepairResult<Usage>> {
  const maxAttempts = options.maxAttempts ?? 2;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 2)
    throw new Error("Repair is limited to one or two calls");
  if (!options.limits.length || options.limits.some(limit => !Number.isInteger(limit.value) || limit.value < 1))
    throw new Error("Repair requires positive integer length limits");
  let content = options.content;
  const attempts: RepairAttempt<Usage>[] = [];
  if (!content.trim())
    return { status: "failed" as const, attempts, reason: "Empty draft has no substance to preserve" };
  for (let index = 0; index < maxAttempts; index++) {
    if (!findGenerateTextLengthViolation(content, options.limits))
      return { status: "valid" as const, content, attempts };
    const plan = planTextRepair(content, options.limits, options.protectedTerms);
    if (!plan)
      return { status: "failed" as const, attempts, reason: "No feasible span budget" };
    const call = await options.generate(plan);
    const applied = applyTextRepair(content, plan, call.replacements);
    attempts.push({ plan, call, rejection: applied.accepted ? undefined : applied.reason });
    // No additional call after a refusal, truncation, timeout, or provider error.
    if (call.error)
      return { status: "failed" as const, attempts, reason: call.error };
    if (applied.accepted && !findGenerateTextLengthViolation(applied.content, options.limits))
      return { status: "valid" as const, content: applied.content, attempts };
    if (applied.accepted && options.limits.every(limit => measureGenerateTextLength(applied.content, limit.unit) <= measureGenerateTextLength(content, limit.unit)))
      content = applied.content;
  }
  return !findGenerateTextLengthViolation(content, options.limits) ?
      { status: "valid" as const, content, attempts } :
      { status: "failed" as const, attempts, reason: "Repair budget exhausted without a valid output" };
}
