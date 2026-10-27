import { squash } from './dom.js'
import { optionLabel } from './formFields.js'
import type { FormField } from './types.js'

/** A document to attach, carried as base64 so it survives being passed into
 * the page as JSON. */
export interface FileValue {
  fileName: string
  mimeType: string
  base64: string
}

export type FillValue = string | boolean | string[] | FileValue

export interface FillOptions {
  /**
   * How a typeahead choice is made. `exact` takes only an option whose text
   * equals the value. `first` types the value and takes the top suggestion —
   * right for place lookups ("Jakarta" → "Jakarta, Indonesia"), wrong for
   * anything where the options mean different things.
   */
  pick?: 'exact' | 'first'
}

export interface FillResult {
  key: string
  ok: boolean
  /** What the control shows afterwards, read back from the page. */
  observed: string
  /** Why it was not filled. Empty when `ok`. */
  reason: string
}

type Target = Pick<FormField, 'selector' | 'key' | 'kind'>

/** The element wrapping a whole file question, per ATS. */
const FILE_QUESTION = '.file-upload, [data-field-path], .application-question'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function waitFor<T>(probe: () => T | null | undefined, timeoutMs: number, everyMs = 60): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = probe()
    if (found) return found
    if (Date.now() >= deadline) return null
    await sleep(everyMs)
  }
}

/** Case- and whitespace-insensitive equality; the only matching the engine does. */
function sameText(a: string, b: string): boolean {
  return squash(a).toLowerCase() === squash(b).toLowerCase()
}

/**
 * Put one answer into one control, the way a person's browser would, and
 * report what the page then shows.
 *
 * Uses only DOM calls and DOM events, so it behaves the same from an
 * extension's content script as from a driven browser. It never invents a
 * choice: when no option matches the value, the field is left alone and the
 * result says so.
 */
export async function fillField(doc: Document, field: Target, value: FillValue, options: FillOptions = {}): Promise<FillResult> {
  const fail = (reason: string): FillResult => ({ key: field.key, ok: false, observed: readField(doc, field), reason })
  const elements = Array.from(doc.querySelectorAll<HTMLElement>(field.selector))
  const first = elements[0]
  if (!first) return fail('control not found')

  try {
    switch (field.kind) {
      case 'text':
      case 'textarea':
      case 'date': {
        if (typeof value !== 'string') return fail('expected text')
        typeInto(first as HTMLInputElement, value)
        break
      }
      case 'select': {
        if (typeof value !== 'string') return fail('expected text')
        const select = first as HTMLSelectElement
        const option = Array.from(select.options).find((candidate) => sameText(candidate.textContent ?? '', value))
        if (!option) return fail(`no option "${value}"`)
        setNativeValue(select, option.value)
        emit(select, 'input')
        emit(select, 'change')
        break
      }
      case 'combobox': {
        if (typeof value !== 'string') return fail('expected text')
        const problem = await chooseFromCombobox(doc, first as HTMLInputElement, value, options.pick ?? 'exact')
        if (problem) return fail(problem)
        break
      }
      case 'boolean': {
        if (typeof value !== 'boolean') return fail('expected yes/no')
        const button = Array.from(first.querySelectorAll('button')).find((candidate) =>
          sameText(candidate.textContent ?? '', value ? 'Yes' : 'No'),
        )
        if (!button) return fail('yes/no buttons not found')
        click(button)
        break
      }
      case 'radio': {
        if (typeof value !== 'string') return fail('expected text')
        const option = (elements as HTMLInputElement[]).find((candidate) => sameText(optionLabel(doc, candidate), value))
        if (!option) return fail(`no option "${value}"`)
        if (!option.checked) click(option)
        break
      }
      case 'checkboxes': {
        const wanted = Array.isArray(value) ? value : typeof value === 'string' ? [value] : null
        if (!wanted) return fail('expected a list')
        const boxes = elements as HTMLInputElement[]
        const missing = wanted.filter((text) => !boxes.some((box) => sameText(optionLabel(doc, box), text)))
        if (missing.length > 0) return fail(`no option "${missing[0]}"`)
        for (const box of boxes) {
          const shouldBeOn = wanted.some((text) => sameText(optionLabel(doc, box), text))
          if (box.checked !== shouldBeOn) click(box)
        }
        break
      }
      case 'checkbox': {
        if (typeof value !== 'boolean') return fail('expected yes/no')
        const box = first as HTMLInputElement
        if (box.checked !== value) click(box)
        break
      }
      case 'file': {
        if (typeof value !== 'object' || Array.isArray(value)) return fail('expected a file')
        const input = first as HTMLInputElement
        // Greenhouse swaps the input for a file chip once it has the file, so
        // the question's wrapper is what gets read back, not the input.
        const wrapper = input.closest(FILE_QUESTION) ?? input.parentElement
        attachFile(input, value)
        const fileName = value.fileName
        const shown = await waitFor(() => (holdsFile(input, fileName) || squash(wrapper?.textContent).includes(fileName) ? true : null), 4000)
        return shown
          ? { key: field.key, ok: true, observed: fileName, reason: '' }
          : fail('the page did not take the file')
      }
    }
  } catch (error) {
    return fail(`threw: ${(error as Error).message}`)
  }

  // Frameworks commit on the next tick; read back after they have.
  await sleep(80)
  const observed = readField(doc, field)
  const ok = matchesIntent(field, value, observed, options)
  return { key: field.key, ok, observed, reason: ok ? '' : `page shows "${observed}"` }
}

