// `--save [form] [--title "…"]` on the question commands: the server keeps the answer at a page in
// the app, drawn as a chart or a table, and the answer carries `saved.url`. One parser and one
// printer, so `query`, `events` and `history` say it alike.
import { flag, type ParsedFlags } from './_args';

export const SAVE_FORMS = ['bars', 'stacked', 'diverging', 'line', 'table'] as const;
export type SaveForm = (typeof SAVE_FORMS)[number];

export const SAVE_HELP = `  --save [bars|stacked|diverging|line|table]   Keep the answer at a page in the app, as a chart or a table, and print its link
  --keep                                       Keep it as a TABLE under Tables, re-run every time it is opened (not a snapshot)
  --title "<title>"                            The page's title (made from the question when left out)
  --draw <column>                              The column a chart draws when the rows carry several (a read's name beside TVL)`;

/** The `save` argument the tools take, or undefined when --save was not given. */
export function saveFromFlags(flags: ParsedFlags): { as?: SaveForm; title?: string; value?: string; keep?: boolean } | undefined {
  const keep = flag(flags, 'keep') !== undefined;
  const raw = flag(flags, 'save') ?? (keep ? 'table' : undefined);
  const title = flag(flags, 'title');
  const draw = flag(flags, 'draw');
  if (raw === undefined) {
    if (title !== undefined) throw new Error('--title goes with --save.');
    if (draw !== undefined) throw new Error('--draw goes with --save.');
    return undefined;
  }
  const save: { as?: SaveForm; title?: string; value?: string; keep?: boolean } = {};
  if (keep) save.keep = true;
  if (draw !== undefined) {
    if (draw === 'true' || !draw.trim()) throw new Error('--draw needs a column name');
    save.value = draw.trim();
  }
  if (raw !== 'true') {
    if (!(SAVE_FORMS as readonly string[]).includes(raw)) throw new Error(`--save takes one of ${SAVE_FORMS.join(', ')}, or nothing to let the rows pick (got: ${raw})`);
    save.as = raw as SaveForm;
  }
  if (title !== undefined) {
    if (title === 'true' || !title.trim()) throw new Error('--title needs a value');
    save.title = title.trim();
  }
  return save;
}

/** The line under an answer that was saved. */
export function savedLine(result: Record<string, unknown> | null | undefined): string | null {
  const saved = result?.saved as { url?: string; as?: string; title?: string; kept?: boolean } | undefined;
  if (!saved?.url) return null;
  if (saved.kept) return `Kept as a table under Tables${saved.title ? ` · ${saved.title}` : ''}: ${saved.url}`;
  return `Saved as ${saved.as === 'table' ? 'a table' : `a chart (${saved.as})`}${saved.title ? ` · ${saved.title}` : ''}: ${saved.url}`;
}
