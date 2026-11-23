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
  tlsRequired: process.env.NOTIFICATION_TLS_REQUIRED === 'true',
  tlsCertFile: process.env.NOTIFICATION_TLS_CERT_FILE,
  tlsKeyFile: process.env.NOTIFICATION_TLS_KEY_FILE,
  tlsClientCaFile: process.env.NOTIFICATION_TLS_CLIENT_CA_FILE,
}

if (
  config.tlsRequired &&
  (!config.tlsCertFile || !config.tlsKeyFile || !config.tlsClientCaFile)
) {
  throw new Error(
    'NOTIFICATION_TLS_REQUIRED needs TLS_CERT_FILE, TLS_KEY_FILE and TLS_CLIENT_CA_FILE',
  )
}
