import { sqliteTable, text, integer, uniqueIndex, index, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const appMeta = sqliteTable('app_meta', { key: text('key').primaryKey(), value: text('value').notNull() });
export const users = sqliteTable('users', {
  id: text('id').primaryKey(), name: text('name').notNull(), balance: integer('balance').notNull().default(0),
  role: text('role').notNull().default('user'), status: text('status').notNull().default('active'),
  isDemo: integer('is_demo').notNull().default(0), createdAt: integer('created_at').notNull(),
}, t => [check('users_balance_nonnegative', sql`${t.balance} >= 0`)]);
export const prizeImages = sqliteTable('prize_images', {
  id: text('id').primaryKey(), storageKey: text('storage_key').notNull().unique(), contentType: text('content_type').notNull(),
  size: integer('size').notNull(), createdBy: text('created_by').notNull().references(() => users.id), createdAt: integer('created_at').notNull(),
}, t => [index('prize_images_creator').on(t.createdBy,t.createdAt)]);
export const events = sqliteTable('events', {
  id: text('id').primaryKey(), title: text('title').notNull(), subtitle: text('subtitle').notNull(),
  prizeType: text('prize_type').notNull().default(''), prizeName: text('prize_name').notNull().default(''), imageId: text('image_id').references(() => prizeImages.id),
  region: text('region').notNull(), city: text('city').notNull(), category: text('category').notNull(), imageKey: text('image_key').notNull(),
  totalTickets: integer('total_tickets').notNull(), soldTickets: integer('sold_tickets').notNull().default(0), ticketPrice: integer('ticket_price').notNull(),
  status: text('status').notNull().default('active'), startsAt: integer('starts_at').notNull(), createdAt: integer('created_at').notNull(),
  winnerTicket: integer('winner_ticket'), winnerUserId: text('winner_user_id').references(() => users.id), drawnAt: integer('drawn_at'),
  isDemo: integer('is_demo').notNull().default(1),
}, t => [check('events_capacity', sql`${t.soldTickets} >= 0 AND ${t.soldTickets} <= ${t.totalTickets} AND ${t.totalTickets} BETWEEN 1 AND 10000`), check('events_price', sql`${t.ticketPrice} BETWEEN 1 AND 100000`)]);
export const purchases = sqliteTable('purchases', {
  id: text('id').primaryKey(), requestId: text('request_id').notNull(), userId: text('user_id').notNull().references(() => users.id),
  eventId: text('event_id').notNull().references(() => events.id), quantity: integer('quantity').notNull(), drawNumber: integer('draw_number').notNull(), createdAt: integer('created_at').notNull(),
}, t => [uniqueIndex('purchases_idempotency').on(t.userId,t.requestId), check('purchases_quantity',sql`${t.quantity} BETWEEN 1 AND 20`)]);
export const tickets = sqliteTable('tickets', {
  id: text('id').primaryKey(), eventId: text('event_id').notNull().references(() => events.id),
  userId: text('user_id').notNull().references(() => users.id), number: integer('number').notNull(), purchaseId: text('purchase_id').references(() => purchases.id),
  createdAt: integer('created_at').notNull(),
}, t => [uniqueIndex('ticket_event_number').on(t.eventId,t.number), index('tickets_user_event').on(t.userId,t.eventId)]);
export const coinRequests = sqliteTable('coin_requests', {
  id: text('id').primaryKey(), userId: text('user_id').notNull().references(() => users.id), amount: integer('amount').notNull(),
  message: text('message').notNull(), status: text('status').notNull().default('pending'),
  reviewedBy: text('reviewed_by').references(() => users.id), createdAt: integer('created_at').notNull(), reviewedAt: integer('reviewed_at'),
}, t => [check('request_amount', sql`${t.amount} BETWEEN 1 AND 100000`), index('requests_user_status').on(t.userId,t.status)]);
export const ledger = sqliteTable('ledger', {
  id: text('id').primaryKey(), userId: text('user_id').notNull().references(() => users.id), label: text('label').notNull(), amount: integer('amount').notNull(),
  referenceId: text('reference_id').notNull().unique(), createdAt: integer('created_at').notNull(),
});
export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(), userId: text('user_id').notNull().references(() => users.id), title: text('title').notNull(), message: text('message').notNull(),
  read: integer('read').notNull().default(0), createdAt: integer('created_at').notNull(),
}, t => [index('notifications_user').on(t.userId)]);
export const contactMessages = sqliteTable('contact_messages', {
  id: text('id').primaryKey(), userId: text('user_id').notNull().references(() => users.id), eventId: text('event_id').references(() => events.id),
  message: text('message').notNull(), createdAt: integer('created_at').notNull(),
});

