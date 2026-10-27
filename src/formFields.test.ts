// @vitest-environment happy-dom
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { detectAts, extractFormFields } from './formFields.js'
import type { FormField } from './types.js'

/**
 * Runs the extractor over real application forms, saved from the live pages
 * with `formSnapshotHtml`. Each `<slug>.fields.json` is the expected output
 * for `<slug>.html`; after a deliberate change to the extractor, regenerate
 * them with `UPDATE_FIXTURES=1 npx vitest run` and read the diff.
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__')
const UPDATE = process.env.UPDATE_FIXTURES === '1'

interface Fixture {
  ats: 'greenhouse' | 'ashby' | 'lever'
  slug: string
  html: string
  fieldsPath: string
  schema: any
}

function loadFixtures(): Fixture[] {
  const fixtures: Fixture[] = []
  for (const ats of ['greenhouse', 'ashby', 'lever'] as const) {
    const dir = join(FIXTURES, ats)
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.html')).sort()) {
      const slug = file.replace(/\.html$/, '')
      const schemaPath = join(dir, `${slug}.schema.json`)
      fixtures.push({
        ats,
        slug,
        html: readFileSync(join(dir, file), 'utf8'),
        fieldsPath: join(dir, `${slug}.fields.json`),
        schema: existsSync(schemaPath) ? JSON.parse(readFileSync(schemaPath, 'utf8')) : null,
      })
    }
  }
  return fixtures
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

const fixtures = loadFixtures()

describe('extractFormFields on captured forms', () => {
  it('has fixtures for every supported ATS', () => {
    expect(new Set(fixtures.map((fixture) => fixture.ats))).toEqual(new Set(['greenhouse', 'ashby', 'lever']))
  })

  describe.each(fixtures.map((fixture) => [`${fixture.ats}/${fixture.slug}`, fixture] as const))('%s', (_name, fixture) => {
    const doc = parse(fixture.html)
    const fields = extractFormFields(doc)

    it('recognises the ATS from the markup alone', () => {
      expect(detectAts(doc)).toBe(fixture.ats)
    })

    it('matches the recorded fields', () => {
      if (UPDATE) writeFileSync(fixture.fieldsPath, `${JSON.stringify(fields, null, 2)}\n`)
      expect(fields).toEqual(JSON.parse(readFileSync(fixture.fieldsPath, 'utf8')))
    })

    it('gives every field a label, a unique key and a selector that resolves', () => {
      const keys = fields.map((field) => field.key)
      expect(new Set(keys).size).toBe(keys.length)
      for (const field of fields) {
        expect(field.label, `label of ${field.key}`).not.toBe('')
        expect(field.key).not.toBe('')
        expect(doc.querySelectorAll(field.selector).length, `selector ${field.selector}`).toBeGreaterThan(0)
      }
    })

    it('finds every question the ATS itself says is on the form', () => {
      const keys = new Set(fields.map((field) => field.key))
      expect(expectedKeys(fixture).filter((key) => !keys.has(key))).toEqual([])
    })
  })
})

describe('extractFormFields', () => {
  it('never offers Ashby’s "Autofill from resume" uploader as a question', () => {
    const files = fixtures
      .filter((fixture) => fixture.ats === 'ashby')
      .flatMap((fixture) => extractFormFields(parse(fixture.html)).filter((field) => field.kind === 'file'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) expect(file.label).not.toBe('')
  })

  it('reads the help text that carries the real question', () => {
    // Blissway's form: a checkbox whose description tells people not to tick
    // it. Without the description the title alone reads as a routine consent.
    const blissway = fixtures.find((fixture) => fixture.slug.startsWith('blissway'))
    if (!blissway) return
    const trap = extractFormFields(parse(blissway.html)).find((field) => /bot-trap/i.test(field.description))
    expect(trap).toBeDefined()
    expect(trap?.required).toBe(false)
  })

  it('collapses radios and same-question checkboxes into one field with options', () => {
    const doc = parse(`<html><body><form id="application-form">
      <ul><li class="application-question"><div class="application-label">Level<span class="required">✱</span></div>
        <label><input type="radio" name="level" value="a"><span>Junior</span></label>
        <label><input type="radio" name="level" value="b"><span>Senior</span></label>
      </li></ul></form></body></html>`)
    const [field, ...rest] = extractFormFields(doc)
    expect(rest).toEqual([])
    expect(field).toMatchObject({ kind: 'radio', key: 'level', label: 'Level', required: true, options: ['Junior', 'Senior'] })
  })

  it('skips blocks the page has switched off', () => {
    const doc = parse(`<html><body><form id="application-form">
      <ul><li class="application-question"><div class="application-label">Shown</div><input type="text" name="shown"></li></ul>
      <div class="section hidden"><ul><li class="application-question"><div class="application-label">Survey</div><input type="text" name="survey"></li></ul></div>
      <div style="display: none"><input type="text" name="inline"></div>
    </form></body></html>`)
    expect(extractFormFields(doc).map((field: FormField) => field.key)).toEqual(['shown'])
  })
})

/** Field identifiers taken from the ATS's own form definition. */
function expectedKeys(fixture: Fixture): string[] {
  if (!fixture.schema) return []

  if (fixture.ats === 'greenhouse') {
    const keys = (fixture.schema.questions ?? [])
      .flatMap((question: any) => (question.fields ?? []).map((field: any) => String(field.name)))
      // "Enter manually" alternatives to the file inputs; not in the page until asked for.
      .filter((name: string) => !/_text$/.test(name))
    // The API's location block (location + latitude + longitude) is one
    // place-autocomplete box on the page, which fills the coordinates itself.
    if ((fixture.schema.location_questions ?? []).length > 0) keys.push('candidate-location')
    return keys
  }

  if (fixture.ats === 'ashby') {
    return (fixture.schema.applicationForm?.sections ?? [])
      .filter((section: any) => !section.isHidden)
      .flatMap((section: any) => section.fieldEntries ?? [])
      .filter((entry: any) => !entry.isHidden)
      .map((entry: any) => String(entry.field?.path))
  }

  return []
}
