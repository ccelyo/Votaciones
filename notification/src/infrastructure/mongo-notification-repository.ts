import mongoose, { Schema } from 'mongoose'
import type {
  NewNotification,
  Notification,
  NotificationRepository,
} from '../domain/notification.js'

const schema = new Schema<Notification>(
  {
    eventId: { type: String, required: true, unique: true },
    eventType: { type: String, required: true },
    recipientId: { type: String, required: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    createdAt: { type: Date, required: true },
  },
  { versionKey: false },
)

const NotificationModel = mongoose.model<Notification>('Notification', schema)

export class MongoNotificationRepository implements NotificationRepository {
  async save(notification: NewNotification): Promise<boolean> {
    try {
      await NotificationModel.create(notification)
      return true
    } catch (error) {
      if (isDuplicateKeyError(error)) return false
      throw error
    }
  }

  async findByRecipient(recipientId: string, limit: number): Promise<Notification[]> {
    return NotificationModel.find({ recipientId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean<Notification[]>()
      .exec()
  }
}

function isDuplicateKeyError(error: unknown): error is { code: number } {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000
}

export async function connectMongo(url: string, database: string): Promise<void> {
  await mongoose.connect(url, { dbName: database })
}
