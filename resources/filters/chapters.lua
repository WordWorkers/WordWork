-- Ny sida före varje kapitel vid export.
--
-- Kapitelnivån skickas som metadata (-M ww-chapter-level=1 eller 2). Före varje
-- rubrik på den nivån läggs en sidbrytning – utom före den första, om inget
-- innehåll står före den (då skulle första sidan bli tom).

local BREAKS = {
  -- Ett nästan osynligt stycke (1 pt högt) som bara innehåller sidbrytningen.
  openxml = '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr>'
    .. '<w:r><w:br w:type="page"/></w:r></w:p>',
  -- Stilen "Pagebreak" finns i Word Works ODT-mallar (break-after: page).
  opendocument = '<text:p text:style-name="Pagebreak"/>',
  rtf = '\\page',
  html = '<div class="page-break" style="break-after: page"></div>',
}

-- FORMAT är utdataformatet (docx, odt, rtf, html5 …); råkoden har eget formatnamn.
local function raw_break()
  if FORMAT == 'docx' then
    return pandoc.RawBlock('openxml', BREAKS.openxml)
  elseif FORMAT == 'odt' or FORMAT == 'opendocument' then
    return pandoc.RawBlock('opendocument', BREAKS.opendocument)
  elseif FORMAT == 'rtf' then
    return pandoc.RawBlock('rtf', BREAKS.rtf)
  elseif FORMAT:match('^html') then
    return pandoc.RawBlock('html', BREAKS.html)
  end
  return nil
end

function Pandoc(doc)
  local level = tonumber(pandoc.utils.stringify(doc.meta['ww-chapter-level'] or ''))
  doc.meta['ww-chapter-level'] = nil
  if not level then
    return doc
  end
  local brk = raw_break()
  if not brk then
    return doc
  end
  local out = {}
  local seen_content = false
  for _, block in ipairs(doc.blocks) do
    if block.t == 'Header' and block.level == level and seen_content then
      table.insert(out, brk)
    end
    table.insert(out, block)
    seen_content = true
  end
  doc.blocks = out
  return doc
end
