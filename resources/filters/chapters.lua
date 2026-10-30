-- New page before each chapter on export.
--
-- The chapter level is passed as metadata (-M ww-chapter-level=1 or 2). A page
-- break is inserted before each heading at that level – except before the first,
-- if no content precedes it (the first page would then be empty).

local BREAKS = {
  -- An almost invisible paragraph (1 pt high) containing only the page break.
  openxml = '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr>'
    .. '<w:r><w:br w:type="page"/></w:r></w:p>',
  -- The "Pagebreak" style exists in Word Work's ODT templates (break-after: page).
  opendocument = '<text:p text:style-name="Pagebreak"/>',
  rtf = '\\page',
  html = '<div class="page-break" style="break-after: page"></div>',
}

-- FORMAT is the output format (docx, odt, rtf, html5 …); the raw code has its own format name.
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
