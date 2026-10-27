/** Small DOM helpers for the fill engine. No layout reads: these must behave
 * the same in a real tab, a headless browser and a test DOM. */

/**
 * An attribute selector for an exact value: `[id="…"]`, `[name="…"]`.
 *
 * Used instead of `#id` everywhere. Ashby ids are bare UUIDs and Lever names
 * look like `cards[…][field0]`; both need escaping as identifiers but are
 * plain strings inside a quoted attribute value.
 */
export function attrSelector(attr: string, value: string): string {
  return `[${attr}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`
}

/** Collapse whitespace and trim. */
export function squash(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Visible text of a label, without the markers that say "required".
 *
 * Greenhouse appends `<span aria-hidden>*</span>`, Lever `<span
 * class="required">✱</span>`. Left in, the same question would fingerprint
 * differently depending on whether an employer made it mandatory.
 */
export function labelText(el: Element | null | undefined): string {
  if (!el) return ''
  const clone = el.cloneNode(true) as Element
  clone.querySelectorAll('[aria-hidden="true"], .required, .visually-hidden, input, select, textarea, button').forEach((n) => n.remove())
  return squash(clone.textContent).replace(/\s*[*✱]+\s*$/, '').trim()
}

/** True when a label carries a required marker. */
export function labelMarksRequired(el: Element | null | undefined): boolean {
  if (!el) return false
  if (/(^|[\s_-])required([\s_-]|$)/i.test(el.getAttribute('class') ?? '')) return true
  if (el.querySelector('.required')) return true
  return /[*✱]\s*$/.test(squash(el.textContent))
}

export function byId(doc: Document, id: string): Element | null {
  if (!id) return null
  // getElementById rather than a selector: Ashby ids are bare UUIDs, which
  // start with a digit often enough to make `#id` selectors a trap.
  return doc.getElementById(id)
}

/** Text of every element an `aria-labelledby` / `aria-describedby` points at. */
export function referencedText(doc: Document, ids: string | null): string {
  if (!ids) return ''
  return squash(
    ids
      .split(/\s+/)
      .map((id) => labelText(byId(doc, id)))
      .filter(Boolean)
      .join(' '),
  )
}
