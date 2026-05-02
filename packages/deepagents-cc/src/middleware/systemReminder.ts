/**
 * Compatibility shim — `systemReminder` was the original name; the cc-
 * aligned renamed module is `contextEngineering`. This file re-exports
 * the new symbols under the legacy names so older imports keep working.
 */

export {
  createContextEngineeringMiddleware as createSystemReminderMiddleware,
  ccReminders as stockReminders,
  type Reminder,
  type ReminderContext,
  type ContextEngineeringMiddlewareOptions as SystemReminderMiddlewareOptions,
} from './contextEngineering.js'
