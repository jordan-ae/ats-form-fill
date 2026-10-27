import { attrSelector, labelMarksRequired, labelText, referencedText, squash } from './dom.js'
import type { FieldKind, FormAts, FormField } from './types.js'

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement

/** Attribute the extractor stamps on controls the page gave no id or name. */
export const FIELD_ATTR = 'data-arkoo-field'

const SKIPPED_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'search', 'password'])

/** Response fields the CAPTCHA vendors inject; never ours to fill. */
const CHALLENGE_FIELD_NAMES = new Set(['g-recaptcha-response', 'h-captcha-response', 'cf-turnstile-response'])

/**
 * Regions that hold inputs which are not application questions:
 * - the country picker inside Greenhouse's phone widget (a search box plus
 *   ~240 list items),
 * - Ashby's "Autofill from resume" uploader — a second file input that parses
 *   the CV and overwrites fields. We fill fields ourselves, from the tailored
 *   CV, and must never drop the file there instead of on the real question.
 */
const NON_QUESTION_REGIONS = [
  '.iti__country-container',
  '.iti__dropdown-content',
  '[class*="ashby-application-form-autofill"]',
  '[aria-hidden="true"]',
].join(', ')

// Tag checks rather than `instanceof`: the extension's content script and the
// page live in different JavaScript worlds, each with its own constructors.
const isInput = (el: Element): el is HTMLInputElement => el.tagName === 'INPUT'
const isSelect = (el: Element): el is HTMLSelectElement => el.tagName === 'SELECT'
const isTextArea = (el: Element): el is HTMLTextAreaElement => el.tagName === 'TEXTAREA'

/** Ashby wraps every question, including the EEO survey's, in an element
 * carrying the field's path. */
const ASHBY_ENTRY = '[data-field-path]'
const ASHBY_YESNO = '.ashby-application-form-input-yesno'
/** Ashby's SMS opt-in: a radio pair nested inside the phone question. */
const ASHBY_TEXTING_CONSENT = 'communicationConsent'
const LEVER_QUESTION = '.application-question'

/** Lever's "custom pronouns" tick box and the free-text box it reveals. Not a
 * question anyone is asked; left for the applicant. */
const LEVER_PRONOUN_EXTRAS = new Set(['customPronounsOption', 'customPronounsTextField'])

/** Class names sites use to take a block out of the page until it applies. */
const HIDDEN_CLASSES = new Set(['hidden', 'd-none', 'is-hidden'])

/** Which ATS rendered this document, judged from its markup so saved
 * fixtures classify the same way a live page does. */
export function detectAts(doc: Document): FormAts {
  if (doc.querySelector('.ashby-application-form-field-entry')) return 'ashby'
  if (doc.querySelector('.application--questions, form.application--form')) return 'greenhouse'
  if (doc.querySelector(`form#application-form ${LEVER_QUESTION}`)) return 'lever'
  return 'unknown'
}

/**
 * Every question on an application form, in document order.
 *
 * Reads structure only — attributes and text, never layout — so it returns the
 * same answer in a visible tab, a headless browser and a test DOM. Radios and
 * same-named checkboxes collapse into one field with `options`.
 *
 * Side effect: controls with neither an id nor a name get a
 * `data-arkoo-field` attribute so `selector` can find them again.
 */
