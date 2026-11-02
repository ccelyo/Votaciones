export interface Notification {
  id?: string
  eventId: string
  eventType: string
  recipientId: string
  title: string
  body: string
  createdAt: Date
}

export type NewNotification = Omit<Notification, 'id'>

export interface NotificationRepository {
  save(notification: NewNotification): Promise<boolean>
  findByRecipient(recipientId: string, limit: number): Promise<Notification[]>
}
