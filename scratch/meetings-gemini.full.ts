import { workflow, node, trigger, sticky, placeholder, newCredential, ifElse, switchCase, merge, splitInBatches, nextBatch, expr } from '@n8n/workflow-sdk';
const poll_schedule = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.2,
  config: { name: 'Poll schedule', parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 60 }] } } }
});

const settings = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: { name: 'Settings', parameters: { assignments: { assignments: [{ id: 'calendar-id', name: 'calendar_id', value: 'primary', type: 'string' }] }, options: {} }, position: [220, 0] }
});

const list_conference_records = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: { name: 'List conference records', parameters: { method: 'GET', url: 'https://meet.googleapis.com/v2/conferenceRecords', authentication: 'predefinedCredentialType', nodeCredentialType: 'googleOAuth2Api', sendQuery: true, queryParameters: { parameters: [{ name: 'pageSize', value: '100' }, { name: 'filter', value: expr('{{ \'end_time>="\' + new Date(Date.now() - 24 * 3600000).toISOString() + \'"\' }}') }] }, options: { pagination: { pagination: { paginationMode: 'updateAParameterInEachRequest', parameters: { parameters: [{ type: 'qs', name: 'pageToken', value: expr('{{ $response.body.nextPageToken }}') }] }, paginationCompleteWhen: 'other', completeExpression: expr('{{ !$response.body.nextPageToken }}') } } } }, credentials: { googleOAuth2Api: newCredential('Google Meet') }, position: [440, 0], retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: 'continueErrorOutput' }
});

const meet_or_calendar_failed = node({
  type: 'n8n-nodes-base.stopAndError',
  version: 1,
  config: { name: 'Meet or calendar failed', parameters: { errorMessage: 'Meet or calendar request failed after 3 tries' }, position: [2640, 220] }
});

const has_records = node({
  type: 'n8n-nodes-base.if',
  version: 2.2,
  config: { name: 'Has records', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ id: 'has-records', leftValue: expr('{{ ($json.conferenceRecords ?? []).length }}'), rightValue: 0, operator: { type: 'number', operation: 'gt' } }], combinator: 'and' }, options: {} }, position: [660, 0] }
});

const split_records = node({
  type: 'n8n-nodes-base.splitOut',
  version: 1,
  config: { name: 'Split records', parameters: { fieldToSplitOut: 'conferenceRecords', options: {} }, position: [880, 0] }
});

const list_transcripts = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: { name: 'List transcripts', parameters: { method: 'GET', url: expr('{{ \'https://meet.googleapis.com/v2/\' + $json.name + \'/transcripts\' }}'), authentication: 'predefinedCredentialType', nodeCredentialType: 'googleOAuth2Api', sendQuery: true, queryParameters: { parameters: [{ name: 'pageSize', value: '100' }] }, options: { pagination: { pagination: { paginationMode: 'updateAParameterInEachRequest', parameters: { parameters: [{ type: 'qs', name: 'pageToken', value: expr('{{ $response.body.nextPageToken }}') }] }, paginationCompleteWhen: 'other', completeExpression: expr('{{ !$response.body.nextPageToken }}') } } } }, credentials: { googleOAuth2Api: newCredential('Google Meet') }, position: [1100, 0], retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: 'continueErrorOutput' }
});

const has_transcripts = node({
  type: 'n8n-nodes-base.if',
  version: 2.2,
  config: { name: 'Has transcripts', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ id: 'has-transcripts', leftValue: expr('{{ ($json.transcripts ?? []).length }}'), rightValue: 0, operator: { type: 'number', operation: 'gt' } }], combinator: 'and' }, options: {} }, position: [1320, 0] }
});

const split_transcripts = node({
  type: 'n8n-nodes-base.splitOut',
  version: 1,
  config: { name: 'Split transcripts', parameters: { fieldToSplitOut: 'transcripts', options: {} }, position: [1540, 0] }
});

const finished_only = node({
  type: 'n8n-nodes-base.if',
  version: 2.2,
  config: { name: 'Finished only', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ id: 'finished-state', leftValue: expr('{{ $json.state }}'), rightValue: 'FILE_GENERATED', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, options: {} }, position: [1760, 0] }
});

const loop_transcripts = node({
  type: 'n8n-nodes-base.splitInBatches',
  version: 3,
  config: { name: 'Loop transcripts', parameters: { batchSize: 1, options: {} }, position: [1980, 0] }
});

const refused = node({
  type: 'n8n-nodes-base.if',
  version: 2.2,
  config: { name: 'Refused', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ id: 'refused', leftValue: expr('{{ $json.statusCode >= 400 && $json.statusCode < 500 ? 1 : 0 }}'), rightValue: 0, operator: { type: 'number', operation: 'gt' } }], combinator: 'and' }, options: {} }, position: [2200, 220] }
});

const ingest_refused = node({
  type: 'n8n-nodes-base.stopAndError',
  version: 1,
  config: { name: 'Ingest refused', parameters: { errorMessage: '2brain ingest refused a transcript with a 4xx answer; the Post meeting output shows which one' }, position: [2420, 220] }
});

const participants = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: { name: 'Participants', parameters: { method: 'GET', url: expr('{{ \'https://meet.googleapis.com/v2/\' + $(\'Split records\').item.json.name + \'/participants\' }}'), authentication: 'predefinedCredentialType', nodeCredentialType: 'googleOAuth2Api', sendQuery: true, queryParameters: { parameters: [{ name: 'pageSize', value: '250' }] }, options: { pagination: { pagination: { paginationMode: 'updateAParameterInEachRequest', parameters: { parameters: [{ type: 'qs', name: 'pageToken', value: expr('{{ $response.body.nextPageToken }}') }] }, paginationCompleteWhen: 'other', completeExpression: expr('{{ !$response.body.nextPageToken }}') } } } }, credentials: { googleOAuth2Api: newCredential('Google Meet') }, position: [2200, 0], retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: 'continueErrorOutput' }
});

