/**
 * Ikoner för verktygsraden – enkla linjeikoner (24×24, currentColor) ritade för
 * Word Work. Knapparna har alltid aria-label och title, så de går att använda
 * med skärmläsare och visar en förklaring när man håller muspekaren över dem.
 */
import { h } from "./ui";

const ICONS = {
  documents:
    '<path d="M8 3h7l4 4v11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M15 3v4h4"/><path d="M4 7v12a2 2 0 0 0 2 2h9"/>',
  newDoc:
    '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 11v6M9 14h6"/>',
  export:
    '<path d="M12 15V3"/><path d="M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/>',
  write: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  markdown: '<path d="M8 7l-5 5 5 5"/><path d="M16 7l5 5-5 5"/><path d="M13.5 5l-3 14"/>',
  metadata:
    '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  analysis: '<path d="M4 20V10M10 20V4M16 20v-7M21 20H3"/>',
  // Ett gem – en blinkning åt kontorsprogrammens gamla hjälpreda.
  ai: '<path d="M9 8v8.5a3 3 0 0 0 6 0V5.5a4.5 4.5 0 0 0-9 0V17a6 6 0 0 0 12 0V8"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 8v4l3 2"/>',
  chars:
    '<path d="M5 20h4v-3a6.5 6.5 0 1 1 6 0v3h4"/>',
  settings:
    '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName): SVGSVGElement {
  const tpl = document.createElement("template");
  tpl.innerHTML = `<svg class="icon-svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
  return tpl.content.firstElementChild as SVGSVGElement;
}

/** Knapp med bara en ikon. `label` blir både aria-label och (med kortkommando) title. */
export function iconButton(
  name: IconName,
  label: string,
  attrs: Record<string, unknown> = {},
  shortcut = "",
): HTMLButtonElement {
  const btn = h("button", {
    class: "icon-btn",
    "aria-label": label,
    title: shortcut ? `${label} (${shortcut})` : label,
    ...attrs,
  }) as HTMLButtonElement;
  btn.append(icon(name));
  return btn;
}