export function extractFormFields(doc: Document): FormField[] {
  const ats = detectAts(doc)
  const root: ParentNode = doc.querySelector('form#application-form') ?? doc
  const controls = Array.from(root.querySelectorAll<Control>('input, textarea, select'))

  const fields: FormField[] = []
  const done = new Set<Element>()
  let stamp = doc.querySelectorAll(`[${FIELD_ATTR}]`).length

  for (const control of controls) {
    if (done.has(control) || isSkipped(control)) continue

    const yesNo = control.closest(ASHBY_YESNO)
    const members = yesNo ? [control] : groupMembers(control, controls, ats)
    for (const member of members) done.add(member)

    const kind = yesNo ? 'boolean' : kindOf(control, members)
    const nested = control.name === ASHBY_TEXTING_CONSENT
    // A nested sub-question must not inherit the title, help text or
    // required marker of the question it happens to sit inside.
    const container = nested ? null : questionContainer(control, ats)
    const label = nested ? 'Consent to receive text messages' : resolveLabel(doc, control, container, kind, ats)

    let selector = selectorFor(control, kind, yesNo, ats)
    if (!selector) {
      const token = `f${stamp++}`
      for (const member of yesNo ? [yesNo] : members) member.setAttribute(FIELD_ATTR, token)
      selector = attrSelector(FIELD_ATTR, token)
    }

    fields.push({
      selector,
      key: keyFor(control, container, ats) || selector,
      kind,
      inputType: isInput(control) ? control.type : '',
      label,
      description: nested
        ? squash(control.closest(ASHBY_ENTRY)?.querySelector('.ashby-application-form-texting-consent-description')?.textContent)
        : resolveDescription(doc, control, container),
      section: sectionHeading(control, label),
      required: isRequired(control, members, container, kind),
      options: optionsFor(doc, control, members, kind),
      maxLength: maxLengthOf(control),
      accept: isInput(control) && control.type === 'file' ? control.accept : '',
    })
  }

  return fields
}

function isSkipped(control: Control): boolean {
  if (control.disabled) return true
  if (isInput(control) && SKIPPED_INPUT_TYPES.has(control.type)) return true
  if (CHALLENGE_FIELD_NAMES.has(control.name)) return true
  if (LEVER_PRONOUN_EXTRAS.has(control.id)) return true
  // Also catches react-select's hidden `required` twin, which is itself
  // aria-hidden and would otherwise read as a second, unlabeled question.
  if (control.closest(NON_QUESTION_REGIONS)) return true
  return isHiddenByMarkup(control)
}

/**
 * True when the control sits in a block the page has switched off — Lever
 * renders every country's demographic survey and hides all but the one that
 * matches the applicant's location.
 *
 * Judged from markup (`hidden`, a hiding class, inline `display:none`), not
 * from layout. The control's own classes are ignored: file inputs are
 * routinely hidden themselves and driven by a styled button.
 */
function isHiddenByMarkup(control: Control): boolean {
  for (let node = control.parentElement; node; node = node.parentElement) {
    if (node.hasAttribute('hidden')) return true
    if (/display:\s*none/i.test(node.getAttribute('style') ?? '')) return true
    for (const token of (node.getAttribute('class') ?? '').split(/\s+/)) {
      if (HIDDEN_CLASSES.has(token)) return true
    }
  }
  return false
}

/** Radios and checkboxes that answer the same question as `control`. */
function groupMembers(control: Control, all: Control[], ats: FormAts): Control[] {
  if (!isInput(control)) return [control]
  if (control.type !== 'radio' && control.type !== 'checkbox') return [control]

  const sameType = (other: Control): other is HTMLInputElement =>
    isInput(other) && other.type === control.type && !isSkipped(other)

  // Ashby names each checkbox after its own option ("Asian or Asian
  // American"), so a name says nothing about which question it belongs to;
  // the entry it sits in does.
  const entry = ats === 'ashby' && control.name !== ASHBY_TEXTING_CONSENT ? control.closest(ASHBY_ENTRY) : null
  if (entry) {
    return all.filter((other) => sameType(other) && other.name !== ASHBY_TEXTING_CONSENT && entry.contains(other))
  }

  if (control.name) return all.filter((other) => sameType(other) && other.name === control.name)

  // Unnamed options can only be grouped by where they sit.
  const box = control.closest('fieldset, [role="radiogroup"], [role="group"]')
  if (!box) return [control]
  return all.filter((other) => sameType(other) && !other.name && box.contains(other))
}

