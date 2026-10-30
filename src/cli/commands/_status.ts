import { flagAll, type ParsedFlags } from './_args';

// `--status "Label: Option=rule; Option=rule; Option"`: a category column, its options in order with the rule that
// makes each, the last without one the rest. An item table's (table create --opens) and a live table's (a pill on
// each row, 2026-10-27) read the same way.

export const STATUS_HELP = '--status takes "Label: Option=rule; Option=rule; Option" (the last without a rule is Otherwise): --status "Stage: Closed=latest(WithdrawalBatchClosed); Open".';

/** `--status "Stage: Expired=latest(WithdrawalBatchExpired); Paying=seen(WithdrawalBatchPayment); Queued"` as the tool's status columns. */
export function statusesFrom(flags: ParsedFlags): { label: string; options: { name: string; when?: string }[] }[] {
  const out: { label: string; options: { name: string; when?: string }[] }[] = [];
  for (const raw of flagAll(flags, 'status')) {
    const colon = raw.indexOf(':');
    if (colon <= 0) throw new Error(STATUS_HELP);
    const label = raw.slice(0, colon).trim();
    const options = raw
      .slice(colon + 1)
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const eq = p.indexOf('=');
        return eq > 0 ? { name: p.slice(0, eq).trim(), when: p.slice(eq + 1).trim() } : { name: p };
      });
    if (!label || options.length === 0 || options.some((o) => !o.name)) throw new Error(STATUS_HELP);
    out.push({ label, options });
  }
  return out;
}
