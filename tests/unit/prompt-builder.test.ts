import { describe, it, expect } from 'vitest';
import {
  renderSection,
  createPromptBuilder,
  createTranscriptSection,
  createToneSection,
  PromptSection,
} from '../../src/lib/prompt-builder';

// ─────────────────────────────────────────────────────────────────────────────
// renderSection
// ─────────────────────────────────────────────────────────────────────────────

describe('renderSection', () => {
  it('renders a basic section with tag and content', () => {
    const section: PromptSection = {
      tag: 'task',
      content: 'Analyze the video.',
    };

    const result = renderSection(section);

    expect(result).toBe('<task>\nAnalyze the video.\n</task>');
  });

  it('renders a section with attributes', () => {
    const section: PromptSection = {
      tag: 'transcript',
      content: 'Hello world.',
      attributes: { format: 'plain text' },
    };

    const result = renderSection(section);

    expect(result).toBe('<transcript format="plain text">\nHello world.\n</transcript>');
  });

  it('renders a section with multiple attributes', () => {
    const section: PromptSection = {
      tag: 'data',
      content: 'Some data.',
      attributes: { format: 'json', version: '1.0' },
    };

    const result = renderSection(section);

    expect(result).toContain('<data');
    expect(result).toContain('format="json"');
    expect(result).toContain('version="1.0"');
    expect(result).toContain('Some data.');
    expect(result).toContain('</data>');
  });

  it('trims whitespace from content', () => {
    const section: PromptSection = {
      tag: 'task',
      content: '  \n  Analyze this.  \n  ',
    };

    const result = renderSection(section);

    expect(result).toBe('<task>\nAnalyze this.\n</task>');
  });

  it('returns empty string for empty content', () => {
    const section: PromptSection = {
      tag: 'task',
      content: '',
    };

    expect(renderSection(section)).toBe('');
  });

  it('returns empty string for whitespace-only content', () => {
    const section: PromptSection = {
      tag: 'task',
      content: '   \n\t  ',
    };

    expect(renderSection(section)).toBe('');
  });

  describe('XML safety', () => {
    it('escapes < and > in content', () => {
      const section: PromptSection = {
        tag: 'code',
        content: 'if (a < b && b > c) { return true; }',
      };

      const result = renderSection(section);

      expect(result).toContain('&lt;');
      expect(result).toContain('&gt;');
      expect(result).not.toContain('< b');
      expect(result).not.toContain('> c');
    });

    it('escapes & in content', () => {
      const section: PromptSection = {
        tag: 'text',
        content: 'Tom & Jerry',
      };

      const result = renderSection(section);

      expect(result).toContain('Tom &amp; Jerry');
    });

    it('escapes quotes in attribute values', () => {
      const section: PromptSection = {
        tag: 'quote',
        content: 'Some content.',
        attributes: { source: 'He said "hello"' },
      };

      const result = renderSection(section);

      expect(result).toContain('source="He said &quot;hello&quot;"');
    });

    it('escapes special characters in attribute values', () => {
      const section: PromptSection = {
        tag: 'data',
        content: 'Content here.',
        attributes: { query: 'a < b & c > d' },
      };

      const result = renderSection(section);

      expect(result).toContain('query="a &lt; b &amp; c &gt;');
    });

    it('throws for invalid tag names', () => {
      const section: PromptSection = {
        tag: '123invalid',
        content: 'Content.',
      };

      expect(() => renderSection(section)).toThrow('Invalid XML tag name');
    });

    it('throws for tag names with spaces', () => {
      const section: PromptSection = {
        tag: 'my tag',
        content: 'Content.',
      };

      expect(() => renderSection(section)).toThrow('Invalid XML tag name');
    });

    it('throws for invalid attribute names', () => {
      const section: PromptSection = {
        tag: 'valid',
        content: 'Content.',
        attributes: { '123attr': 'value' },
      };

      expect(() => renderSection(section)).toThrow('Invalid XML attribute name');
    });

    it('allows valid XML names with underscores, colons, and dots', () => {
      const section: PromptSection = {
        tag: 'my_tag:name.v1',
        content: 'Content.',
        attributes: { 'data_attr:v1.0': 'value' },
      };

      const result = renderSection(section);

      expect(result).toContain('<my_tag:name.v1');
      expect(result).toContain('data_attr:v1.0="value"');
    });

    it('allows tags starting with underscore', () => {
      const section: PromptSection = {
        tag: '_private',
        content: 'Private content.',
      };

      const result = renderSection(section);

      expect(result).toBe('<_private>\nPrivate content.\n</_private>');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createPromptBuilder
// ─────────────────────────────────────────────────────────────────────────────

describe('createPromptBuilder', () => {
  type TestSections = 'task' | 'tone' | 'format';

  const createTestBuilder = () =>
    createPromptBuilder<TestSections>({
      template: {
        task: { tag: 'task', content: 'Default task.' },
        tone: { tag: 'tone', content: 'Be professional.' },
        format: { tag: 'format', content: 'Return JSON.' },
      },
      sectionOrder: ['task', 'tone', 'format'],
    });

  describe('build', () => {
    it('builds prompt with default sections', () => {
      const builder = createTestBuilder();
      const result = builder.build();

      expect(result).toContain('<task>\nDefault task.\n</task>');
      expect(result).toContain('<tone>\nBe professional.\n</tone>');
      expect(result).toContain('<format>\nReturn JSON.\n</format>');
    });

    it('separates sections with double newlines', () => {
      const builder = createTestBuilder();
      const result = builder.build();

      expect(result).toContain('</task>\n\n<tone>');
      expect(result).toContain('</tone>\n\n<format>');
    });

    it('respects section order', () => {
      const builder = createPromptBuilder<TestSections>({
        template: {
          task: { tag: 'task', content: 'Task.' },
          tone: { tag: 'tone', content: 'Tone.' },
          format: { tag: 'format', content: 'Format.' },
        },
        sectionOrder: ['format', 'task', 'tone'],
      });

      const result = builder.build();
      const formatIndex = result.indexOf('<format>');
      const taskIndex = result.indexOf('<task>');
      const toneIndex = result.indexOf('<tone>');

      expect(formatIndex).toBeLessThan(taskIndex);
      expect(taskIndex).toBeLessThan(toneIndex);
    });

    it('overrides section content with string', () => {
      const builder = createTestBuilder();
      const result = builder.build({
        task: 'Custom task instruction.',
      });

      expect(result).toContain('<task>\nCustom task instruction.\n</task>');
      expect(result).toContain('<tone>\nBe professional.\n</tone>');
    });

    it('overrides section with full PromptSection', () => {
      const builder = createTestBuilder();
      const result = builder.build({
        task: {
          tag: 'custom_task',
          content: 'Completely custom.',
          attributes: { priority: 'high' },
        },
      });

      expect(result).toContain('<custom_task priority="high">');
      expect(result).toContain('Completely custom.');
    });

    it('omits sections with empty content', () => {
      const builder = createTestBuilder();
      const result = builder.build({
        tone: '',
      });

      expect(result).toContain('<task>');
      expect(result).not.toContain('<tone>');
      expect(result).toContain('<format>');
    });
  });

  describe('buildWithContext', () => {
    it('appends additional sections', () => {
      const builder = createTestBuilder();
      const result = builder.buildWithContext(undefined, [
        { tag: 'transcript', content: 'Hello world.' },
      ]);

      expect(result).toContain('<task>');
      expect(result).toContain('<transcript>\nHello world.\n</transcript>');
    });

    it('combines overrides with additional sections', () => {
      const builder = createTestBuilder();
      const result = builder.buildWithContext(
        { task: 'Overridden task.' },
        [{ tag: 'context', content: 'Extra context.' }]
      );

      expect(result).toContain('<task>\nOverridden task.\n</task>');
      expect(result).toContain('<context>\nExtra context.\n</context>');
    });

    it('handles empty additional sections array', () => {
      const builder = createTestBuilder();
      const withEmpty = builder.buildWithContext(undefined, []);
      const withoutAdditional = builder.build();

      expect(withEmpty).toBe(withoutAdditional);
    });

    it('handles undefined additional sections', () => {
      const builder = createTestBuilder();
      const withUndefined = builder.buildWithContext(undefined, undefined);
      const withoutAdditional = builder.build();

      expect(withUndefined).toBe(withoutAdditional);
    });

    it('filters out empty additional sections', () => {
      const builder = createTestBuilder();
      const result = builder.buildWithContext(undefined, [
        { tag: 'valid', content: 'Has content.' },
        { tag: 'empty', content: '' },
        { tag: 'also_valid', content: 'Also has content.' },
      ]);

      expect(result).toContain('<valid>');
      expect(result).not.toContain('<empty>');
      expect(result).toContain('<also_valid>');
    });
  });

  describe('getSection', () => {
    it('returns single section with defaults', () => {
      const builder = createTestBuilder();
      const result = builder.getSection('task');

      expect(result).toBe('<task>\nDefault task.\n</task>');
    });

    it('returns single section with string override', () => {
      const builder = createTestBuilder();
      const result = builder.getSection('task', 'Custom content.');

      expect(result).toBe('<task>\nCustom content.\n</task>');
    });

    it('returns single section with full override', () => {
      const builder = createTestBuilder();
      const result = builder.getSection('task', {
        tag: 'custom',
        content: 'Full override.',
        attributes: { type: 'special' },
      });

      expect(result).toContain('<custom type="special">');
      expect(result).toContain('Full override.');
    });
  });

  describe('template access', () => {
    it('exposes the template for inspection', () => {
      const builder = createTestBuilder();

      expect(builder.template.task.content).toBe('Default task.');
      expect(builder.template.tone.tag).toBe('tone');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────────────────────────────

describe('createTranscriptSection', () => {
  it('creates transcript section with plain text format by default', () => {
    const section = createTranscriptSection('Hello world.');

    expect(section.tag).toBe('transcript');
    expect(section.content).toBe('Hello world.');
    expect(section.attributes).toEqual({ format: 'plain text' });
  });

  it('creates transcript section with WebVTT format', () => {
    const section = createTranscriptSection('WEBVTT\n\n00:00.000 --> 00:01.000\nHello', 'WebVTT');

    expect(section.tag).toBe('transcript');
    expect(section.attributes).toEqual({ format: 'WebVTT' });
  });
});

describe('createToneSection', () => {
  it('creates tone section with instruction', () => {
    const section = createToneSection('Be friendly and casual.');

    expect(section.tag).toBe('tone');
    expect(section.content).toBe('Be friendly and casual.');
    expect(section.attributes).toBeUndefined();
  });
});

