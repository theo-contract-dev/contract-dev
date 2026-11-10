// THE WORDS AN ALERT WEARS (2026-11-08), the same two lines the app's alert page puts first in its rail:
// its TYPE — an Activity alert sends a message each time something happens, a Condition alert sends
// when its condition is met and the all-clear when it clears — and its TRIGGER, the specific kind
// (Event, Metric threshold, Gone quiet…). One module, so `notify show`, a report's and a monitor's
// `show` print the same words as the page. "Metric", never "value": a condition reads any metric,
// state or activity, listed or made for the alert alone.

/** What sends an alert: something happening (once per block), or a condition being met. */
export type AlertTrigger = 'event' | 'condition';

export const ALERT_TYPE_WORD: Record<AlertTrigger, string> = { event: 'Activity alert', condition: 'Condition alert' };

/** The monitor kinds that fire on each match rather than hold a condition: alerts on something happening, as the app reads them. */
export const EVENT_MONITOR_KINDS = new Set(['eventFired', 'metricEvent']);

export const monitorTrigger = (m: { kind?: string | null }): AlertTrigger => (m.kind && EVENT_MONITOR_KINDS.has(m.kind) ? 'event' : 'condition');

/** An alert on something happening (an each-time report): what it listens for, by its trigger; a row or a member says which way it moved. */
export function eachTriggerWord(each: { kind: string; on?: string }): string {
  switch (each.kind) {
    case 'call':
      return 'Function call';
    case 'value':
      return 'Metric changed';
    case 'row':
      return each.on === 'finished' ? 'Row closed' : each.on === 'both' ? 'Row opened or closed' : 'Row opened';
    case 'member':
      return each.on === 'left' ? 'Left group' : each.on === 'both' ? 'Joined or left group' : 'Joined group';
    case 'monitor':
      return 'Alert';
    default:
      return 'Event';
  }
}

/** An alert on a monitor: what it checks for, by its kind. A threshold on any metric, state or activity, is one word. */
export function monitorTriggerWord(m: { kind?: string | null; params?: unknown }): string {
  if ((m.params as { tagTableMonitorId?: unknown } | null)?.tagTableMonitorId) return 'Row threshold';
  switch (m.kind) {
    case 'eventFired':
    case 'metricEvent':
      return 'Event';
    case 'silence':
      return 'Gone quiet';
    case 'unanswered':
      return 'Overdue';
    case 'failures':
      return 'Failing calls';
    default:
      return 'Metric threshold';
  }
}
