export interface EventEnvelope {
  event_id: string
  event_type: string
  occurred_at: string
  producer?: string
  schema_version?: number
  data: Record<string, unknown>
}

export interface NotificationEvent {
  eventId: string
  eventType: string
  occurredAt: Date
  data: Record<string, unknown>
}

export function decodeEvent(body: Buffer): NotificationEvent {
  let value: unknown
  try {
    value = JSON.parse(body.toString('utf8'))
  } catch (error) {
    throw new Error(`invalid event JSON: ${String(error)}`)
  }

  if (!isEnvelope(value)) {
    throw new Error('event envelope is invalid')
  }
  if (value.schema_version !== undefined && value.schema_version !== 1) {
    throw new Error(`unsupported schema_version: ${value.schema_version}`)
  }

  const occurredAt = new Date(value.occurred_at)
  if (Number.isNaN(occurredAt.getTime())) {
    throw new Error('occurred_at is invalid')
  }

  return {
    eventId: value.event_id,
    eventType: value.event_type,
    occurredAt,
    data: value.data,
  }
}

function isEnvelope(value: unknown): value is EventEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const envelope = value as Record<string, unknown>
  return (
    typeof envelope.event_id === 'string' &&
    envelope.event_id.length > 0 &&
    typeof envelope.event_type === 'string' &&
    envelope.event_type.length > 0 &&
    typeof envelope.occurred_at === 'string' &&
    typeof envelope.data === 'object' &&
    envelope.data !== null &&
    !Array.isArray(envelope.data)
  )
}
