// The monitor expression AST the app stores (mirror of the frontend's lib/invariants/ast), as
// the CLI reads it back on a monitor. Rules are written as formulas (--when "value < 25000") and
// built server-side; validation and rendering stay there too.

export type CmpOp = 'gte' | 'lte' | 'gt' | 'lt' | 'eq' | 'neq';

export interface RefTerm {
  type: 'ref';
  alias: string;
  // Exact multiplier on the metric — how a warning tier says "reserves >= liabilities × 1.05".
  scale?: { num: string; den: string };
}
export interface LitTerm {
  type: 'lit';
  num: string; // decimal bigint string (may be negative)
  den: string; // decimal bigint string, > 0
}
// The value's reading before its live one: value < previous * 0.99.
export interface PrevTerm {
  type: 'prev';
  alias: string;
  scale?: { num: string; den: string };
}
// The value as it read `sec` seconds before the check: value < ago(24h) * 0.8.
export interface AgoTerm {
  type: 'ago';
  alias: string;
  sec: number;
  scale?: { num: string; den: string };
}
export type Term = RefTerm | LitTerm | PrevTerm | AgoTerm;

export interface InvariantExpr {
  type: 'cmp';
  op: CmpOp;
  lhs: Term;
  rhs: Term;
}

// "30m" / "2h" / "1d" / an ISO date → the instant it names. For snoozes.
export function parseUntil(raw: string, now: Date = new Date()): Date {
  const m = /^(\d+)\s*(m|min|h|hr|d)$/i.exec(raw.trim());
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const ms = unit.startsWith('m') ? 60_000 : unit.startsWith('h') ? 3_600_000 : 86_400_000;
    return new Date(now.getTime() + n * ms);
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error(`Give a duration (30m, 2h, 1d) or an ISO date (got: ${raw})`);
  return d;
}
