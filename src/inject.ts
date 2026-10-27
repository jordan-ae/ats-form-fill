/**
 * Entry point for the bundle that runs inside the page.
 *
 * Built to a single self-contained script and exposed as `__arkooFill`, so a
 * caller that can only pass strings across (Playwright's `evaluate`, an
 * extension's `executeScript`) drives the engine by name.
 */
import { fillField, readField, type FillOptions, type FillValue } from './actuate.js'
import { classifyPage, detectChallenges } from './detect.js'
import { detectAts, extractFormFields } from './formFields.js'
import { formSnapshotHtml } from './snapshot.js'
import type { FormField } from './types.js'

const api = {
  detectAts: () => detectAts(document),
  extractFormFields: () => extractFormFields(document),
  detectChallenges: () => detectChallenges(document),
  classifyPage: () => classifyPage(document),
  formSnapshotHtml: () => formSnapshotHtml(document),
  fillField: (field: Pick<FormField, 'selector' | 'key' | 'kind'>, value: FillValue, options?: FillOptions) =>
    fillField(document, field, value, options),
  readField: (field: Pick<FormField, 'selector' | 'key' | 'kind'>) => readField(document, field),
}

export type ArkooFillApi = typeof api

;(globalThis as unknown as { __arkooFill: ArkooFillApi }).__arkooFill = api
