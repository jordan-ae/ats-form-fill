/**
 * A trimmed copy of the form's markup, small enough to commit as a test
 * fixture and complete enough for `extractFormFields` to read it exactly as
 * it read the live page.
 *
 * Dropped: scripts, styles, images, frames, inline styles (bar `display:none`,
 * which marks a block as switched off), and the ~240-row
 * country list inside Greenhouse's phone widget (three quarters of that page
 * by weight, and nothing the extractor looks at).
 */
export function formSnapshotHtml(doc: Document): string {
  const root = doc.querySelector('form#application-form') ?? doc.body
  const clone = root.cloneNode(true) as Element

  clone.querySelectorAll('script, style, svg, noscript, iframe, link, img, picture, video, canvas').forEach((node) => node.remove())
  clone.querySelectorAll('.iti__country-list').forEach((list) => {
    list.textContent = ''
  })
  for (const el of [clone, ...Array.from(clone.querySelectorAll('*'))]) {
    // Inline styles go, except the one fact the extractor reads from them.
    if (/display:\s*none/i.test(el.getAttribute('style') ?? '')) el.setAttribute('style', 'display:none')
    else el.removeAttribute('style')
    // What the applicant typed never belongs in a fixture. Radio, checkbox
    // and hidden inputs keep `value`: there it is the option, not an answer.
    if (el.tagName === 'INPUT' && !/^(radio|checkbox|hidden)$/.test(el.getAttribute('type') ?? 'text')) {
      el.removeAttribute('value')
    }
    // Lever records the visitor's time zone in a hidden input; that describes
    // whoever ran the capture, not the form.
    if (el.tagName === 'INPUT' && el.getAttribute('name') === 'timezone') el.removeAttribute('value')
  }

  const title = escapeText(doc.title)
  const body = root === doc.body ? clone.innerHTML : clone.outerHTML
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>\n`
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
