// Pure lead-recovery logic: who is going cold, how valuable they are, what to say.

import { daysBetween, isEmail, isISODate, parseAmount, parseCsvObjects, parseDateLoose, toMinor } from '@saas/core';

export const OPEN_STATUSES = ['new', 'contacted', 'replied'];
export const STATUSES = ['new', 'contacted', 'replied', 'won', 'lost'];
export const STATUS_LABEL = { new: 'New', contacted: 'Contacted', replied: 'Replied', won: 'Won', lost: 'Lost' };

export const STAGES = [
  { key: 'nudge', label: 'Friendly nudge' },
  { key: 'value', label: 'Value follow-up' },
  { key: 'breakup', label: 'Closing the loop' },
];

export function daysSinceContact(lead, today) {
  return Math.max(0, daysBetween(lead.last_contact_on || lead.created_on, today));
}

export function isStale(lead, today, staleDays = 7) {
  if (lead.snoozed_until && today < lead.snoozed_until) return false; // snoozed: hidden until that date
  return OPEN_STATUSES.includes(lead.status) && !lead.do_not_contact && daysSinceContact(lead, today) >= staleDays;
}

/**
 * Priority score used to rank who to follow up first (higher = sooner).
 * Roughly "expected recovery value": deal size (square-root scaled so one huge
 * deal doesn't bury every other lead) x how likely a lead still is to respond
 * (decays the longer they've been quiet) x a status weight (replied leads are
 * warmer than ones we never reached).
 */
export function leadScore(lead, today) {
  const days = daysSinceContact(lead, today);
  const major = Math.max(lead.value / 100, 10);
  const recency = days <= 7 ? 1 : days <= 30 ? 0.85 : days <= 60 ? 0.6 : days <= 120 ? 0.35 : 0.15;
  const status = { replied: 1.3, contacted: 1, new: 0.9 }[lead.status] ?? 0;
  return Math.round(Math.sqrt(major) * recency * status);
}

/** Next stage given how many follow-ups already went out. The first touch is never the break-up note. */
export const pickStage = (sentCount) => Math.min(sentCount, STAGES.length - 1);

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';

export function templateDraft({ lead, stage, settings, user }) {
  const first = firstName(lead.name);
  const business = settings.business_name || user.name;
  const sender = settings.sender_name || user.name;
  const forCompany = lead.company ? ` for ${lead.company}` : '';
  const book = settings.booking_link ? `\n\nYou can pick a time that suits you here: ${settings.booking_link}` : '';
  const offer = settings.offer ? ` ${settings.offer.replace(/\s+$/, '')}` : '';
  const sign = `Best,\n${sender}${business && business !== sender ? `\n${business}` : ''}`;
  if (stage === 0) {
    return {
      subject: `Quick follow-up, ${first}`,
      body: `Hi ${first},\n\nI wanted to follow up on your enquiry${forCompany}.${offer}\n\nIs this still something you're looking at? If so, just reply and I'll send over the details.${book}\n\n${sign}`,
    };
  }
  if (stage === 1) {
    return {
      subject: `Still keen to help${lead.company ? `, ${lead.company}` : ''}`,
      body: `Hi ${first},\n\nChecking back in${forCompany}.${offer}\n\nIf it would help, I can put together a short, no-obligation plan tailored to what you need. Just tell me what matters most and I'll take it from there.${book}\n\n${sign}`,
    };
  }
  return {
    subject: `Should I close your file, ${first}?`,
    body: `Hi ${first},\n\nI haven't heard back, so I'll assume the timing isn't right and close your file for now.\n\nIf I've got that wrong, reply with "yes" and I'll pick things straight back up.${book}\n\nAll the best,\n${sender}${business && business !== sender ? `\n${business}` : ''}`,
  };
}

/** Normalise free-text pipeline stages from CRMs into our five statuses. */
export function normalizeStatus(raw) {
  const s = String(raw ?? '').toLowerCase().trim();
  if (!s) return 'new';
  if (/(won|closed.?won|converted|customer|signed|paid)/.test(s)) return 'won';
  if (/(lost|dead|closed.?lost|unqualified|junk|not interested|dnc|spam)/.test(s)) return 'lost';
  if (/(repl|respond|interested|meeting|demo|negotiat|proposal)/.test(s)) return 'replied';
  if (/(contact|follow|quoted|called|emailed|attempt|open|working)/.test(s)) return 'contacted';
  return 'new';
}

export const CSV_ALIASES = {
  name: ['full_name', 'contact', 'contact_name', 'lead', 'lead_name', 'customer', 'person'],
  email: ['email_address', 'e_mail', 'mail'],
  phone: ['mobile', 'mobile_number', 'whatsapp', 'tel', 'telephone', 'phone_number', 'contact_number'],
  company: ['organisation', 'organization', 'business', 'company_name', 'account'],
  source: ['lead_source', 'channel', 'origin', 'campaign'],
  status: ['stage', 'lead_status', 'pipeline_stage', 'state'],
  value: ['deal_value', 'amount', 'potential', 'budget', 'estimated_value', 'deal_size'],
  last_contact: ['last_contacted', 'last_contact_date', 'last_activity', 'last_activity_date', 'last_touch'],
  notes: ['comments', 'remarks', 'note', 'description'],
  created: ['created_at', 'created_on', 'date', 'enquiry_date', 'lead_date', 'created_date'],
};

/** Returns { rows, errors, missing } from pasted CSV. Needs a name or an email per row. */
export function parseLeadCsv(text, { dayFirst = false, today } = {}) {
  const { rows: raw, columns } = parseCsvObjects(text, { aliases: CSV_ALIASES, maxRows: 25000 });
  if (!columns.some((c) => ['name', 'email'].includes(c))) return { rows: [], errors: [], missing: ['name or email'] };
  const rows = [];
  const errors = [];
  raw.forEach((r, i) => {
    const line = i + 2;
    const email = (r.email ?? '').toLowerCase();
    const name = (r.name ?? '').slice(0, 120) || (email ? email.split('@')[0] : '');
    if (!name) return errors.push({ line, message: 'No name or email' });
    if (email && !isEmail(email)) errors.push({ line, message: `${name}: "${r.email}" is not a valid email (kept without email)` });
    const value = r.value ? parseAmount(r.value) : 0;
    const created = r.created ? parseDateLoose(r.created, { dayFirst }) : null;
    let last = r.last_contact ? parseDateLoose(r.last_contact, { dayFirst }) : null;
    if (last && today && last > today) last = today;
    rows.push({
      name,
      email: isEmail(email) ? email : '',
      phone: (r.phone ?? '').replace(/[^\d+()\-\s]/g, '').slice(0, 30),
      company: (r.company ?? '').slice(0, 120),
      source: (r.source ?? '').slice(0, 60),
      status: normalizeStatus(r.status),
      value: Number.isFinite(value) && value > 0 ? toMinor(value) : 0,
      last_contact_on: last && isISODate(last) ? last : null,
      created_on: created && isISODate(created) && (!today || created <= today) ? created : null,
      notes: (r.notes ?? '').slice(0, 1000),
    });
  });
  return { rows, errors, missing: [] };
}

export const waDigits = (phone, currency) => {
  const d = String(phone ?? '').replace(/\D/g, '');
  if (d.length === 10 && currency === 'INR') return `91${d}`;
  return d.length >= 8 && d.length <= 15 ? d : '';
};
