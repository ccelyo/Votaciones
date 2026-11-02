import assert from 'node:assert/strict'
import test from 'node:test'
import { createNotificationHandlers, NotificationService } from '../src/application/notification-service.js'
import type { NewNotification, NotificationRepository } from '../src/domain/notification.js'

class InMemoryRepository implements NotificationRepository {
  readonly notifications: NewNotification[] = []

  async save(notification: NewNotification): Promise<boolean> {
    if (this.notifications.some((item) => item.eventId === notification.eventId)) return false
    this.notifications.push(notification)
    return true
  }

  async findByRecipient(): Promise<NewNotification[]> {
    return this.notifications
  }
}

test('creates a safe notification for a completed tally', async () => {
  const repository = new InMemoryRepository()
  const service = new NotificationService(repository, createNotificationHandlers())

  await service.process({
    eventId: 'event-1',
    eventType: 'tally.completed',
    occurredAt: new Date('2026-10-20T21:02:01Z'),
    data: { election_id: 'election-1', total_ballots: 10 },
  })

  assert.equal(repository.notifications.length, 1)
  assert.equal(repository.notifications[0]?.recipientId, 'broadcast')
  assert.match(repository.notifications[0]?.body ?? '', /election-1/)
  assert.doesNotMatch(repository.notifications[0]?.body ?? '', /total_ballots/)
})

test('does not create a second record for a repeated event', async () => {
  const repository = new InMemoryRepository()
  const service = new NotificationService(repository, createNotificationHandlers())
  const event = {
    eventId: 'event-1',
    eventType: 'election.closed',
    occurredAt: new Date(),
    data: { election_id: 'election-1' },
  }

  await service.process(event)
  await service.process(event)

  assert.equal(repository.notifications.length, 1)
})
