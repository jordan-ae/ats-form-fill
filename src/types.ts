/**
 * Shapes shared by the form-fill engine.
 *
 * Everything here is DOM-only on purpose: no Node, no Playwright, no runtime
 * dependencies. In Arkoo the browser extension bundles these files into its
 * content script and the cloud executor injects the same bundle into the page,
 * so a form filled by a human-supervised extension run and one filled by
 * Autopilot go through identical code.
 */

/** Which applicant-tracking system rendered the form. */
export type FormAts = 'greenhouse' | 'ashby' | 'lever' | 'unknown'

export type FieldKind =
  | 'text'
  | 'textarea'
  | 'select'
  /** A typeahead whose options only exist once it is opened (react-select, Ashby's location box). */
  | 'combobox'
  /** One-of-many: radio inputs sharing a name. */
  | 'radio'
  /** Many-of-many: checkboxes sharing a name. */
  | 'checkboxes'
  /** A single tick box, usually a consent. */
  | 'checkbox'
  /** Ashby's Yes / No button pair. */
  | 'boolean'
  | 'file'
  | 'date'

export interface FormField {
  /**
   * How to find the control again in this document. `#id` or `[name="…"]`
   * where the page offers one; otherwise a `data-arkoo-field` attribute the
   * extractor stamps onto the element. For a group it matches every member.
   */
  selector: string
  /**
   * The ATS's own identifier for the question — Greenhouse's API field name
   * (`question_123`), Ashby's field path, Lever's input name. This is what a
   * prepared question is matched against before falling back to the label.
   */
  key: string
  kind: FieldKind
  /** The raw `type` attribute for inputs (`email`, `tel`, `url`, …); '' otherwise. */
  inputType: string
  label: string
  /** Help text under the label. Ashby puts the real essay prompt here. */
  description: string
  /** Nearest section heading, e.g. "Demographic Survey". Used to spot EEO blocks. */
  section: string
  required: boolean
  /** Visible choices. Empty for a combobox: its list is not in the DOM until opened. */
  options: string[]
  maxLength: number | null
  /** `accept` on a file input. */
  accept: string
}

export type ChallengeKind =
  | 'recaptcha-enterprise'
  | 'recaptcha-v3'
  | 'recaptcha-v2'
  | 'hcaptcha'
  | 'turnstile'
  | 'cloudflare-interstitial'
  | 'email-code'
  | 'login-wall'
  | 'other-bot-check'

export interface ChallengeSignal {
  kind: ChallengeKind
  /**
   * `present` — the page loaded the vendor's script, which every applicant
   * gets and which scores silently. `blocking` — something a person has to
   * act on is on screen. Only `blocking` stops a run.
   */
  state: 'present' | 'blocking'
  evidence: string
}

export type PageState = 'form' | 'confirmation' | 'validation_error' | 'challenge' | 'closed' | 'unknown'

export interface PageClassification {
  state: PageState
  evidence: string
  challenges: ChallengeSignal[]
}
