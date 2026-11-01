import { workflow, node, trigger, sticky, placeholder, newCredential, ifElse, switchCase, merge, splitInBatches, nextBatch, expr } from '@n8n/workflow-sdk';
const poll_schedule = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.2,
  config: { name: 'Poll schedule', parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 60 }] } } }
});

const settings = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: { name: 'Settings', parameters: { assignments: { assignments: [{ id: 'poll-interval', name: 'poll_interval_minutes', value: 60, type: 'number' }, { id: 'daily-budget', name: 'daily_budget', value: 40, type: 'number' }, { id: 'calendar-id', name: 'calendar_id', value: 'primary', type: 'string' }] }, includeOtherFields: true, options: {} }, position: [220, 0] }
});

const poll_state = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Poll state',
    parameters: {
      jsCode: `// Poll state: picks the ids to ask Fireflies for, one request per round.
// A round is serial: one fetch, its post and the post answer, then the next id.
// Static data holds only day, used, posted and pending (id -> ISO time).
// A failed list (not a rate limit) ends the poll at the failed stop, with no other request.
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED = ['__proto__', 'constructor', 'prototype'];
const MAX_TRIES = 3;
const MAX_POSTS = 4;
const WINDOW_MS = 48 * 60 * 60 * 1000;
const validId = (v) => typeof v === 'string' && ID.test(v) && !RESERVED.includes(v);
const isoOk = (v) => typeof v === 'string' && /^\\d{4}-\\d{2}-\\d{2}T/.test(v) && !Number.isNaN(Date.parse(v));
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const s = $getWorkflowStaticData('global');
for (const k of Object.keys(s)) {
  if (!['day', 'used', 'posted', 'pending'].includes(k)) delete s[k];
}
if (typeof s.day !== 'string') s.day = '';
if (!Number.isInteger(s.used) || s.used < 0) s.used = 0;
for (const f of ['posted', 'pending']) {
  const cur = s[f];
  if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) {
    s[f] = {};
  } else {
    for (const k of Object.keys(cur)) {
      if (!validId(k) || !isoOk(cur[k])) delete cur[k];
    }
  }
}

const b = Number($('Settings').first().json.daily_budget);
const budget = Number.isFinite(b) && b >= 0 ? Math.floor(b) : 0;
const now = new Date();
const nowIso = now.toISOString();
const today = nowIso.slice(0, 10);
if (s.day !== today) {
  s.day = today;
  s.used = 0;
}
for (const k of Object.keys(s.posted)) {
  if (now.getTime() - Date.parse(s.posted[k]) > WINDOW_MS) delete s.posted[k];
}
const reserve = () => {
  if (s.used + 1 > budget) return false;
  s.used += 1;
  return true;
};

const ok2xx = (r) => typeof r.statusCode === 'number' && r.statusCode >= 200 && r.statusCode < 300;
const rateLimited = (r) => {
  if (r.statusCode === 429) return true;
  const errs = r.body && Array.isArray(r.body.errors) ? r.body.errors : [];
  return errs.some((e) => e && ((e.extensions && e.extensions.code) ?? e.code) === 'too_many_requests');
};
// The carry travels in the items: the ids still to fetch and the stop to emit when the round ends.
const carryOf = (ctx) => {
  const st = ctx.stop;
  const stop =
    st !== null && typeof st === 'object' && (st.next === 'failed' || st.next === 'rejected') && validId(st.id)
      ? { next: st.next, id: st.id }
      : undefined;
  return { queue: Array.isArray(ctx.queue) ? ctx.queue.filter(validId) : [], stop };
};
const withCarry = (poll, carry) => (carry.stop ? { ...poll, queue: carry.queue, stop: carry.stop } : { ...poll, queue: carry.queue });
const req = (next, id, attempt, carry) => ({ json: { poll: withCarry({ next, id, attempt }, carry) } });
const end = (carry, out) => {
  if (carry.stop) out.push({ json: { poll: carry.stop } });
};
const cont = (carry, out) => {
  if (carry.queue.length > 0 && reserve()) {
    out.push(req('fetch', carry.queue[0], 1, { queue: carry.queue.slice(1), stop: carry.stop }));
  } else {
    end(carry, out);
  }
};

const out = [];
const items = $input.all();
for (let i = 0; i < items.length; i++) {
  const j = items[i].json;
  if (j === null || typeof j !== 'object') continue;

  if ('daily_budget' in j) {
    if ('body' in j) {
      const body = j.body;
      const id = body !== null && typeof body === 'object' && !Array.isArray(body) ? body.meetingId : undefined;
      if (validId(id) && !has(s.posted, id) && reserve()) out.push(req('fetch', id, 1, { queue: [] }));
    } else if (reserve()) {
      out.push({ json: { poll: { next: 'list' } } });
    }
    continue;
  }

  const row = $('Poll route').itemMatching(i).json;
  const ctx = row ? row.poll : undefined;
  if (!ctx || typeof ctx !== 'object') continue;
  const carry = carryOf(ctx);

  if (ctx.next === 'post' || ctx.next === 'repost') {
    if (!validId(ctx.id)) {
      end(carry, out);
      continue;
    }
    const code = typeof j.statusCode === 'number' ? j.statusCode : 0;
    if (code === 200 || code === 201) {
      s.posted[ctx.id] = nowIso;
      delete s.pending[ctx.id];
      cont(carry, out);
    } else if (code === 502 || code === 503) {
      const attempt = ctx.next === 'repost' && Number.isInteger(ctx.attempt) ? ctx.attempt : 1;
      if (attempt < MAX_POSTS) {
        out.push({ json: { poll: withCarry({ next: 'repost', id: ctx.id, attempt: attempt + 1 }, carry), transcript: row.transcript } });
      } else {
        end(carry, out);
      }
    } else if (code >= 400 && code < 500) {
      s.posted[ctx.id] = nowIso;
      delete s.pending[ctx.id];
      cont({ queue: carry.queue, stop: carry.stop ?? { next: 'rejected', id: ctx.id } }, out);
    } else {
      cont(carry, out);
    }
    continue;
  }

  if (rateLimited(j)) {
    end(carry, out);
    continue;
  }

  if (ctx.next === 'list') {
    const list = j.body && j.body.data ? j.body.data.transcripts : undefined;
    if (!ok2xx(j) || !Array.isArray(list)) {
      out.push({ json: { poll: { next: 'failed' } } });
      continue;
    }
    const seen = new Set();
    const sel = [];
    const add = (id) => {
      if (validId(id) && !has(s.posted, id) && !seen.has(id)) {
        seen.add(id);
        sel.push(id);
      }
    };
    for (const t of list) {
      if (t && !has(s.pending, t.id)) add(t.id);
    }
    for (const id of Object.keys(s.pending)) add(id);
    for (const id of sel) {
      if (!has(s.pending, id)) s.pending[id] = nowIso;
    }
    if (sel.length > 0 && reserve()) out.push(req('fetch', sel[0], 1, { queue: sel.slice(1) }));
    continue;
  }

  if (ctx.next === 'fetch' || ctx.next === 'retry') {
    if (!validId(ctx.id)) {
      end(carry, out);
      continue;
    }
    const tr = j.body && j.body.data ? j.body.data.transcript : undefined;
    if (ok2xx(j) && tr && tr.id === ctx.id) {
      out.push({ json: { poll: withCarry({ next: 'post', id: ctx.id }, carry), transcript: tr } });
    } else {
      const attempt = Number.isInteger(ctx.attempt) ? ctx.attempt : MAX_TRIES;
      if (attempt < MAX_TRIES) {
        if (reserve()) out.push(req('retry', ctx.id, attempt + 1, carry));
        else end(carry, out);
      } else {
        if (has(s.pending, ctx.id)) {
          const first = s.pending[ctx.id];
          delete s.pending[ctx.id];
          s.pending[ctx.id] = first;
        }
        cont({ queue: carry.queue, stop: carry.stop ?? { next: 'failed', id: ctx.id } }, out);
      }
    }
  }
}
return out;
`
    },
    position: [440, 100]
  }
});

