import type { FormAts } from './types.js'

/** A posting on one of the ATSs we can fill. */
export interface PostingRef {
  ats: Exclude<FormAts, 'unknown'>
  /** The employer's board slug. */
  board: string
  jobId: string
  /** The posting's public apply link; only read to tell an EU-hosted board from a US one. */
  applyUrl?: string
}

/** Hosts the fill engine is allowed to run on. The extension's manifest and
 * the cloud executor's navigation guard are both built from this list. */
export const FORM_HOSTS: Record<PostingRef['ats'], string[]> = {
  greenhouse: ['job-boards.greenhouse.io', 'job-boards.eu.greenhouse.io', 'boards.greenhouse.io', 'boards.eu.greenhouse.io'],
  ashby: ['jobs.ashbyhq.com'],
  lever: ['jobs.lever.co', 'jobs.eu.lever.co'],
}

/**
 * The ATS-hosted application form for a posting.
 *
 * Deliberately not the posting's apply link. About a quarter of Greenhouse postings
 * point at the employer's own careers site, which wraps the same form in an
 * iframe behind whatever that site adds (Coinbase's sits behind a Cloudflare
 * check). Greenhouse's `embed/job_app` URL is the form that iframe loads, and
 * it answered for every board sampled, custom careers site or not.
 */
export function formUrl(ref: PostingRef): string {
  const board = encodeURIComponent(ref.board)
  const jobId = encodeURIComponent(ref.jobId)
  const eu = /\.eu\.(greenhouse\.io|lever\.co)/i.test(ref.applyUrl ?? '')

  switch (ref.ats) {
    case 'greenhouse':
      return `https://job-boards.${eu ? 'eu.' : ''}greenhouse.io/embed/job_app?for=${board}&token=${jobId}`
    case 'ashby':
      return `https://jobs.ashbyhq.com/${board}/${jobId}/application`
    case 'lever':
      return `https://jobs.${eu ? 'eu.' : ''}lever.co/${board}/${jobId}/apply`
  }
}

/** True when `url` is one of the hosted forms above. */
export function isFormHost(url: string): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return Object.values(FORM_HOSTS).some((hosts) => hosts.includes(host))
}
