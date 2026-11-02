import express from 'express'
import type { NotificationRepository } from '../domain/notification.js'

export function createHttpApp(repository: NotificationRepository): express.Express {
  const app = express()
  app.use(express.json())
  app.get('/health', (_request, response) => response.json({ status: 'ok' }))
  app.get('/healthz', (_request, response) => response.json({ status: 'ok' }))
  app.get('/v1/notifications', async (request, response, next) => {
    try {
      const recipientId = request.query.recipientId
      if (typeof recipientId !== 'string' || recipientId.trim() === '') {
        response.status(400).json({ error: 'recipientId is required' })
        return
      }
      const requestedLimit = Number(request.query.limit ?? 50)
      const limit = Number.isInteger(requestedLimit)
        ? Math.min(Math.max(requestedLimit, 1), 100)
        : 50
      response.json(await repository.findByRecipient(recipientId, limit))
    } catch (error) {
      next(error)
    }
  })
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    console.error(error)
    response.status(500).json({ error: 'internal server error' })
  })
  return app
}