const transcript_entries = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: { name: 'Transcript entries', parameters: { method: 'GET', url: expr('{{ \'https://meet.googleapis.com/v2/\' + $(\'Loop transcripts\').item.json.name + \'/entries\' }}'), authentication: 'predefinedCredentialType', nodeCredentialType: 'googleOAuth2Api', sendQuery: true, queryParameters: { parameters: [{ name: 'pageSize', value: '100' }] }, options: { pagination: { pagination: { paginationMode: 'updateAParameterInEachRequest', parameters: { parameters: [{ type: 'qs', name: 'pageToken', value: expr('{{ $response.body.nextPageToken }}') }] }, paginationCompleteWhen: 'other', completeExpression: expr('{{ !$response.body.nextPageToken }}') } } } }, credentials: { googleOAuth2Api: newCredential('Google Meet') }, position: [2420, 0], executeOnce: true, retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: 'continueErrorOutput' }
});

const post_try = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: { name: 'Post try', parameters: { assignments: { assignments: [{ id: 'post-try', name: 'post_try', value: expr('{{ $json.post_try ?? 1 }}'), type: 'number' }] }, options: {} }, position: [2530, -220] }
});

const calendar_events = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: { name: 'Calendar events', parameters: { method: 'GET', url: expr('{{ \'https://www.googleapis.com/calendar/v3/calendars/\' + encodeURIComponent($(\'Settings\').first().json.calendar_id) + \'/events\' }}'), authentication: 'predefinedCredentialType', nodeCredentialType: 'googleCalendarOAuth2Api', sendQuery: true, queryParameters: { parameters: [{ name: 'singleEvents', value: 'true' }, { name: 'maxResults', value: '50' }, { name: 'timeMin', value: expr('{{ new Date(Date.parse($(\'Split records\').item.json.startTime.replace(/\\.(\\d+)/, (m, f) => \'.\' + f.slice(0, 3).padEnd(3, \'0\'))) - 30 * 60000).toISOString() }}') }, { name: 'timeMax', value: expr('{{ new Date(Date.parse($(\'Split records\').item.json.endTime.replace(/\\.(\\d+)/, (m, f) => \'.\' + f.slice(0, 3).padEnd(3, \'0\'))) + 30 * 60000).toISOString() }}') }] }, options: {} }, credentials: { googleCalendarOAuth2Api: newCredential('Google Calendar') }, position: [2640, 0], executeOnce: true, retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: 'continueErrorOutput' }
});

const post_meeting = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: { name: 'Post meeting', parameters: { method: 'POST', url: 'http://brain:3000/meetings', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', sendBody: true, specifyBody: 'json', jsonBody: expr('{{ JSON.stringify({ source: "gemini", conference: $(\'Split records\').item.json, transcript: $(\'Loop transcripts\').item.json, participants: $(\'Participants\').all().flatMap(p => p.json.participants ?? []), entries: $(\'Transcript entries\').all().flatMap(p => p.json.transcriptEntries ?? []), calendar_events: ($json.items ?? []).slice(0, 50).map(e => ({ ...e, title: e.summary, calendar_id: $(\'Settings\').first().json.calendar_id })) }) }}'), options: { response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } } }, credentials: { httpHeaderAuth: newCredential('2brain ingest') }, position: [2860, 0] }
});

const retry_post = node({
  type: 'n8n-nodes-base.if',
  version: 2.2,
  config: { name: 'Retry post', parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' }, conditions: [{ id: 'retry-post', leftValue: expr('{{ [502, 503].includes($json.statusCode) && $(\'Post try\').item.json.post_try < 4 ? 1 : 0 }}'), rightValue: 0, operator: { type: 'number', operation: 'gt' } }], combinator: 'and' }, options: {} }, position: [3080, 0] }
});

const next_post_try = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: { name: 'Next post try', parameters: { assignments: { assignments: [{ id: 'next-post-try', name: 'post_try', value: expr('{{ $(\'Post try\').item.json.post_try + 1 }}'), type: 'number' }] }, options: {} }, position: [3080, -220] }
});

const post_wait = node({
  type: 'n8n-nodes-base.wait',
  version: 1.1,
  config: { name: 'Post wait', parameters: { resume: 'timeInterval', amount: 60, unit: 'seconds' }, position: [2860, -220] }
});

const wf = workflow('', '2brain meetings: Gemini', { executionOrder: 'v1' });

export default wf
  .add(poll_schedule)
  .to(settings)
  .to(list_conference_records
  .onError(meet_or_calendar_failed))
  .to(has_records.onTrue(split_records
    .to(list_transcripts
    .onError(meet_or_calendar_failed))
    .to(has_transcripts.onTrue(split_transcripts
      .to(finished_only.onTrue(splitInBatches(loop_transcripts)
        .onEachBatch(participants
          .onError(meet_or_calendar_failed)
          .to(transcript_entries
          .onError(meet_or_calendar_failed))
          .to(post_try)
          .to(calendar_events
          .onError(meet_or_calendar_failed))
          .to(post_meeting)
          .to(retry_post.onTrue(next_post_try
            .to(post_wait)
            .to(post_try)).onFalse(loop_transcripts)))
        .onDone(refused.onTrue(ingest_refused))))))))