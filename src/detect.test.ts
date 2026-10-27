// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { classifyPage, detectChallenges } from './detect.js'

function page(body: string, { title = 'Job Application', head = '' } = {}): Document {
  return new DOMParser().parseFromString(`<html><head><title>${title}</title>${head}</head><body>${body}</body></html>`, 'text/html')
}

const FORM = `<form id="application-form"><div class="application--questions">
  <input id="first_name" type="text"><input id="last_name" type="text"><input id="email" type="text">
</div></form>`

describe('detectChallenges', () => {
  it('reports a scoring-only check as present, not blocking', () => {
    const doc = page(FORM, { head: '<script src="https://www.recaptcha.net/recaptcha/enterprise.js?render=KEY"></script>' })
    expect(detectChallenges(doc)).toEqual([expect.objectContaining({ kind: 'recaptcha-enterprise', state: 'present' })])
    expect(classifyPage(doc).state).toBe('form')
  })

  it('tells reCAPTCHA v3 from the v2 checkbox a person must tick', () => {
    const v3 = page(FORM, { head: '<script src="https://www.recaptcha.net/recaptcha/api.js?render=KEY"></script>' })
    expect(detectChallenges(v3)[0]).toMatchObject({ kind: 'recaptcha-v3', state: 'present' })

    const v2 = page(`${FORM}<div class="g-recaptcha" data-sitekey="KEY"></div>`, {
      head: '<script src="https://www.google.com/recaptcha/api.js"></script>',
    })
    expect(detectChallenges(v2)[0]).toMatchObject({ kind: 'recaptcha-v2', state: 'blocking' })
    expect(classifyPage(v2).state).toBe('challenge')
  })

  it('blocks only while the image puzzle is actually shown', () => {
    const frame = (style: string) =>
      page(`${FORM}<div style="${style}"><div><iframe src="https://www.recaptcha.net/recaptcha/enterprise/bframe?k=KEY"></iframe></div></div>`, {
        head: '<script src="https://www.recaptcha.net/recaptcha/enterprise.js?render=KEY"></script>',
      })
    expect(detectChallenges(frame('visibility: hidden; opacity: 0'))[0].state).toBe('present')
    expect(detectChallenges(frame('visibility: visible; opacity: 1'))[0].state).toBe('blocking')
  })

  it('treats Lever’s invisible hCaptcha as present', () => {
    const doc = page(`${FORM}<div id="h-captcha" class="h-captcha" data-sitekey="KEY"></div>`, {
      head: '<script src="https://js.hcaptcha.com/1/secure-api.js"></script>',
    })
    expect(detectChallenges(doc)).toEqual([expect.objectContaining({ kind: 'hcaptcha', state: 'present' })])
  })

  it('stops at a Cloudflare interstitial', () => {
    const doc = page('<div id="challenge"></div>', {
      title: 'Just a moment...',
      head: '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>',
    })
    expect(classifyPage(doc)).toMatchObject({ state: 'challenge' })
    expect(detectChallenges(doc).map((signal) => signal.kind)).toEqual(['cloudflare-interstitial'])
  })

  it('stops when the form asks for a code sent by email, or for a password', () => {
    expect(classifyPage(page(`${FORM}<input id="security-code" type="text">`)).state).toBe('challenge')
    expect(classifyPage(page('<input type="email"><input type="password">')).state).toBe('challenge')
  })
})

describe('classifyPage', () => {
  it('recognises a confirmation once the form is gone', () => {
    expect(classifyPage(page('<h1>Thank you for applying</h1><p>We received your application.</p>')).state).toBe('confirmation')
  })

  it('does not mistake intro copy above a live form for a confirmation', () => {
    expect(classifyPage(page(`<p>Thank you for your interest in Acme.</p>${FORM}`)).state).toBe('form')
  })

  it('reports fields the page marked invalid', () => {
    const doc = page(FORM.replace('id="email"', 'id="email" aria-invalid="true"'))
    expect(classifyPage(doc)).toMatchObject({ state: 'validation_error', evidence: 'invalid: email' })
  })

  it('recognises a posting that has closed', () => {
    expect(classifyPage(page('<h1>This job is no longer accepting applications</h1>')).state).toBe('closed')
  })
})