const poll_route = node({
  type: 'n8n-nodes-base.switch',
  version: 3.2,
  config: { name: 'Poll route', parameters: { rules: { values: [{ conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ id: 'next-list', leftValue: expr('{{ $json.poll.next }}'), rightValue: 'list', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, renameOutput: true, outputKey: 'list' }, { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ id: 'next-fetch', leftValue: expr('{{ $json.poll.next }}'), rightValue: 'fetch', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, renameOutput: true, outputKey: 'fetch' }, { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ id: 'next-retry', leftValue: expr('{{ $json.poll.next }}'), rightValue: 'retry', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, renameOutput: true, outputKey: 'retry' }, { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ id: 'next-post', leftValue: expr('{{ $json.poll.next }}'), rightValue: 'post', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, renameOutput: true, outputKey: 'post' }, { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ id: 'next-failed', leftValue: expr('{{ $json.poll.next }}'), rightValue: 'failed', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, renameOutput: true, outputKey: 'failed' }, { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ id: 'next-repost', leftValue: expr('{{ $json.poll.next }}'), rightValue: 'repost', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, renameOutput: true, outputKey: 'repost' }, { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ id: 'next-rejected', leftValue: expr('{{ $json.poll.next }}'), rightValue: 'rejected', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, renameOutput: true, outputKey: 'rejected' }] }, options: {} }, position: [660, 100] }
});

const list_transcripts = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: { name: 'List transcripts', parameters: { method: 'POST', url: 'https://api.fireflies.ai/graphql', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', sendBody: true, specifyBody: 'json', jsonBody: expr('{{ JSON.stringify({ query: "query($from: DateTime) { transcripts(fromDate: $from, limit: 50) { id date } }", variables: { from: $now.minus({ hours: 24 }).toISO() } }) }}'), options: { response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } } }, credentials: { httpHeaderAuth: newCredential('Fireflies API') }, position: [880, -120], onError: 'continueErrorOutput' }
});

