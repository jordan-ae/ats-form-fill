# ats-form-fill

Read, fill and read back job application forms hosted on **Greenhouse**, **Ashby** and **Lever**, using nothing but the DOM.

This is the form engine behind Autopilot, the application agent in [Arkoo](https://arkoojobs.com). Arkoo's Chrome extension bundles it into a content script, and its cloud browser injects the same bundle into the page. A form filled while a person watches and one filled by the agent run identical code.

## What it does

- **Extracts every question** on the form, in order: label, help text, section, whether it's required, its options, and the ATS's own field key. It reads markup only, never layout, so a visible tab, a headless browser and a test DOM all give the same answer.
- **Fills one field at a time** the way a person's browser would, firing the DOM events React and other frameworks listen for. That covers text, selects, typeahead comboboxes, radios, checkbox groups, Ashby's yes/no buttons, dates and file uploads.
- **Reads every value back** from the page afterwards and reports what the control actually shows.
- **Never guesses.** A choice is only made when an option's text matches the value. If nothing matches, the field is left alone and the result says why.
- **Classifies the page**: form, confirmation, validation error, closed posting or bot check. It tells a scoring-only CAPTCHA script, which every applicant gets, from a check a person has to act on. Detection only; the engine never touches a challenge.
- **Knows where the real form lives.** About a quarter of Greenhouse postings wrap the form in an iframe on the employer's own careers site. `formUrl` goes straight to the hosted form instead.

## Install

```bash
npm install github:jordan-ae/ats-form-fill
```

## Use

In code that has a `document`, such as a content script or a test:

```ts
import { extractFormFields, fillField, readField, classifyPage } from 'ats-form-fill'

const fields = extractFormFields(document)
const email = fields.find((f) => f.inputType === 'email')
if (email) {
  const result = await fillField(document, email, 'ada@example.com')
  // { key, ok, observed: 'ada@example.com', reason: '' }
}
classifyPage(document) // { state: 'form', evidence, challenges }
```

From a driven browser, inject the prebuilt bundle (`npm run build` writes `dist/fill.iife.js`). It exposes the same API as `window.__arkooFill`:

```ts
import { formUrl } from 'ats-form-fill'

await page.addInitScript({ path: 'node_modules/ats-form-fill/dist/fill.iife.js' })
await page.goto(formUrl({ ats: 'greenhouse', board: 'airbnb', jobId: '8249626' }))
const fields = await page.evaluate(() => window.__arkooFill.extractFormFields())
```

Typeahead fields take a `pick` option: `'exact'` (the default) only takes an option whose text equals the value, and `'first'` types the value and takes the top suggestion. Use `'first'` for place lookups like "Jakarta" → "Jakarta, Indonesia".

## Tested against real forms

`src/__fixtures__` holds 25 application forms saved from the live sites with `formSnapshotHtml`:

| ATS | Forms |
|---|---|
| Greenhouse | Airbnb, AlphaSense, Boulevard, Coinbase, Instacart, Jumio, Maven Clinic, Natera, Reddit, Samsara |
| Ashby | Ashby, Blissway, Felix, Handshake, Headway, Hiya, OpenAI, Roboflow, Vanta, Writer |
| Lever | CaptivateIQ, Coupa, EnableComp, People.ai, Spotify |

Each form has a `.fields.json` with the expected extraction, so any change to the extractor shows up as a diff. After a deliberate change, regenerate them and read that diff:

```bash
UPDATE_FIXTURES=1 npx vitest run
```

```bash
npm test          # 125 tests, happy-dom, no network
npm run typecheck
npm run build     # dist/ (ESM + types) and dist/fill.iife.js
```

## Scope

It fills what it's told to fill. Deciding what the answers should be, attaching the right CV and choosing when to submit are the caller's job. In Arkoo, factual answers like work authorisation, salary and notice period come only from what the applicant has stored.
