/**
 * Proofline agent Markdown parser — pure, dependency-free, safe by construction.
 *
 * Parses the restricted Markdown subset the explanation agent is allowed to
 * emit (see PROOFLINE_EXPLANATION_SECTIONS in lib/agent/proofline-real-agent.ts)
 * into a plain-data AST. The AST is mapped to React elements by
 * ./agent-markdown.tsx.
 *
 * Safety: this module contains no DOM access and never builds HTML strings. It
 * only produces typed nodes, so model output can never be injected as raw HTML.
 * Anything the parser does not recognize (including any HTML the model emits)
 * is preserved as literal text and rendered escaped by React on the other side.
 *
 * Supported block constructs: ATX headings (# … ######), fenced code blocks
 * (``` and ~~~), GitHub-style pipe tables, unordered lists (- * +) and ordered
 * lists (1. / 1)), and paragraphs.
 * Supported inline constructs: inline code (`…`), bold (**…** / __…__), italic
 * (*…* / _…_) and bold-italic (***…***). Single-asterisk/underscore emphasis
 * is only recognized between non-word boundaries so identifiers such as
 * `ev-0001_id` are never mangled.
 */

/** A single inline token inside a paragraph, heading, list item or table cell. */
export type InlineNode =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'code'; readonly text: string }
  | { readonly type: 'strong'; readonly children: readonly InlineNode[] }
  | { readonly type: 'em'; readonly children: readonly InlineNode[] };

/** A top-level block produced by the parser. */
export type MarkdownBlock =
  | { readonly type: 'paragraph'; readonly children: readonly InlineNode[] }
  | { readonly type: 'heading'; readonly level: number; readonly children: readonly InlineNode[] }
  | {
      readonly type: 'list';
      readonly ordered: boolean;
      readonly items: readonly (readonly InlineNode[])[];
    }
  | { readonly type: 'codeBlock'; readonly language: string | null; readonly code: string }
  | {
      readonly type: 'table';
      readonly header: readonly (readonly InlineNode[])[];
      readonly rows: readonly (readonly (readonly InlineNode[])[])[];
    };

/** Returns true when the character just before `index` in `text` is a word char. */
function isPrecededByWordCharacter(text: string, index: number): boolean {
  if (index <= 0 || index > text.length) {
    return false;
  }
  return /\w/.test(text[index - 1]);
}
/**
 * Parses inline Markdown (bold, italic, bold-italic, inline code) into a list
 * of inline nodes. Unrecognized delimiters fall through as literal text.
 */
export function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let index = 0;

  while (index < text.length) {
    const rest = text.slice(index);

    // Inline code span: highest precedence, so backticks protect content.
    const codeSpan = /^`([^`]+)`/.exec(rest);
    if (codeSpan !== null) {
      nodes.push({ type: 'code', text: codeSpan[1] });
      index += codeSpan[0].length;
      continue;
    }

    // ***bold italic*** — handled before ** or * so the runs stay balanced.
    const boldItalic = /^\*\*\*([^*]+)\*\*\*/.exec(rest);
    if (boldItalic !== null) {
      nodes.push({
        type: 'strong',
        children: [{ type: 'em', children: parseInline(boldItalic[1]) }],
      });
      index += boldItalic[0].length;
      continue;
    }

    // **bold** (asterisk form).
    const bold = /^\*\*([^*]+)\*\*/.exec(rest);
    if (bold !== null) {
      nodes.push({ type: 'strong', children: parseInline(bold[1]) });
      index += bold[0].length;
      continue;
    }

    // *italic* — only when not glued to a word character on the left.
    if (!isPrecededByWordCharacter(text, index)) {
      const italic = /^\*([^*\s][^*]*?[^*\s]|[^*\s])\*/.exec(rest);
      if (italic !== null) {
        nodes.push({ type: 'em', children: parseInline(italic[1]) });
        index += italic[0].length;
        continue;
      }
    }

    // __bold__ (underscore form).
    const boldUnderscore = /^__([^_]+)__/.exec(rest);
    if (boldUnderscore !== null) {
      nodes.push({ type: 'strong', children: parseInline(boldUnderscore[1]) });
      index += boldUnderscore[0].length;
      continue;
    }

    // _italic_ (underscore form, same boundary guard).
    if (!isPrecededByWordCharacter(text, index)) {
      const italicUnderscore = /^_([^_\s][^_]*?[^_\s]|[^_\s])_/.exec(rest);
      if (italicUnderscore !== null) {
        nodes.push({ type: 'em', children: parseInline(italicUnderscore[1]) });
        index += italicUnderscore[0].length;
        continue;
      }
    }

    // Plain text run up to the next potential delimiter.
    const nextDelimiter = rest.search(/[*_`]/);
    if (nextDelimiter === -1) {
      nodes.push({ type: 'text', text: rest });
      break;
    }
    if (nextDelimiter > 0) {
      nodes.push({ type: 'text', text: rest.slice(0, nextDelimiter) });
      index += nextDelimiter;
      continue;
    }

    // Unmatched delimiter: keep it as literal text and move on.
    nodes.push({ type: 'text', text: rest[0] });
    index += 1;
  }

  return nodes;
}