function kindOf(control: Control, members: Control[]): FieldKind {
  if (isSelect(control)) return 'select'
  if (isTextArea(control)) return 'textarea'
  if (control.type === 'file') return 'file'
  if (control.getAttribute('role') === 'combobox' || control.getAttribute('aria-autocomplete') === 'list') return 'combobox'
  // Lever's "Current location": a plain text input with a suggestion list
  // beside it, and no ARIA to say so. Text typed without choosing a
  // suggestion is thrown away when the box loses focus.
  if (control.parentElement?.querySelector('.dropdown-results')) return 'combobox'
  if (control.type === 'radio') return 'radio'
  if (control.type === 'checkbox') return members.length > 1 ? 'checkboxes' : 'checkbox'
  if (control.type === 'date' || control.type === 'month' || control.type === 'datetime-local') return 'date'
  return 'text'
}

/** The element that wraps one whole question: its title, help text and control. */
function questionContainer(control: Control, ats: FormAts): Element | null {
  if (ats === 'ashby') return control.closest(ASHBY_ENTRY)
  if (ats === 'lever') return control.closest(LEVER_QUESTION)
  return control.closest('.file-upload, .select__container, .field-wrapper, fieldset')
}

function selectorFor(control: Control, kind: FieldKind, yesNo: Element | null, ats: FormAts): string {
  const isChoice = isInput(control) && (control.type === 'radio' || control.type === 'checkbox')
  const ashbyPath =
    ats === 'ashby' && control.name !== ASHBY_TEXTING_CONSENT
      ? control.closest(ASHBY_ENTRY)?.getAttribute('data-field-path')
      : null

  if (yesNo) {
    // Selects the button pair, which is what the actuator clicks; the hidden
    // checkbox beside it only mirrors the choice.
    return ashbyPath ? `${attrSelector('data-field-path', ashbyPath)} ${ASHBY_YESNO}` : ''
  }
  if (isChoice && ashbyPath) {
    return `${attrSelector('data-field-path', ashbyPath)} input${attrSelector('type', (control as HTMLInputElement).type)}`
  }
  if (kind === 'radio' || kind === 'checkboxes') {
    return control.name ? `input${attrSelector('type', (control as HTMLInputElement).type)}${attrSelector('name', control.name)}` : ''
  }
  if (control.id) return attrSelector('id', control.id)
  if (control.name) {
    const tag = control.tagName.toLowerCase()
    // A text box may share its name with a checkbox group (Lever's custom
    // pronouns field), so the type goes into the selector too.
    const type = isInput(control) ? attrSelector('type', control.type) : ''
    return `${tag}${type}${attrSelector('name', control.name)}`
  }
  return ''
}

function keyFor(control: Control, container: Element | null, ats: FormAts): string {
  if (ats === 'ashby') {
    if (control.name === ASHBY_TEXTING_CONSENT) return control.name
    const path = control.closest(ASHBY_ENTRY)?.getAttribute('data-field-path')
    if (path) return path
  }
  if (ats === 'lever') return control.name || control.id
  // Greenhouse ids are the Job Board API's field names. Checkbox options get
  // `<name>_<n>` ids, so a group is keyed by the shared name instead.
  if (isInput(control) && (control.type === 'checkbox' || control.type === 'radio')) {
    return control.name || control.id
  }
  return control.id || control.name || container?.getAttribute('data-field-path') || ''
}

