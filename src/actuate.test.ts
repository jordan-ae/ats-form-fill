// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { fillField, readField } from './actuate.js'
import { extractFormFields } from './formFields.js'
import type { FormField } from './types.js'

function mount(html: string): FormField[] {
  document.body.innerHTML = `<form id="application-form">${html}</form>`
  return extractFormFields(document)
}

const field = (fields: FormField[], key: string): FormField => {
  const found = fields.find((candidate) => candidate.key === key)
  if (!found) throw new Error(`no field ${key}`)
  return found
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('fillField', () => {
  it('types into a text box and fires the events a framework listens for', async () => {
    const fields = mount('<label for="first_name">First Name</label><input id="first_name" type="text">')
    const seen: string[] = []
    const input = document.getElementById('first_name') as HTMLInputElement
    for (const type of ['input', 'change', 'focusout']) input.addEventListener(type, () => seen.push(type))

    const result = await fillField(document, field(fields, 'first_name'), 'Ada')

    expect(result).toMatchObject({ ok: true, observed: 'Ada', reason: '' })
    expect(seen).toEqual(['input', 'change', 'focusout'])
  })

  it('accepts a phone number the widget reformatted', async () => {
    const fields = mount('<label for="phone">Phone</label><input id="phone" type="tel">')
    const input = document.getElementById('phone') as HTMLInputElement
    input.addEventListener('input', () => {
      input.value = '+1 202-555-0143'
    })
    expect((await fillField(document, field(fields, 'phone'), '+1 202 555 0143')).ok).toBe(true)
  })

  it('chooses a select option by its text, not its value', async () => {
    const fields = mount(
      '<label for="country">Country</label><select id="country"><option value="">Select...</option><option value="ID">Indonesia</option><option value="DE">Germany</option></select>',
    )
    const result = await fillField(document, field(fields, 'country'), 'indonesia')
    expect(result).toMatchObject({ ok: true, observed: 'Indonesia' })
    expect((document.getElementById('country') as HTMLSelectElement).value).toBe('ID')
  })

  it('leaves a field alone rather than pick a near-miss option', async () => {
    // The answer "No" must never land on "I do not wish to answer", which a
    // substring match would allow.
    const fields = mount(`
      <fieldset><legend>Do you require sponsorship?</legend>
        <label><input type="radio" name="sponsor" value="1">Yes, now or in the future</label>
        <label><input type="radio" name="sponsor" value="2">I do not wish to answer</label>
      </fieldset>`)
    const result = await fillField(document, field(fields, 'sponsor'), 'No')
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('no option "No"')
    expect(readField(document, field(fields, 'sponsor'))).toBe('')
  })

  it('picks one radio and reports which', async () => {
    const fields = mount(`
      <fieldset><legend>Level</legend>
        <label><input type="radio" name="level" value="a">Junior</label>
        <label><input type="radio" name="level" value="b">Senior</label>
      </fieldset>`)
    expect(await fillField(document, field(fields, 'level'), 'Senior')).toMatchObject({ ok: true, observed: 'Senior' })
  })

  it('sets a checkbox group to exactly the wanted options', async () => {
    const fields = mount(`
      <fieldset><legend>Languages</legend>
        <label><input type="checkbox" name="lang" value="en" checked>English</label>
        <label><input type="checkbox" name="lang" value="fr">French</label>
        <label><input type="checkbox" name="lang" value="id">Indonesian</label>
      </fieldset>`)
    const result = await fillField(document, field(fields, 'lang'), ['French', 'Indonesian'])
    expect(result).toMatchObject({ ok: true, observed: 'French | Indonesian' })
  })

  it('presses Ashby’s Yes / No buttons', async () => {
    const fields = mount(`
      <div class="ashby-application-form-field-entry" data-field-path="auth">
        <label class="ashby-application-form-question-title" for="auth">Are you authorized to work here?</label>
        <div class="ashby-application-form-input-yesno">
          <button type="button" aria-pressed="false">Yes</button><button type="button" aria-pressed="false">No</button>
          <input type="checkbox" name="auth" tabindex="-1">
        </div>
      </div>`)
    for (const button of Array.from(document.querySelectorAll('button'))) {
      button.addEventListener('click', () => {
        document.querySelectorAll('button').forEach((other) => other.setAttribute('aria-pressed', String(other === button)))
      })
    }
    const target = field(fields, 'auth')
    expect(target.kind).toBe('boolean')
    expect(await fillField(document, target, false)).toMatchObject({ ok: true, observed: 'No' })
  })
})

describe('fillField on a typeahead', () => {
  /**
   * A stand-in for Greenhouse's dropdown: opens on mouse-up (not mouse-down),
   * renders its options inside its own shell, shows the choice in
   * `.select__single-value`. Beside it sits the phone widget's country list,
   * which also uses role="option" and is always in the page.
   */
  function mountDropdown(options: string[]): { fields: FormField[]; decoyClicks: () => number } {
    const fields = mount(`
      <ul role="listbox" id="iti-countries"><li role="option" id="decoy">Afghanistan +93</li></ul>
      <div class="select__container">
        <label id="q1-label" for="q1">Are you authorized to work in the U.S.?</label>
        <div class="select-shell">
          <div class="select__control"><div class="select__value"></div>
            <input id="q1" role="combobox" aria-labelledby="q1-label" aria-required="true" type="text">
          </div>
        </div>
      </div>`)
    let clicks = 0
    document.getElementById('decoy')?.addEventListener('click', () => clicks++)

    const shell = document.querySelector('.select-shell') as HTMLElement
    const control = document.querySelector('.select__control') as HTMLElement
    const input = document.getElementById('q1') as HTMLInputElement
    let armed = false
    const render = () => {
      shell.querySelector('.select__menu')?.remove()
      const menu = document.createElement('div')
      menu.className = 'select__menu'
      for (const text of options.filter((option) => option.toLowerCase().includes(input.value.toLowerCase()))) {
        const option = document.createElement('div')
        option.setAttribute('role', 'option')
        option.textContent = text
        option.addEventListener('click', () => {
          const value = document.createElement('div')
          value.className = 'select__single-value'
          value.textContent = text
          control.querySelector('.select__value')?.replaceChildren(value)
          menu.remove()
        })
        menu.appendChild(option)
      }
      shell.appendChild(menu)
    }
    control.addEventListener('mousedown', () => (armed = true))
    control.addEventListener('mouseup', () => armed && render())
    input.addEventListener('input', render)
    return { fields, decoyClicks: () => clicks }
  }

  it('opens the list and takes the exact option', async () => {
    const { fields } = mountDropdown(['Yes', 'No'])
    expect(await fillField(document, field(fields, 'q1'), 'No')).toMatchObject({ ok: true, observed: 'No' })
  })

  it('never reaches into another widget’s option list', async () => {
    const { fields, decoyClicks } = mountDropdown(['Yes', 'No'])
    const result = await fillField(document, field(fields, 'q1'), 'Afghanistan +93')
    expect(result.ok).toBe(false)
    expect(decoyClicks()).toBe(0)
    // Nothing half-typed is left in the box.
    expect((document.getElementById('q1') as HTMLInputElement).value).toBe('')
  }, 10_000)

  it('takes the top suggestion when asked to', async () => {
    const { fields } = mountDropdown(['Jakarta, Indonesia', 'Jakarta Selatan, Indonesia'])
    const result = await fillField(document, field(fields, 'q1'), 'Jakarta', { pick: 'first' })
    expect(result).toMatchObject({ ok: true, observed: 'Jakarta, Indonesia' })
  })
})