/** What a control currently holds, as text. Lists are joined with " | ". */
export function readField(doc: Document, field: Target): string {
  const elements = Array.from(doc.querySelectorAll<HTMLElement>(field.selector))
  const first = elements[0]
  if (!first) {
    // An attached file on Greenhouse: the input is gone, a chip names the file.
    if (field.kind !== 'file') return ''
    return squash(doc.querySelector(`[aria-labelledby="upload-label-${field.key}"] .file-upload__filename`)?.textContent)
  }

  switch (field.kind) {
    case 'select': {
      const select = first as HTMLSelectElement
      return select.value === '' ? '' : squash(select.selectedOptions[0]?.textContent)
    }
    case 'combobox': {
      const shell = comboboxShell(first)
      const chosen = Array.from(shell.querySelectorAll('.select__single-value, .select__multi-value__label'))
      if (chosen.length > 0) return chosen.map((node) => squash(node.textContent)).join(' | ')
      return (first as HTMLInputElement).value
    }
    case 'boolean': {
      const pressed = Array.from(first.querySelectorAll('button')).find(
        (button) => button.getAttribute('aria-pressed') === 'true' || /(^|[\s_-])active([\s_-]|$)/i.test(button.className),
      )
      return squash(pressed?.textContent)
    }
    case 'radio':
    case 'checkboxes':
      return (elements as HTMLInputElement[])
        .filter((option) => option.checked)
        .map((option) => optionLabel(doc, option))
        .join(' | ')
    case 'checkbox':
      return (first as HTMLInputElement).checked ? 'checked' : ''
    case 'file': {
      const input = first as HTMLInputElement
      return Array.from(input.files ?? [])
        .map((file) => file.name)
        .join(' | ')
    }
    default:
      return (first as HTMLInputElement).value ?? ''
  }
}

function matchesIntent(field: Target, value: FillValue, observed: string, options: FillOptions): boolean {
  switch (field.kind) {
    case 'boolean':
      return sameText(observed, value ? 'Yes' : 'No')
    case 'checkbox':
      return (observed === 'checked') === value
    case 'checkboxes': {
      const wanted = Array.isArray(value) ? value : [String(value)]
      const got = observed ? observed.split(' | ') : []
      return wanted.length === got.length && wanted.every((text) => got.some((item) => sameText(item, text)))
    }
    case 'file':
      return typeof value === 'object' && !Array.isArray(value) && observed === value.fileName
    case 'combobox':
      // A place lookup resolves to the service's own spelling of the place.
      return options.pick === 'first' ? observed !== '' : sameText(observed, String(value))
    default: {
      if (sameText(observed, String(value))) return true
      // Phone widgets reformat as you type ("+1 202 555 0143" → "+1
      // 202-555-0143"); the number is the same if its digits are.
      const digits = (text: string) => text.replace(/\D/g, '')
      return digits(String(value)).length >= 7 && digits(observed) === digits(String(value))
    }
  }
}

/**
 * Set `value` through the element's prototype setter.
 *
 * React replaces the `value` property on each input it controls so it can
 * tell its own writes from the user's. Assigning `el.value` goes through that
 * replacement and React then sees no change; the prototype's setter writes
 * the real value underneath, and the `input` event that follows is treated
 * as typing.
 */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const view = el.ownerDocument.defaultView as (Window & typeof globalThis) | null
  const proto =
    el.tagName === 'TEXTAREA'
      ? view?.HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT'
        ? view?.HTMLSelectElement.prototype
        : view?.HTMLInputElement.prototype
  const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : undefined
  if (setter) setter.call(el, value)
  else el.value = value
}

