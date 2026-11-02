import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createHttpApp } from '../src/infrastructure/http.js'
import type { Notification, NotificationRepository } from '../src/domain/notification.js'

const notification: Notification = {
  id: 'notification-1',
  eventId: 'vote-event-1',
  eventType: 'votes.cast',
  recipientId: 'user-1',
  title: 'Voto registrado',
  body: 'Tu voto fue registrado.',
  createdAt: new Date('2026-11-01T20:00:00Z'),
}

const repository: NotificationRepository = {
  async save() {
    return true
  },
  async findByRecipient(recipientId, limit) {
    return recipientId === notification.recipientId ? [notification].slice(0, limit) : []
  },
}

test('GET /v1/notifications returns the recipient history', async (t) => {
  const server = createServer(createHttpApp(repository))
  await new Promise<void>((resolve) => server.listen(0, resolve))
  t.after(() => server.close())

  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/notifications?recipientId=user-1`)

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), [{
    ...notification,
    createdAt: notification.createdAt.toISOString(),
  }])
})

test('GET /v1/notifications requires recipientId', async (t) => {
  const server = createServer(createHttpApp(repository))
  await new Promise<void>((resolve) => server.listen(0, resolve))
  t.after(() => server.close())

  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/notifications`)

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'recipientId is required' })
})
