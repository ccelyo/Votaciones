import type { NotificationEvent } from '../domain/event.js'
import type {
  NewNotification,
  NotificationRepository,
} from '../domain/notification.js'

export interface NotificationHandler {
  readonly eventType: string
  create(event: NotificationEvent): NewNotification
}

export class NotificationService {
  private readonly handlers: ReadonlyMap<string, NotificationHandler>

  constructor(
    private readonly repository: NotificationRepository,
    handlers: NotificationHandler[],
  ) {
    this.handlers = new Map(handlers.map((handler) => [handler.eventType, handler]))
  }

  async process(event: NotificationEvent): Promise<void> {
    const handler = this.handlers.get(event.eventType)
    if (!handler) {
      throw new Error(`no notification handler for ${event.eventType}`)
    }

    await this.repository.save(handler.create(event))
  }
}

function text(data: Record<string, unknown>, key: string, fallback: string): string {
  const value = data[key]
  return typeof value === 'string' && value.trim() !== '' ? value : fallback
}

function recipient(data: Record<string, unknown>): string {
  return text(data, 'recipient_id', 'broadcast')
}

export function createNotificationHandlers(): NotificationHandler[] {
  return [
    {
      eventType: 'election.created',
      create: (event) => ({
        eventId: event.eventId,
        eventType: event.eventType,
        recipientId: recipient(event.data),
        title: 'Nueva elección disponible',
        body: `Se creó la elección "${text(event.data, 'name', text(event.data, 'election_id', 'sin nombre'))}".`,
        createdAt: event.occurredAt,
      }),
    },
    {
      eventType: 'election.closed',
      create: (event) => ({
        eventId: event.eventId,
        eventType: event.eventType,
        recipientId: recipient(event.data),
        title: 'Elección cerrada',
        body: `La elección "${text(event.data, 'election_id', 'desconocida')}" fue cerrada.`,
        createdAt: event.occurredAt,
      }),
    },
    {
      eventType: 'census.updated',
      create: (event) => ({
        eventId: event.eventId,
        eventType: event.eventType,
        recipientId: recipient(event.data),
        title: 'Censo actualizado',
        body: `El censo de la elección "${text(event.data, 'election_id', 'desconocida')}" fue actualizado.`,
        createdAt: event.occurredAt,
      }),
    },
    {
      eventType: 'votes.cast',
      create: (event) => ({
        eventId: event.eventId,
        eventType: event.eventType,
        recipientId: recipient(event.data),
        title: 'Voto registrado',
        body: `Tu voto en la elección "${text(event.data, 'election_id', 'desconocida')}" fue registrado.`,
        createdAt: event.occurredAt,
      }),
    },
    {
      eventType: 'tally.completed',
      create: (event) => ({
        eventId: event.eventId,
        eventType: event.eventType,
        recipientId: recipient(event.data),
        title: 'Resultados disponibles',
        body: `El escrutinio de la elección "${text(event.data, 'election_id', 'desconocida')}" terminó.`,
        createdAt: event.occurredAt,
      }),
    },
  ]
}
