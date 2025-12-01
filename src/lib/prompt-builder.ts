// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single section of a prompt, rendered as an XML-like tag.
 */
export interface PromptSection {
  /** The XML tag name for this section */
  tag: string;
  /** The content inside the tag */
  content: string;
  /** Optional attributes to add to the tag (e.g., { format: "plain text" }) */
  attributes?: Record<string, string>;
}

/**
 * Configuration for building a prompt section.
 * Can be a full PromptSection object, just a string (content only), or undefined to use default.
 */
export type SectionOverride = string | PromptSection | undefined;

/**
 * A template defining the default sections for a prompt.
 * Keys are section identifiers, values are the default PromptSection definitions.
 */
export type PromptTemplate<TSections extends string> = Record<TSections, PromptSection>;

/**
 * User-provided overrides for prompt sections.
 * Each key can override the corresponding section's content or full definition.
 */
export type PromptOverrides<TSections extends string> = Partial<Record<TSections, SectionOverride>>;

/**
 * Configuration for the prompt builder.
 */
export interface PromptBuilderConfig<TSections extends string> {
  /** Default sections that make up the prompt template */
  template: PromptTemplate<TSections>;
  /** Order in which sections should appear in the final prompt */
  sectionOrder: TSections[];
}

/**
 * A configured prompt builder instance with methods to build prompts.
 */
export interface PromptBuilder<TSections extends string> {
  /** The default template sections */
  template: PromptTemplate<TSections>;
  /** Build a prompt string, optionally overriding specific sections */
  build(overrides?: PromptOverrides<TSections>): string;
  /** Build a prompt with additional dynamic sections appended */
  buildWithContext(
    overrides?: PromptOverrides<TSections>,
    additionalSections?: PromptSection[]
  ): string;
  /** Get a single section's content (useful for partial rendering) */
  getSection(section: TSections, override?: SectionOverride): string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Renders a PromptSection as an XML-like string.
 */
export function renderSection(section: PromptSection): string {
  const { tag, content, attributes } = section;

  const XML_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

  const assertValidXmlName = (name: string, context: 'tag' | 'attribute'): void => {
    if (!XML_NAME_PATTERN.test(name)) {
      throw new Error(`Invalid XML ${context} name: "${name}"`);
    }
  };

  const escapeXmlText = (value: string): string =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;/');

  const escapeXmlAttribute = (value: string): string =>
    escapeXmlText(value).replace(/"/g, '&quot;');

  if (!content.trim()) {
    return '';
  }

  assertValidXmlName(tag, 'tag');

  const attrString = attributes
    ? ' ' +
      Object.entries(attributes)
        .map(([key, value]) => {
          assertValidXmlName(key, 'attribute');
          return `${key}="${escapeXmlAttribute(value)}"`;
        })
        .join(' ')
    : '';

  const safeContent = escapeXmlText(content.trim());

  return `<${tag}${attrString}>\n${safeContent}\n</${tag}>`;
}

/**
 * Resolves a section override to a full PromptSection.
 */
function resolveSection(
  defaultSection: PromptSection,
  override?: SectionOverride
): PromptSection {
  if (override === undefined) {
    return defaultSection;
  }

  if (typeof override === 'string') {
    return { ...defaultSection, content: override };
  }

  return override;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a type-safe prompt builder from a template configuration.
 *
 * @example
 * ```typescript
 * const builder = createPromptBuilder({
 *   template: {
 *     task: { tag: 'task', content: 'Analyze the image...' },
 *     tone: { tag: 'tone', content: 'Be professional.' },
 *   },
 *   sectionOrder: ['task', 'tone'],
 * });
 *
 * // Use defaults
 * const prompt1 = builder.build();
 *
 * // Override specific sections
 * const prompt2 = builder.build({
 *   tone: 'Be casual and friendly.',
 * });
 * ```
 */
export function createPromptBuilder<TSections extends string>(
  config: PromptBuilderConfig<TSections>
): PromptBuilder<TSections> {
  const { template, sectionOrder } = config;

  const getSection = (section: TSections, override?: SectionOverride): string => {
    const resolved = resolveSection(template[section], override);
    return renderSection(resolved);
  };

  const build = (overrides?: PromptOverrides<TSections>): string => {
    const sections = sectionOrder
      .map((sectionKey) => getSection(sectionKey, overrides?.[sectionKey]))
      .filter(Boolean);

    return sections.join('\n\n');
  };

  const buildWithContext = (
    overrides?: PromptOverrides<TSections>,
    additionalSections?: PromptSection[]
  ): string => {
    const basePrompt = build(overrides);

    if (!additionalSections?.length) {
      return basePrompt;
    }

    const additional = additionalSections
      .map(renderSection)
      .filter(Boolean)
      .join('\n\n');

    return additional ? `${basePrompt}\n\n${additional}` : basePrompt;
  };

  return {
    template,
    build,
    buildWithContext,
    getSection,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Common Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a transcript section for inclusion in prompts.
 */
export function createTranscriptSection(
  transcriptText: string,
  format: 'plain text' | 'WebVTT' = 'plain text'
): PromptSection {
  return {
    tag: 'transcript',
    content: transcriptText,
    attributes: { format },
  };
}

/**
 * Creates a tone section for inclusion in prompts.
 */
export function createToneSection(instruction: string): PromptSection {
  return {
    tag: 'tone',
    content: instruction,
  };
}

