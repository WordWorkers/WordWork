import { invoke, isTauri } from "@tauri-apps/api/core";
/**
 * Kopiera texten för ett publiceringssystem (WordPress m.fl.): HTML med enbart
 * struktur (rubriker, stycken, fet, kursiv, citat, listor, länkar) och samma text
 * som ren text, för system som inte tar emot HTML.
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
  // Fotnoter: upphöjda siffror i texten och en numrerad lista sist.
  body = footnotesForPublishing(body);
  const raw = marked.parse(body, { async: false, gfm: true, breaks: false }) as string;
  const html = DOMPurify.sanitize(raw, { ALLOWED_TAGS: TAGS, ALLOWED_ATTR: ["href"] }).trim();
  const root = document.createElement("div");
  root.innerHTML = html;
  // I ren text blir fotnotssiffrorna upphöjda tecken (¹ ² ³).
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

/** Lägger både HTML och ren text i urklipp. */
export async function copyRich(html: string, text: string): Promise<void> {
  // Mac app: via Rust – the WebView only allows clipboard writes right after a
  // click, not after a menu choice or a keyboard shortcut handled by the menu.
  if (isTauri()) {
    await invoke("clipboard_write_html", { html, text });
    return;
  }
  if (navigator.clipboard && "write" in navigator.clipboard && typeof ClipboardItem !== "undefined") {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }),
      }),
    ]);
    return;
  }
  // Reserv: markera en osynlig kopia och kopiera den.
  const div = document.createElement("div");
  div.contentEditable = "true";
  div.innerHTML = html;
  Object.assign(div.style, { position: "fixed", left: "-9999px", top: "0" });
  document.body.append(div);
  const range = document.createRange();
  range.selectNodeContents(div);
  const sel = getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  const ok = document.execCommand("copy");
  sel?.removeAllRanges();
  div.remove();
  if (!ok) throw new Error("Webbläsaren tillät inte kopiering");
}
