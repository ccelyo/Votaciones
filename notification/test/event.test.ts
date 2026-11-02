import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeEvent } from '../src/domain/event.js'

test('decodes the shared event envelope', () => {
  const event = decodeEvent(Buffer.from(JSON.stringify({
    event_id: 'event-1',
    event_type: 'election.created',
    occurred_at: '2026-10-20T21:02:01Z',
    schema_version: 1,
    data: { election_id: 'election-1' },
  })))

  assert.equal(event.eventId, 'event-1')
  assert.equal(event.eventType, 'election.created')
  assert.equal(event.data.election_id, 'election-1')
})

test('rejects unsupported schema versions', () => {
  assert.throws(
    () => decodeEvent(Buffer.from(JSON.stringify({
      event_id: 'event-1',
      event_type: 'election.created',
      occurred_at: '2026-10-20T21:02:01Z',
      schema_version: 2,
      data: {},
    }))),
    /unsupported schema_version/,
  )
})
