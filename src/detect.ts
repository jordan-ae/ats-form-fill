import { squash } from './dom.js'
import { detectAts } from './formFields.js'
import type { ChallengeSignal, PageClassification } from './types.js'

/**
 * Bot checks on the page, and whether any of them needs a person right now.
 *
 * Detection only: the fill engine itself never interacts with a challenge.
 * What to do about a `blocking` one is the caller's decision; in Arkoo it
 * hands the application to a person.
 */
export function detectChallenges(doc: Document): ChallengeSignal[] {
  const signals: ChallengeSignal[] = []
  const sources = [
    ...Array.from(doc.querySelectorAll<HTMLScriptElement>('script[src]')).map((el) => el.getAttribute('src') ?? ''),
    ...Array.from(doc.querySelectorAll<HTMLIFrameElement>('iframe[src]')).map((el) => el.getAttribute('src') ?? ''),
  ]
  const loaded = (pattern: RegExp) => sources.find((src) => pattern.test(src))

  const title = squash(doc.title)
  if (/^(just a moment|attention required|verifying you are human)/i.test(title)) {
    signals.push({ kind: 'cloudflare-interstitial', state: 'blocking', evidence: `title: ${title}` })
  }

  const enterprise = loaded(/recaptcha\/enterprise/i)
  const recaptcha = loaded(/recaptcha\/(api\.js|api2\/)/i)
  if (enterprise) {
    signals.push({ kind: 'recaptcha-enterprise', state: recaptchaChallengeOpen(doc) ? 'blocking' : 'present', evidence: clip(enterprise) })
  } else if (recaptcha) {
    // `render=<site key>` is the scoring-only v3 API; a `.g-recaptcha` box
    // that is not marked invisible is the v2 checkbox a person must tick.
    const checkbox = doc.querySelector('.g-recaptcha:not([data-size="invisible"])')
    const blocking = Boolean(checkbox) || recaptchaChallengeOpen(doc)
    signals.push({
      kind: checkbox ? 'recaptcha-v2' : 'recaptcha-v3',
      state: blocking ? 'blocking' : 'present',
      evidence: clip(recaptcha),
    })
  }

  const hcaptcha = loaded(/hcaptcha\.com/i)
  if (hcaptcha) {
    signals.push({ kind: 'hcaptcha', state: hcaptchaChallengeOpen(doc) ? 'blocking' : 'present', evidence: clip(hcaptcha) })
  }

  const turnstile = loaded(/challenges\.cloudflare\.com\/turnstile/i)
  if (turnstile && !signals.some((signal) => signal.kind === 'cloudflare-interstitial')) {
    signals.push({ kind: 'turnstile', state: 'present', evidence: clip(turnstile) })
  }

  const other = loaded(/datadome|perimeterx|px-cdn|arkoselabs|funcaptcha/i)
  if (other) signals.push({ kind: 'other-bot-check', state: 'present', evidence: clip(other) })

  // Greenhouse's fallback for a low reCAPTCHA score: a code mailed to the
  // candidate, typed into a field that appears after pressing submit.
  const codeField = Array.from(doc.querySelectorAll<HTMLInputElement>('input')).find((input) =>
    /(security|verification)[-_ ]?code/i.test(`${input.id} ${input.name} ${input.getAttribute('aria-label') ?? ''}`),
  )
  if (codeField) {
    signals.push({ kind: 'email-code', state: 'blocking', evidence: `input ${codeField.id || codeField.name}` })
  }

  if (doc.querySelector('input[type="password"]')) {
    signals.push({ kind: 'login-wall', state: 'blocking', evidence: 'password field' })
  }

  return signals
}

/** What the page is showing: the form, a confirmation, errors, or a wall. */
export function classifyPage(doc: Document): PageClassification {
  const challenges = detectChallenges(doc)
  const blocking = challenges.find((signal) => signal.state === 'blocking')
  if (blocking) return { state: 'challenge', evidence: `${blocking.kind}: ${blocking.evidence}`, challenges }

  const text = squash(doc.body?.textContent).slice(0, 20_000)
  const hasForm = detectAts(doc) !== 'unknown' || doc.querySelectorAll('input:not([type="hidden"]), textarea').length >= 3

  const confirmation = confirmationEvidence(doc, text)
  // A confirmation replaces the form. Text like "thank you for applying"
  // above a form that is still on screen is the employer's intro copy.
  if (confirmation && !hasForm) return { state: 'confirmation', evidence: confirmation, challenges }

  const invalid = doc.querySelector('[aria-invalid="true"]')
  if (invalid) {
    const id = invalid.getAttribute('id') || invalid.getAttribute('name') || invalid.tagName.toLowerCase()
    return { state: 'validation_error', evidence: `invalid: ${id}`, challenges }
  }

  if (hasForm) return { state: 'form', evidence: detectAts(doc), challenges }

  const closed = text.match(
    /(no longer (accepting applications|available|open)|position has been (filled|closed)|job (posting )?(is|has been) (closed|removed|no longer)|page (was )?not found|couldn['’]t find (this|that) (job|page))/i,
  )
  if (closed) return { state: 'closed', evidence: closed[0], challenges }

  return { state: 'unknown', evidence: squash(doc.title), challenges }
}

function confirmationEvidence(doc: Document, text: string): string {
  const marker = doc.querySelector(
    '.ashby-application-form-success-container, [data-testid="application-confirmation"], .application-confirmation, #application_confirmation',
  )
  if (marker) return `marker: ${marker.getAttribute('class') ?? marker.id}`

  const match = text.match(
    /(thank(s| you) for (applying|your application|your interest)|application (has been |was )?(successfully )?(submitted|received)|we['’]ve received your application|your application (has been|was) (sent|submitted|received))/i,
  )
  return match ? `text: ${match[0]}` : ''
}

/**
 * True while reCAPTCHA's image puzzle is on screen. Its frame is always in
 * the page once the script loads; Google shows it by flipping the wrapper's
 * inline `visibility`, which is readable without measuring layout.
 */
function recaptchaChallengeOpen(doc: Document): boolean {
  return Array.from(doc.querySelectorAll('iframe[src*="recaptcha"][src*="bframe"]')).some(shownInline)
}

function hcaptchaChallengeOpen(doc: Document): boolean {
  return Array.from(doc.querySelectorAll('iframe[src*="hcaptcha.com"][title*="challenge" i]')).some(shownInline)
}

/** Not hidden by an inline style on itself or a near ancestor. A frame with
 * no inline visibility at all is treated as hidden: both vendors always set it. */
function shownInline(el: Element): boolean {
  let sawVisible = false
  let node: Element | null = el
  for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
    const style = (node.getAttribute('style') ?? '').toLowerCase()
    if (/visibility:\s*hidden|display:\s*none|opacity:\s*0(?![.\d])/.test(style)) return false
    if (/visibility:\s*visible/.test(style)) sawVisible = true
  }
  return sawVisible
}

function clip(text: string): string {
  return text.length > 120 ? `${text.slice(0, 117)}...` : text
}
