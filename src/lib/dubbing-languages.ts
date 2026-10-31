import type { LanguageCodePair } from "./language-codes.ts";
import { toISO639_1 } from "./language-codes.ts";
import { MuxAiError } from "./mux-ai-error.ts";

// Dubbing v1 base tags and their ISO 639-3 aliases; do not apply this allowlist to other workflows.
const DUBBING_V1_LANGUAGES = {
  af: "afr",
  ar: "ara",
  hy: "hye",
  as: "asm",
  ast: "ast",
  az: "aze",
  be: "bel",
  bn: "ben",
  bs: "bos",
  bg: "bul",
  my: "mya",
  yue: "yue",
  ca: "cat",
  ceb: "ceb",
  ny: "nya",
  zh: "zho",
  hr: "hrv",
  cs: "ces",
  da: "dan",
  nl: "nld",
  en: "eng",
  et: "est",
  fil: "fil",
  fi: "fin",
  fr: "fra",
  gl: "glg",
  ka: "kat",
  de: "deu",
  el: "ell",
  gu: "guj",
  ha: "hau",
  he: "heb",
  hi: "hin",
  hu: "hun",
  is: "isl",
  id: "ind",
  ga: "gle",
  it: "ita",
  ja: "jpn",
  jv: "jav",
  kn: "kan",
  kk: "kaz",
  ko: "kor",
  ky: "kir",
  lv: "lav",
  ln: "lin",
  lt: "lit",
  lb: "ltz",
  mk: "mkd",
  ms: "msa",
  ml: "mal",
  mt: "mlt",
  mi: "mri",
  mr: "mar",
  mn: "mon",
  ne: "nep",
  no: "nor",
  oc: "oci",
  or: "ori",
  ps: "pus",
  fa: "fas",
  pl: "pol",
  pt: "por",
  pa: "pan",
  ro: "ron",
  ru: "rus",
  sr: "srp",
  sd: "snd",
  sk: "slk",
  sl: "slv",
  so: "som",
  es: "spa",
  sw: "swa",
  sv: "swe",
  tl: "tgl",
  tg: "tgk",
  ta: "tam",
  te: "tel",
  th: "tha",
  tr: "tur",
  uk: "ukr",
  ur: "urd",
  uz: "uzb",
  vi: "vie",
  cy: "cym",
  yo: "yor",
} as const;

export type DubbingLanguageCode = keyof typeof DUBBING_V1_LANGUAGES;

const aliases = new Map<string, string>(
  Object.entries(DUBBING_V1_LANGUAGES).map(([tag, iso3]) => [iso3, tag]),
);

/** Normalize a supported dubbing v1 base tag or ISO 639-3 alias before paid work. */
export function normalizeDubbingLanguageCode(code: string): DubbingLanguageCode {
  const normalized = code.trim().toLowerCase();
  const tag = Object.prototype.hasOwnProperty.call(DUBBING_V1_LANGUAGES, normalized) ? normalized : aliases.get(normalized);
  if (!tag) {
    throw new MuxAiError(`Unsupported dubbing v1 language code '${code}'. Use a supported base language tag; regional dialects are not supported.`, { type: "validation_error" });
  }
  return tag as DubbingLanguageCode;
}

/** Retain the legacy result fields, including languages whose BCP-47 base tag has three letters. */
export function getDubbingLanguageCodePair(code: string): LanguageCodePair {
  const tag = normalizeDubbingLanguageCode(code);
  return { iso639_1: tag, iso639_3: DUBBING_V1_LANGUAGES[tag] };
}

/** Source transcription supports more languages than dubbing; normalize aliases without restricting its catalog. */
export function normalizeDubbingSourceLanguageCode(code?: string): string | undefined {
  const normalized = code?.trim().toLowerCase();
  return !normalized || normalized === "auto" ? undefined : aliases.get(normalized) ?? toISO639_1(normalized);
}
