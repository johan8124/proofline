/**
 * Renders the Proofline agent Markdown AST (./markdown-parser.ts) as safe React
 * elements.
 *
 * Security: this component never uses dangerouslySetInnerHTML and never
 * injects HTML. Every model string is a React text node, so anything the model
 * emits (including raw HTML such as <script>) is escaped and displayed as
 * literal text, never executed.
 *
 * Kept deliberately small: it is a thin mapping from the typed AST produced by
 * parseMarkdown() to elements styled consistently with the rest of the UI
 * (zinc palette, dark mode support).
 */

'use client';

import type { ReactNode } from 'react';
import { parseMarkdown, type InlineNode, type MarkdownBlock } from './markdown-parser';

/** Renders a list of inline nodes (text / code / strong / em). */
function InlineContent({ nodes }: { nodes: readonly InlineNode[] }): ReactNode {
  return nodes.map((node, index): ReactNode => {
    switch (node.type) {
      case 'text':
        return node.text;
      case 'code':
        return (
          <code
            key={index}
            className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.85em] text-zinc-800 dark:bg-zinc-800 dark:text-zinc-100"
          >
            {node.text}
          </code>
        );
      case 'strong':
        return (
          <strong
            key={index}
            className="font-semibold text-zinc-900 dark:text-zinc-50"
          >
            <InlineContent nodes={node.children} />
          </strong>
        );
      case 'em':
        return (
          <em key={index} className="italic">
            <InlineContent nodes={node.children} />
          </em>
        );
    }
  });
}

/** Renders one parsed block to the matching semantic element. */
function Block({ block }: { block: MarkdownBlock }): ReactNode {
  switch (block.type) {
    case 'paragraph':
      return (
        <p className="text-sm leading-6 text-zinc-700 dark:text-zinc-300">
          <InlineContent nodes={block.children} />
        </p>
      );
    case 'heading': {
      const Tag = block.level <= 2 ? 'h3' : 'h5';
      return (
        <Tag className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          <InlineContent nodes={block.children} />
        </Tag>
      );
    }
    case 'list': {
      const ListTag = block.ordered ? 'ol' : 'ul';
      return (
        <ListTag
          className={
            block.ordered
              ? 'ml-4 list-decimal space-y-1.5 text-sm leading-6 text-zinc-700 dark:text-zinc-300'
              : 'ml-4 list-disc space-y-1.5 text-sm leading-6 text-zinc-700 dark:text-zinc-300'
          }
        >
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex}>
              <InlineContent nodes={item} />
            </li>
          ))}
        </ListTag>
      );
    }
    case 'codeBlock':
      return (
        <pre className="overflow-x-auto rounded-md bg-zinc-100 p-3 text-xs leading-5 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-100">
          <code>{block.code}</code>
        </pre>
      );
    case 'table':
      return (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm text-zinc-700 dark:text-zinc-300">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-zinc-700">
                {block.header.map((cell, cellIndex) => (
                  <th
                    key={cellIndex}
                    className="px-3 py-1.5 font-semibold text-zinc-900 dark:text-zinc-50"
                  >
                    <InlineContent nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr
                  key={rowIndex}
                  className="border-b border-zinc-100 dark:border-zinc-800"
                >
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} className="px-3 py-1.5 align-top">
                      <InlineContent nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/**
 * Renders one agent section body as formatted Markdown.
 * Returns null for empty input so callers can skip the section cleanly.
 */
export function AgentMarkdown({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  if (blocks.length === 0) {
    return null;
  }
  return (
    <div className="mt-1 grid gap-2">
      {blocks.map((block, blockIndex) => (
        <Block key={blockIndex} block={block} />
      ))}
    </div>
  );
}