const fetch_transcript = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: { name: 'Fetch transcript', parameters: { method: 'POST', url: 'https://api.fireflies.ai/graphql', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', sendBody: true, specifyBody: 'json', jsonBody: expr('{{ JSON.stringify({ query: "query($id: String!) { transcript(id: $id) { id title date duration transcript_url organizer_email participants meeting_attendees { displayName email name } sentences { speaker_name text start_time } } }", variables: { id: $json.poll.id } }) }}'), options: { response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } } }, credentials: { httpHeaderAuth: newCredential('Fireflies API') }, position: [880, 100], onError: 'continueErrorOutput' }
});

const retry_wait = node({
  type: 'n8n-nodes-base.wait',
  version: 1.1,
  config: { name: 'Retry wait', parameters: { resume: 'timeInterval', amount: 5, unit: 'seconds' }, position: [880, 320] }
});

const calendar_events = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: { name: 'Calendar events', parameters: { method: 'GET', url: expr('{{ \'https://www.googleapis.com/calendar/v3/calendars/\' + encodeURIComponent(($(\'Settings\').isExecuted ? $(\'Settings\').first().json.calendar_id : \'primary\')) + \'/events\' }}'), authentication: 'predefinedCredentialType', nodeCredentialType: 'googleCalendarOAuth2Api', sendQuery: true, queryParameters: { parameters: [{ name: 'singleEvents', value: 'true' }, { name: 'maxResults', value: '50' }, { name: 'timeMin', value: expr('{{ new Date($(\'Poll route\').item.json.transcript.date - 30 * 60000).toISOString() }}') }, { name: 'timeMax', value: expr('{{ new Date($(\'Poll route\').item.json.transcript.date + $(\'Poll route\').item.json.transcript.duration * 60000 + 30 * 60000).toISOString() }}') }] }, options: {} }, credentials: { googleCalendarOAuth2Api: newCredential('Google Calendar') }, position: [1100, 100], retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: 'continueErrorOutput' }
});

const source_or_calendar_failed = node({
  type: 'n8n-nodes-base.stopAndError',
  version: 1,
  config: { name: 'Source or calendar failed', parameters: { errorMessage: 'Fireflies list, Fireflies transcript or calendar request failed; only the transcript and calendar requests are tried 3 times' }, position: [1100, 320] }
});

const post_meeting = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: { name: 'Post meeting', parameters: { method: 'POST', url: 'http://brain:3000/meetings', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', sendBody: true, specifyBody: 'json', jsonBody: expr('{{ JSON.stringify({ source: "fireflies", transcript: $(\'Poll route\').item.json.transcript, calendar_events: ($json.items ?? []).slice(0, 50).map(e => ({ ...e, title: e.summary, calendar_id: ($(\'Settings\').isExecuted ? $(\'Settings\').first().json.calendar_id : \'primary\') })) }) }}'), options: { response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } } }, credentials: { httpHeaderAuth: newCredential('2brain ingest') }, position: [1320, 100], onError: 'continueErrorOutput' }
});

const post_wait = node({
  type: 'n8n-nodes-base.wait',
  version: 1.1,
  config: { name: 'Post wait', parameters: { resume: 'timeInterval', amount: 60, unit: 'seconds' }, position: [880, 540] }
});

const ingest_refused = node({
  type: 'n8n-nodes-base.stopAndError',
  version: 1,
  config: { name: 'Ingest refused', parameters: { errorMessage: '2brain ingest refused a transcript with a 4xx answer; the Post meeting output shows which one' }, position: [1320, 320] }
});

const fireflies_webhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2,
  config: { name: 'Fireflies webhook', parameters: { httpMethod: 'POST', path: 'REPLACE-WITH-RANDOM-PATH', options: {} }, position: [0, 220], disabled: true }
});

const completed_only = node({
  type: 'n8n-nodes-base.if',
  version: 2.2,
  config: { name: 'Completed only', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ id: 'event-type', leftValue: expr('{{ $json.body.eventType }}'), rightValue: 'Transcription completed', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, options: {} }, position: [440, 220] }
});

const wf = workflow('', '2brain meetings: Fireflies', { executionOrder: 'v1' });

export default wf
  .add(poll_schedule)
  .to(settings)
  .to(poll_state)
  .to(poll_route.onCase(0, list_transcripts
    .onError(poll_state)
    .to(poll_state)).onCase(1, fetch_transcript
    .onError(poll_state)
    .to(poll_state)).onCase(2, retry_wait
    .to(fetch_transcript)).onCase(3, calendar_events
    .onError(source_or_calendar_failed)
    .to(post_meeting
    .onError(poll_state))
    .to(poll_state)).onCase(4, source_or_calendar_failed).onCase(5, post_wait
    .to(calendar_events)).onCase(6, ingest_refused))
  .add(fireflies_webhook)
  .to(completed_only.onTrue(settings))