function resolveLabel(
  doc: Document,
  control: Control,
  container: Element | null,
  kind: FieldKind,
  ats: FormAts,
): string {
  const candidates: Array<() => string> = []

  if (ats === 'ashby') {
    candidates.push(() => labelText(container?.querySelector('.ashby-application-form-question-title')))
  }
  if (ats === 'lever') {
    candidates.push(() => labelText(container?.querySelector('.application-label')))
  }

  const isGroup = kind === 'radio' || kind === 'checkboxes' || kind === 'boolean'
  if (isGroup || kind === 'file') {
    // The question is on the group; each option's own label is an answer.
    candidates.push(() => referencedText(doc, control.closest('[role="group"], [role="radiogroup"]')?.getAttribute('aria-labelledby') ?? null))
    candidates.push(() => labelText(directChild(control.closest('fieldset'), 'LEGEND')))
  }
  if (!isGroup) {
    candidates.push(() => referencedText(doc, control.getAttribute('aria-labelledby')))
    candidates.push(() => (control.id ? labelText(doc.querySelector(`label${attrSelector('for', control.id)}`)) : ''))
    candidates.push(() => labelText(control.closest('label')))
  }
  candidates.push(() => squash(control.getAttribute('aria-label')))
  candidates.push(() => squash(control.getAttribute('placeholder')))
  candidates.push(() => control.name)

  for (const candidate of candidates) {
    const text = candidate()
    if (text) return text
  }
  return ''
}

function resolveDescription(doc: Document, control: Control, container: Element | null): string {
  const ashby = container?.querySelector('.ashby-application-form-question-description')
  if (ashby) return squash(ashby.textContent)

  // aria-describedby usually lists `<id>-description <id>-error <id>-help`;
  // only the first and last are help text, and only when they have content.
  const ids = (control.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter((id) => /-(description|help)$/.test(id))
    .join(' ')
  return referencedText(doc, ids)
}

/**
 * Nearest heading above the control, e.g. "Demographic Survey".
 *
 * A fieldset's legend is often the question itself; `ownLabel` skips that so
 * the heading returned is the section the question sits in.
 */
function sectionHeading(control: Control, ownLabel: string): string {
  let node: Element | null = control.parentElement
  for (let depth = 0; node && depth < 12; depth++, node = node.parentElement) {
    let nearest = ''
    for (const child of Array.from(node.children)) {
      if (child.contains(control)) break
      if (/^(H1|H2|H3|H4|LEGEND)$/.test(child.tagName)) {
        const text = labelText(child)
        if (text && text !== ownLabel) nearest = text
      }
    }
    if (nearest) return nearest
  }
  return ''
}

function isRequired(control: Control, members: Control[], container: Element | null, kind: FieldKind): boolean {
  if (members.some((member) => member.required || member.getAttribute('aria-required') === 'true')) return true
  if (control.closest('[role="group"], [role="radiogroup"]')?.getAttribute('aria-required') === 'true') return true

  const title =
    container?.querySelector('.ashby-application-form-question-title, .application-label') ??
    (kind === 'checkbox' ? control.closest('label') ?? container?.querySelector('label') : null)
  if (labelMarksRequired(title)) return true

  if (control.id) {
    const label = control.ownerDocument.querySelector(`label${attrSelector('for', control.id)}`)
    if (labelMarksRequired(label)) return true
  }
  return false
}

function optionsFor(doc: Document, control: Control, members: Control[], kind: FieldKind): string[] {
  if (kind === 'boolean') return ['Yes', 'No']
  if (isSelect(control)) {
    return Array.from(control.options)
      .filter((option) => option.value !== '' && !option.disabled)
      .map((option) => squash(option.textContent))
  }
  if (kind !== 'radio' && kind !== 'checkboxes') return []
  return members.map((member) => optionLabel(doc, member as HTMLInputElement)).filter(Boolean)
}

/** The visible text of one radio or checkbox option. */
export function optionLabel(doc: Document, option: HTMLInputElement): string {
  const wrapping = labelText(option.closest('label'))
  if (wrapping) return wrapping
  if (option.id) {
    const linked = labelText(doc.querySelector(`label${attrSelector('for', option.id)}`))
    if (linked) return linked
  }
  return squash(option.getAttribute('aria-label')) || option.value
}

function maxLengthOf(control: Control): number | null {
  if (isSelect(control)) return null
  const value = Number(control.getAttribute('maxlength'))
  return Number.isFinite(value) && value > 0 ? value : null
}

function directChild(parent: Element | null | undefined, tagName: string): Element | null {
  if (!parent) return null
  return Array.from(parent.children).find((child) => child.tagName === tagName) ?? null
}