/** A list marker found at the start of a line, or null when the line is not a list item. */
function readListMarker(line: string): { ordered: boolean; contentStart: number } | null {
  const unordered = /^(\s*)[-*+](\s+)/.exec(line);
  if (unordered !== null) {
    return { ordered: false, contentStart: unordered[0].length };
  }
  const ordered = /^(\s*)(\d{1,9}[.)])(\s+)/.exec(line);
  if (ordered !== null) {
    return { ordered: true, contentStart: ordered[0].length };
  }
  return null;
}
/** True when the line looks like a pipe-table row (contains at least one pipe). */
function isTableRowLine(line: string): boolean {
  return line.trim().length > 0 && line.trim().includes('|');
}

/**
 * True when the line is a GitHub-style table separator row, e.g.
 * `| --- | :---: |` — every cell must be a dash run with optional alignment
 * colons.
 */
function isTableSeparatorRow(line: string): boolean {
  const trimmed = line.trim();
  if (!isTableRowLine(trimmed)) {
    return false;
  }
  const body = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  const cells = body.split('|').map((cell) => cell.trim());
  return (
    cells.length > 0 &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell))
  );
}

/** Splits one table row line into trimmed cell strings. */
function splitTableRow(line: string): string[] {
  const trimmed = line.trim();
  const body = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const cells = body.split('|').map((cell) => cell.trim());
  if (cells.length > 0 && cells[cells.length - 1] === '') {
    cells.pop(); // Trailing pipe produces an empty final cell.
  }
  return cells;
}

/** True when a non-blank line starts a new block (heading, fence, list, table). */
function isBlockStart(line: string): boolean {
  return (
    /^#{1,6}\s/.test(line.trim()) ||
    /^\s*(```|~~~)/.test(line) ||
    readListMarker(line) !== null ||
    isTableRowLine(line)
  );
}

/**
 * Parses a Markdown string into top-level blocks. Block boundaries: blank
 * lines, ATX headings, fenced code blocks, pipe tables and lists.
 */
export function parseMarkdown(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    // Fenced code block.
    const fence = /^\s*(```+|~~~+)([\w.+-]*)\s*$/.exec(line);
    if (fence !== null) {
      const closeFence = fence[1][0];
      const language = fence[2] ?? '';
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(closeFence.repeat(3))) {
        codeLines.push(lines[index]);
        index += 1;
      }
      index += 1; // Skip the closing fence (or reached EOF).
      blocks.push({
        type: 'codeBlock',
        language: language.length > 0 ? language : null,
        code: codeLines.join('\n').replace(/\n$/, ''),
      });
      continue;
    }

    // Pipe table: a row line directly followed by a separator row.
    if (isTableRowLine(line) && index + 1 < lines.length && isTableSeparatorRow(lines[index + 1])) {
      const header = splitTableRow(line).map((cell) => parseInline(cell));
      index += 2;
      const rows: InlineNode[][][] = [];
      while (index < lines.length && isTableRowLine(lines[index])) {
        rows.push(splitTableRow(lines[index]).map((cell) => parseInline(cell)));
        index += 1;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }

    // ATX heading.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (heading !== null) {
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        children: parseInline(heading[2].trim().replace(/\s*#+\s*$/, '')),
      });
      index += 1;
      continue;
    }
// List (unordered or ordered). Consecutive items of the same type are
    // grouped; indented continuation lines are appended to the current item.
    const firstMarker = readListMarker(line);
    if (firstMarker !== null) {
      const ordered = firstMarker.ordered;
      const items: InlineNode[][] = [];
      let current: string[] = [];

      while (index < lines.length) {
        const raw = lines[index];

        if (raw.trim().length === 0) {
          if (index + 1 < lines.length && readListMarker(lines[index + 1]) !== null) {
            // Blank line between items of the same list: keep the list going.
            if (current.length > 0) {
              items.push(parseInline(current.join(' ')));
              current = [];
            }
            index += 1;
            continue;
          }
          break;
        }

        const marker = readListMarker(raw);
        if (marker !== null && marker.ordered === ordered) {
          if (current.length > 0) {
            items.push(parseInline(current.join(' ')));
          }
          current = [raw.slice(marker.contentStart).trim()];
          index += 1;
          continue;
        }
        if (marker !== null) {
          break; // Different list type: let the outer loop start a new block.
        }
        if (/^\s/.test(raw)) {
          current.push(raw.trim());
          index += 1;
          continue;
        }
        break;
      }

      if (current.length > 0) {
        items.push(parseInline(current.join(' ')));
      }
      if (items.length > 0) {
        blocks.push({ type: 'list', ordered, items });
      }
      continue;
    }

    // Paragraph: consume until a blank line or a new block construct.
    const paragraphLines: string[] = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim().length > 0 &&
      !isBlockStart(lines[index])
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    blocks.push({ type: 'paragraph', children: parseInline(paragraphLines.join(' ')) });
  }

  return blocks;
}