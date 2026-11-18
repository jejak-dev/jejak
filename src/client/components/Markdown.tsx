import { h, type ComponentChild, type VNode } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { parseMarkdown, safeHref, type MdBlock, type MdInline } from "../lib/markdown";
import { isMermaidLang } from "../lib/mermaid";
import { CopyButton } from "./CopyButton";
import { Icon } from "./Icon";
import { MermaidBlock } from "./MermaidBlock";

/** Penanganan tautan: `true` berarti tautan sudah ditangani pemanggil. */
export type LinkHandler = (href: string) => boolean;

function renderInlines(nodes: readonly MdInline[], onLink?: LinkHandler): ComponentChild[] {
  return nodes.map((node, index): ComponentChild => {
    switch (node.type) {
      case "text":
        return node.text;
      case "strong":
        return <strong key={index}>{renderInlines(node.children, onLink)}</strong>;
      case "em":
        return <em key={index}>{renderInlines(node.children, onLink)}</em>;
      case "code":
        return (
          <code class="jk-md-code" key={index}>
            {node.text}
          </code>
        );
      case "link": {
        const href = safeHref(node.href, onLink !== undefined);
        if (href === undefined) return renderInlines(node.children, onLink);
        // Tautan berkode skema (http, https, mailto) tetap seperti biasa.
        const external = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(href);
        if (onLink !== undefined && !external) {
          return (
            <a
              key={index}
              href={href}
              onClick={(event) => {
                if (onLink(href)) event.preventDefault();
              }}
            >
              {renderInlines(node.children, onLink)}
            </a>
          );
        }
        return (
          <a key={index} href={href} target="_blank" rel="noopener noreferrer">
            {renderInlines(node.children, onLink)}
          </a>
        );
      }
      case "image":
        return (
          <span class="jk-md-img" key={index}>
            <Icon name="image" size={16} />
            {node.alt === "" ? "Gambar" : node.alt}
          </span>
        );
      case "break":
        return <br key={index} />;
    }
  });
}

function renderBlocks(
  blocks: readonly MdBlock[],
  onLink?: LinkHandler,
  rich?: boolean,
): ComponentChild[] {
  let lastHeading = "";
  return blocks.map((block, index) => {
    if (block.type === "heading") lastHeading = inlineText(block.children).trim();
    return renderBlock(block, index, onLink, rich, lastHeading);
  });
}

/** Teks polos dari inline (dipakai untuk judul modal tabel). */
function inlineText(nodes: readonly MdInline[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
          return node.text;
        case "strong":
        case "em":
        case "link":
          return inlineText(node.children);
        case "code":
          return node.text;
        case "image":
          return node.alt;
        case "break":
          return " ";
      }
    })
    .join("");
}

/** Markup tabel; dipakai di pratinjau maupun di modal perbesar. */
function tableElement(block: Extract<MdBlock, { type: "table" }>, onLink?: LinkHandler): VNode {
  return (
    <table>
      <thead>
        <tr>
          {block.header.map((cell, cellIndex) => (
            <th key={cellIndex} style={alignStyle(block.aligns[cellIndex])}>
              {renderInlines(cell, onLink)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {block.rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {row.map((cell, cellIndex) => (
              <td key={cellIndex} style={alignStyle(block.aligns[cellIndex])}>
                {renderInlines(cell, onLink)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface MdTableModalProps {
  open: boolean;
  title: string;
  children: ComponentChild;
  onClose: () => void;
}

/** Modal perbesar tabel. Dirender sebagai lapisan tetap di atas panel. */
export function MdTableModal({ open, title, children, onClose }: MdTableModalProps): VNode | null {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      class="jk-md-table-modal-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        class="jk-md-table-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
      >
        <div class="jk-md-table-modal-head">
          <span class="jk-md-table-modal-title">{title}</span>
          <button
            ref={closeRef}
            type="button"
            class="jk-md-table-modal-close"
            aria-label="Tutup"
            onClick={onClose}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
        <div class="jk-md-table-modal-body jk-md-table-view">{children}</div>
      </div>
    </div>
  );
}

/** Tabel pratinjau berkas: lebar alami, scroll horizontal, tombol perbesar. */
export function MdTable({
  block,
  onLink,
  title,
}: {
  block: Extract<MdBlock, { type: "table" }>;
  onLink?: LinkHandler;
  title: string;
}): VNode {
  const [open, setOpen] = useState(false);
  const expandRef = useRef<HTMLButtonElement | null>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (wasOpen.current && !open) expandRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  return (
    <div class="jk-md-table-wrap">
      <div class="jk-md-table-view">
        <div class="jk-md-table-scroll">{tableElement(block, onLink)}</div>
        <button
          ref={expandRef}
          type="button"
          class="jk-md-table-expand"
          aria-label="Perbesar tabel"
          onClick={() => {
            setOpen(true);
          }}
        >
          <Icon name="expand" size={14} />
        </button>
      </div>
      <MdTableModal
        open={open}
        title={title === "" ? "Tabel" : title}
        onClose={() => {
          setOpen(false);
        }}
      >
        {tableElement(block, onLink)}
      </MdTableModal>
    </div>
  );
}

function renderBlock(
  block: MdBlock,
  index: number,
  onLink?: LinkHandler,
  rich?: boolean,
  title?: string,
): ComponentChild {
  switch (block.type) {
    case "paragraph":
      return <p key={index}>{renderInlines(block.children, onLink)}</p>;
    case "heading": {
      const level = Math.min(Math.max(block.level, 1), 6);
      const children = renderInlines(block.children, onLink);
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
        <li key={itemIndex}>{renderBlocks(item, onLink, rich)}</li>
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
      return <blockquote class="jk-md-quote" key={index}>{renderBlocks(block.children, onLink, rich)}</blockquote>;
    case "rule":
      return <hr class="jk-md-rule" key={index} />;
    case "table":
      if (rich === true) {
        return (
          <MdTable
            key={index}
            block={block}
            onLink={onLink}
            title={title ?? ""}
          />
        );
      }
      return (
        <div class="jk-md-table-wrap" key={index}>
          {tableElement(block, onLink)}
        </div>
      );
  }
}

function alignStyle(
  align: "left" | "center" | "right" | null | undefined,
): Record<string, string> | undefined {
  return align === null || align === undefined ? undefined : { textAlign: align };
}

export interface MarkdownProps {
  text: string;
  /**
   * Penanganan tautan relatif (tanpa skema). Dipanggil saat tautan diklik;
   * `true` berarti tautan sudah ditangani dan navigasi bawaan dibatalkan.
   */
  onLink?: LinkHandler;
  /** Pratinjau berkas: gambar menjadi chip (tanpa memuat gambar dari luar). */
  rich?: boolean;
}

export function Markdown({ text, onLink, rich }: MarkdownProps): VNode {
  const blocks = parseMarkdown(text, {
    relativeLinks: onLink !== undefined,
    images: rich === true,
  });
  return (
    <div class="jk-md">
      {renderBlocks(blocks, onLink, rich)}
      {text !== "" && (
        <div class="jk-md-foot">
          <CopyButton text={text} label="Salin markdown" />
        </div>
      )}
    </div>
  );
}
