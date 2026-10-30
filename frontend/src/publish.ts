import { invoke } from "@tauri-apps/api/core";
/**
 * Copy the text for a publishing system (WordPress etc.): HTML with structure only
 * (headings, paragraphs, bold, italic, quotes, lists, links) and the same text
 * as plain text, for systems that don't accept HTML.
 */
import DOMPurify from "dompurify";
import { marked } from "marked";
import { splitFrontmatter } from "./editor";
import { stripNotes } from "./notes";
import { stripComments } from "./comments";
import { footnotesForPublishing, superscript } from "./footnotes";

const TAGS = ["h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "strong", "em", "blockquote", "ul", "ol", "li", "a", "hr", "del", "code", "pre", "sup"];

export function publishContent(markdown: string, withTitle: boolean): { html: string; text: string } {
  let body = stripComments(stripNotes(splitFrontmatter(markdown).body));
  if (!withTitle) body = body.replace(/^\s*#[ \t]+[^\n]*\n*/, "");
  // Footnotes: superscript numbers in the text and a numbered list at the end.
  body = footnotesForPublishing(body);
  const raw = marked.parse(body, { async: false, gfm: true, breaks: false }) as string;
  const html = DOMPurify.sanitize(raw, { ALLOWED_TAGS: TAGS, ALLOWED_ATTR: ["href"] }).trim();
  const root = document.createElement("div");
  root.innerHTML = html;
  // In plain text the footnote numbers become superscript characters (¹ ² ³).
  for (const sup of Array.from(root.querySelectorAll("sup"))) {
    const n = Number(sup.textContent);
    sup.replaceWith(Number.isFinite(n) && n > 0 ? superscript(n) : (sup.textContent ?? ""));
  }
  return { html, text: toText(root).replace(/\n{3,}/g, "\n\n").trim() + "\n" };
}

function toText(el: Element): string {
  const blocks: string[] = [];
  for (const child of Array.from(el.children)) {
    const tag = child.tagName.toLowerCase();
    if (tag === "ul" || tag === "ol") {
      blocks.push(
        Array.from(child.children)
          .map((li, i) => `${tag === "ol" ? `${i + 1}.` : "•"} ${li.textContent?.trim() ?? ""}`)
          .join("\n"),
      );
    } else if (tag === "blockquote") {
      blocks.push(toText(child));
    } else if (tag === "hr") {
      blocks.push("* * *");
    } else {
      blocks.push(child.textContent?.trim() ?? "");
    }
  }
  return blocks.filter(Boolean).join("\n\n");
}

/**
 * Puts both HTML and plain text on the clipboard. Done in Rust: the WebView
 * only allows clipboard writes right after a click, not after a menu choice
 * or a keyboard shortcut handled by the menu.
 */
export async function copyRich(html: string, text: string): Promise<void> {
  await invoke("clipboard_write_html", { html, text });
}
