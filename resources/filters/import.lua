-- Word Work: reduces imported documents to what Markdown and the editor
-- can express. No text may be lost – only formatting.
--
--  * underline, small caps, superscript/subscript, spans and divs are unwrapped
--  * images and raw HTML/XML are removed (the editor only handles text)
--  * tables become one paragraph per row with the cells separated by " – "
--  * footnotes are kept, but only with paragraphs (lists, tables etc. in a
--    footnote become regular paragraphs)

local function unwrap(el) return el.content end

Underline = unwrap
SmallCaps = unwrap
Superscript = unwrap
Subscript = unwrap
Span = unwrap
Div = unwrap

function Image(el)
  return {}
end

function Figure(el)
  return {}
end

function RawInline(el) return {} end
function RawBlock(el) return {} end

function Note(el)
  local blocks = {}
  for _, b in ipairs(el.content) do
    if b.t == "Para" or b.t == "Plain" then
      table.insert(blocks, pandoc.Para(b.content))
    else
      local text = pandoc.utils.stringify(b)
      if text ~= "" then table.insert(blocks, pandoc.Para({ pandoc.Str(text) })) end
    end
  end
  return pandoc.Note(blocks)
end

local function cells_to_para(row)
  local parts = {}
  for _, cell in ipairs(row.cells) do
    local text = pandoc.utils.stringify(cell.contents)
    if text ~= "" then table.insert(parts, text) end
  end
  if #parts == 0 then return nil end
  return pandoc.Para({ pandoc.Str(table.concat(parts, " – ")) })
end

function Table(tbl)
  local out = {}
  local function add_rows(rows)
    for _, row in ipairs(rows) do
      local p = cells_to_para(row)
      if p then table.insert(out, p) end
    end
  end
  add_rows(tbl.head.rows)
  for _, body in ipairs(tbl.bodies) do
    add_rows(body.head)
    add_rows(body.body)
  end
  add_rows(tbl.foot.rows)
  return out
end

function Pandoc(doc)
  -- Metadata as plain text, so the frontmatter is readable.
  for key, value in pairs(doc.meta) do
    if type(value) == "table" and value.t ~= "MetaList" and value.t ~= "MetaMap" then
      doc.meta[key] = pandoc.MetaString(pandoc.utils.stringify(value))
    end
  end
  return doc
end
