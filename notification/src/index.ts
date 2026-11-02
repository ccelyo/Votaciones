import { createNotificationHandlers, NotificationService } from './application/notification-service.js'
import { decodeEvent } from './domain/event.js'
import { config } from './infrastructure/config.js'
import { createHttpApp } from './infrastructure/http.js'
import {
  connectMongo,
  MongoNotificationRepository,
} from './infrastructure/mongo-notification-repository.js'
import { RabbitConsumer } from './infrastructure/rabbit-consumer.js'

await connectMongo(config.mongoUrl, config.mongoDatabase)

const repository = new MongoNotificationRepository()
const service = new NotificationService(repository, createNotificationHandlers())
const app = createHttpApp(repository)
app.listen(config.port, () => {
  console.log(`Notification service listening on port ${config.port}`)
})

const consumers = [
  createConsumer('election', [{ exchange: 'election.events', routingKeys: ['election.created', 'election.closed'] }]),
  createConsumer('identity', [{ exchange: 'identity.events', routingKeys: ['census.updated'] }]),
  createConsumer('votes', [{ exchange: 'votes.events', routingKeys: ['votes.cast'] }]),
  createConsumer('tally', [
    { exchange: 'votes.events', routingKeys: ['tally.completed'] },
    { exchange: 'tally.events', routingKeys: ['tally.completed'] },
  ]),
]

await Promise.all(consumers.map((consumer) => consumer.run()))

function createConsumer(
  name: string,
  exchangeBindings: { exchange: string; routingKeys: string[] }[],
): RabbitConsumer<ReturnType<typeof decodeEvent>> {
  return new RabbitConsumer(config.rabbitUrl, {
    queue: `notifications.${name}`,
    deadLetterExchange: `notifications.${name}.dlx`,
    bindings: exchangeBindings.flatMap(({ exchange, routingKeys }) =>
      routingKeys.map((routingKey) => ({ exchange, routingKey })),
    ),
    prefetch: config.prefetch,
    decode: (message) => decodeEvent(message.content),
    handle: (event) => service.process(event),
  })
}
