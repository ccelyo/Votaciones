import 'dotenv/config'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`missing required environment variable: ${name}`)
  return value
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  mongoUrl: required('MONGO_URL'),
  rabbitUrl: required('RABBIT_URL'),
  mongoDatabase: process.env.MONGO_DATABASE ?? 'notifications',
  prefetch: Number(process.env.RABBIT_PREFETCH ?? 10),
}
