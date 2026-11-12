import { h, type ComponentChild, type VNode } from "preact";
import { parseMarkdown, safeHref, type MdBlock, type MdInline } from "../lib/markdown";
import { isMermaidLang } from "../lib/mermaid";
import { CopyButton } from "./CopyButton";
import { MermaidBlock } from "./MermaidBlock";

function renderInlines(nodes: readonly MdInline[]): ComponentChild[] {
  return nodes.map((node, index): ComponentChild => {
    switch (node.type) {
      case "text":
        return node.text;
      case "strong":
        return <strong key={index}>{renderInlines(node.children)}</strong>;
      case "em":
        return <em key={index}>{renderInlines(node.children)}</em>;
      case "code":
        return (
          <code class="jk-md-code" key={index}>
            {node.text}
          </code>
        );
      case "link": {
        const href = safeHref(node.href);
        if (href === undefined) return renderInlines(node.children);
        return (
          <a key={index} href={href} target="_blank" rel="noopener noreferrer">
            {renderInlines(node.children)}
          </a>
        );
      }
      case "break":
        return <br key={index} />;
    }
  });
}

function renderBlocks(blocks: readonly MdBlock[]): ComponentChild[] {
  return blocks.map((block, index) => renderBlock(block, index));
}

function renderBlock(block: MdBlock, index: number): ComponentChild {
  switch (block.type) {
    case "paragraph":
      return <p key={index}>{renderInlines(block.children)}</p>;
    case "heading": {
      const level = Math.min(Math.max(block.level, 1), 6);
      const children = renderInlines(block.children);
      return h(`h${level}` as "h1", { key: index, class: "jk-md-heading" }, children);
    }
    case "code":
      if (isMermaidLang(block.lang)) {
        return <MermaidBlock source={block.text} key={index} />;
      }
      return (
        <div class="jk-md-codeblock" key={index}>
          <pre class="jk-md-pre" tabIndex={0}>
            {block.lang !== undefined && <span class="jk-md-lang">{block.lang}</span>}
            <code>{block.text}</code>
          </pre>
          <CopyButton text={block.text} label="Salin kode" />
        </div>
      );
    case "list": {
      const items = block.items.map((item, itemIndex) => (
        <li key={itemIndex}>{renderBlocks(item)}</li>
      ));
      return block.ordered ? (
        <ol key={index} start={block.start === 1 ? undefined : block.start}>
          {items}
        </ol>
      ) : (
        <ul key={index}>{items}</ul>
      );
    }
    case "quote":
      return <blockquote class="jk-md-quote" key={index}>{renderBlocks(block.children)}</blockquote>;
    case "rule":
      return <hr class="jk-md-rule" key={index} />;
    case "table":
      return (
        <div class="jk-md-table-wrap" key={index}>
          <table>
            <thead>
              <tr>
                {block.header.map((cell, cellIndex) => (
                  <th key={cellIndex} style={alignStyle(block.aligns[cellIndex])}>
                    {renderInlines(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} style={alignStyle(block.aligns[cellIndex])}>
                      {renderInlines(cell)}
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

function alignStyle(
  align: "left" | "center" | "right" | null | undefined,
): Record<string, string> | undefined {
  return align === null || align === undefined ? undefined : { textAlign: align };
}

export function Markdown({ text }: { text: string }): VNode {
  const blocks = parseMarkdown(text);
  return (
    <div class="jk-md">
      {renderBlocks(blocks)}
      {text !== "" && (
        <div class="jk-md-foot">
          <CopyButton text={text} label="Salin markdown" />
        </div>
      )}
    </div>
  );
}