function emit(el: Element, type: string): void {
  const view = el.ownerDocument.defaultView as (Window & typeof globalThis) | null
  const EventCtor = view?.Event ?? Event
  // blur/focus do not bubble; their -in/-out twins, which React listens to, do.
  el.dispatchEvent(new EventCtor(type, { bubbles: type !== 'blur' && type !== 'focus', cancelable: true }))
}

function click(el: HTMLElement): void {
  const view = el.ownerDocument.defaultView as (Window & typeof globalThis) | null
  const MouseCtor = view?.MouseEvent ?? MouseEvent
  const init = { bubbles: true, cancelable: true, button: 0, view: view ?? undefined }
  el.dispatchEvent(new MouseCtor('mousedown', init))
  el.dispatchEvent(new MouseCtor('mouseup', init))
  // `click()` rather than a dispatched event: it also runs the control's own
  // activation (ticking a box, choosing a radio).
  el.click()
}

/**
 * Show part of an answer in a text box, as typing would: the value and an
 * input event, nothing more. For the extension filling in view of the user;
 * fillField commits the whole answer afterwards, with every event it needs.
 */
export function showTyped(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  setNativeValue(el, text)
  emit(el, 'input')
}

function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.focus()
  emit(el, 'focusin')
  setNativeValue(el, value)
  emit(el, 'input')
  emit(el, 'change')
  emit(el, 'focusout')
  emit(el, 'blur')
}

/** The element that wraps a typeahead's input, chosen value and menu. */
function comboboxShell(input: Element): Element {
  return input.closest('.select-shell, .select__container, [class*="inputContainer"], .application-field') ?? input.parentElement ?? input
}

/**
 * Options currently offered for `input`.
 *
 * Scoped to this widget's own list, never the whole document: Greenhouse's
 * phone field keeps a 240-row country list with `role="option"` on the page
 * at all times, and a document-wide search would happily click "Afghanistan"
 * in answer to a work-authorisation question.
 */
function offeredOptions(doc: Document, input: Element): HTMLElement[] {
  const listId = input.getAttribute('aria-controls') ?? input.getAttribute('aria-owns')
  const list = listId ? doc.getElementById(listId) : null
  const scope: ParentNode = list ?? comboboxShell(input)
  const options = Array.from(scope.querySelectorAll<HTMLElement>('[role="option"]'))
  if (options.length > 0) return options
  // Lever's location box lists its suggestions as bare children.
  return Array.from(scope.querySelectorAll<HTMLElement>('.dropdown-results > *'))
}

/** Returns '' on success, otherwise why nothing was chosen. */
async function chooseFromCombobox(doc: Document, input: HTMLInputElement, value: string, pick: 'exact' | 'first'): Promise<string> {
  const wanted = (option: HTMLElement) => pick === 'first' || sameText(option.textContent ?? '', value)

  input.focus()
  // Greenhouse's dropdown opens on mouse-up after a mouse-down on its
  // control; a mouse-down alone, which stock react-select accepts, does not.
  click((input.closest('.select__control') as HTMLElement | null) ?? input)

  // A short list is rendered whole as soon as it opens. Typing is only
  // needed for a search box, or to narrow a long list down to the value.
  let option = value === '' || pick === 'exact' ? await waitFor(() => offeredOptions(doc, input).find(wanted), 1200) : null
  if (!option && value !== '') {
    // Key events bracket the change for widgets that search on `keyup`.
    emit(input, 'keydown')
    setNativeValue(input, value)
    emit(input, 'input')
    emit(input, 'keyup')
    option = await waitFor(() => offeredOptions(doc, input).find(wanted), 5000)
  }

  if (!option) {
    // Leave no half-typed text or open menu behind for the applicant.
    setNativeValue(input, '')
    emit(input, 'input')
    emit(input, 'focusout')
    input.blur()
    return pick === 'first' ? `no suggestions for "${value}"` : `no option "${value}"`
  }

  click(option)
  return ''
}

function holdsFile(input: HTMLInputElement, fileName: string): boolean {
  return input.isConnected && Array.from(input.files ?? []).some((file) => file.name === fileName)
}

function attachFile(input: HTMLInputElement, value: FileValue): void {
  const view = input.ownerDocument.defaultView as (Window & typeof globalThis) | null
  if (!view) throw new Error('no window')
  const binary = view.atob(value.base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

  const transfer = new view.DataTransfer()
  transfer.items.add(new view.File([bytes], value.fileName, { type: value.mimeType }))
  input.files = transfer.files
  emit(input, 'input')
  emit(input, 'change')
}
