import amqp, { type Channel, type ConsumeMessage } from 'amqplib'

export interface ConsumerBinding {
  exchange: string
  routingKey: string
}

export interface GenericConsumerOptions<T> {
  queue: string
  deadLetterExchange: string
  bindings: ConsumerBinding[]
  prefetch: number
  decode(message: ConsumeMessage): T
  handle(value: T): Promise<void>
}

export class RabbitConsumer<T> {
  constructor(
    private readonly url: string,
    private readonly options: GenericConsumerOptions<T>,
  ) {}

  async run(): Promise<never> {
    let delay = 1000
    for (;;) {
      try {
        await this.consumeOnce()
        delay = 1000
      } catch (error) {
        console.error(`RabbitMQ consumer stopped: ${String(error)}`)
        await new Promise((resolve) => setTimeout(resolve, delay))
        delay = Math.min(delay * 2, 30000)
      }
    }
  }

  private async consumeOnce(): Promise<void> {
    const connection = await amqp.connect(this.url)
    try {
      const channel = await connection.createChannel()
      await declareTopology(channel, this.options)
      await channel.prefetch(this.options.prefetch)
      await channel.consume(this.options.queue, (message) => {
        if (message) void this.process(channel, message)
      })
      await new Promise<void>((_, reject) => {
        connection.on('error', reject)
        connection.on('close', () => reject(new Error('RabbitMQ connection closed')))
      })
    } finally {
      await connection.close().catch(() => undefined)
    }
  }

  private async process(channel: Channel, message: ConsumeMessage): Promise<void> {
    try {
      const value = this.options.decode(message)
      await this.options.handle(value)
      channel.ack(message)
    } catch (error) {
      console.error(`event processing failed: ${String(error)}`)
      channel.nack(message, false, false)
    }
  }
}

async function declareTopology(
  channel: Channel,
  options: GenericConsumerOptions<unknown>,
): Promise<void> {
  await channel.assertExchange(options.deadLetterExchange, 'fanout', { durable: true })
  await channel.assertQueue(`${options.queue}.dlq`, { durable: true })
  await channel.bindQueue(`${options.queue}.dlq`, options.deadLetterExchange, '')
  await channel.assertQueue(options.queue, {
    durable: true,
    arguments: { 'x-dead-letter-exchange': options.deadLetterExchange },
  })

  for (const binding of options.bindings) {
    await channel.assertExchange(binding.exchange, 'topic', { durable: true })
    await channel.bindQueue(options.queue, binding.exchange, binding.routingKey)
  }
}