export const supportThreads = sqliteTable('support_threads', {
  id: text('id').primaryKey(), userId: text('user_id').notNull().references(() => users.id),
  subject: text('subject').notNull(), eventId: text('event_id').references(() => events.id),
  status: text('status').notNull().default('open'), priority: text('priority').notNull().default('normal'),
  userReadAt: integer('user_read_at').notNull().default(0), staffReadAt: integer('staff_read_at').notNull().default(0),
  createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(),
}, t => [index('support_threads_user_updated').on(t.userId,t.updatedAt)]);
export const supportMessages = sqliteTable('support_messages', {
  id: text('id').primaryKey(), threadId: text('thread_id').notNull().references(() => supportThreads.id),
  senderId: text('sender_id').notNull().references(() => users.id), isAdmin: integer('is_admin').notNull().default(0),
  internal: integer('internal').notNull().default(0), body: text('body').notNull(), createdAt: integer('created_at').notNull(),
}, t => [index('support_messages_thread_time').on(t.threadId,t.createdAt)]);
export const adminAudit = sqliteTable('admin_audit', {
  id: text('id').primaryKey(), actorId: text('actor_id').notNull().references(() => users.id),
  action: text('action').notNull(), targetId: text('target_id').notNull(), details: text('details').notNull(), createdAt: integer('created_at').notNull(),
}, t => [index('admin_audit_time').on(t.createdAt)]);
export const balanceAdjustments = sqliteTable('balance_adjustments', {
  id: text('id').primaryKey(), requestId: text('request_id').notNull().unique(), actorId: text('actor_id').notNull().references(() => users.id),
  userId: text('user_id').notNull().references(() => users.id), amount: integer('amount').notNull(), reason: text('reason').notNull(), createdAt: integer('created_at').notNull(),
});

export const eventCategories = sqliteTable('event_categories', {
  normalizedName: text('normalized_name').primaryKey(), name: text('name').notNull(),
  createdBy: text('created_by').notNull().references(() => users.id), createdAt: integer('created_at').notNull(),
});
export const telegramLinks = sqliteTable('telegram_links', {
  id: text('id').primaryKey(), userId: text('user_id').notNull().references(() => users.id),
  telegramId: text('telegram_id').notNull(), username: text('username'),
  linkedAt: integer('linked_at').notNull(), expiresAt: integer('expires_at').notNull(),
}, t => [uniqueIndex('telegram_links_user').on(t.userId), uniqueIndex('telegram_links_telegram').on(t.telegramId)]);
export const telegramLinkRequests = sqliteTable('telegram_link_requests', {
  id: text('id').primaryKey(), codeHash: text('code_hash').notNull(), userId: text('user_id').notNull().references(() => users.id),
  telegramId: text('telegram_id'), username: text('username'), createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(), claimedAt: integer('claimed_at'),
}, t => [uniqueIndex('telegram_link_requests_code').on(t.codeHash), uniqueIndex('telegram_link_requests_user').on(t.userId)]);
export const telegramBuyIntents = sqliteTable('telegram_buy_intents', {
  id: text('id').primaryKey(), userId: text('user_id').notNull().references(() => users.id), telegramId: text('telegram_id').notNull(),
  linkId: text('link_id').notNull(), eventId: text('event_id').notNull().references(() => events.id), quantity: integer('quantity').notNull(),
  unitPrice: integer('unit_price').notNull(), totalCost: integer('total_cost').notNull(),
  createdAt: integer('created_at').notNull(), expiresAt: integer('expires_at').notNull(),
}, t => [index('telegram_buy_intents_link').on(t.linkId,t.createdAt), check('telegram_intent_quantity',sql`${t.quantity} BETWEEN 1 AND 20`)]);
