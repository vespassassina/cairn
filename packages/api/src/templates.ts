import type { Page, WriteContext } from "@cairn/core";
import type { AppContext } from "./context.js";

/**
 * Templates and daily notes (ADR-075): both are ordinary pages, living under
 * a root "collection" page (ADR-024/ADR-026: a collection is just a page
 * with no parent) found by title. Same technique as the well-known tables
 * (`ATTACHMENTS_TABLE_NAME` and its siblings in `attachments.ts`), carried
 * over from tables to pages: a fixed name, found by listing and matching,
 * created the first time it is needed. No new field, store method or index.
 */

export const TEMPLATES_COLLECTION_NAME = "Templates";
export const DAILY_NOTES_COLLECTION_NAME = "Daily notes";
export const DAILY_NOTE_TEMPLATE_NAME = "Daily note";
/** Where drops land (ADR-079 decision 1): a root collection that should be empty. */
export const INBOX_COLLECTION_NAME = "Inbox";

/**
 * Today's date, UTC, day-only: `YYYY-MM-DD`. Deliberately not the full ISO
 * timestamp `toISOString()` gives elsewhere in this codebase (`verifiedAt`,
 * `edited_at`): a daily note needs day granularity so a second lookup the
 * same day finds the same page instead of never matching (ADR-075 decision
 * 2). No existing date-only helper was found elsewhere to reuse.
 */
export function todayDateOnly(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * `{{date}}` and `{{title}}`, substituted by plain `replaceAll`: no loops,
 * conditionals or nested syntax (ADR-075 decision 2). Anything else in a
 * template body (`{{foo}}`) is left untouched.
 */
export function substitutePlaceholders(body: string, { date, title }: { date: string; title: string }): string {
  return body.replaceAll("{{date}}", date).replaceAll("{{title}}", title);
}

/** Every root page (`parentId: null`), walked the same bounded-cursor way `collectChildren` in `operations.ts` does. */
async function rootPages(context: AppContext): Promise<Page[]> {
  const all: Page[] = [];
  let cursor: string | null = null;
  for (;;) {
    const batch = await context.store.listPages(context.workspaceId, { parentId: null, limit: 500, cursor });
    all.push(...batch.items);
    if (!batch.cursor) return all;
    cursor = batch.cursor;
  }
}

/** Every immediate child of a page, same bounded walk as above, one level down. */
async function childPages(context: AppContext, parentId: string): Promise<Page[]> {
  const all: Page[] = [];
  let cursor: string | null = null;
  for (;;) {
    const batch = await context.store.listPages(context.workspaceId, { parentId, limit: 500, cursor });
    all.push(...batch.items);
    if (!batch.cursor) return all;
    cursor = batch.cursor;
  }
}

/** A root collection by name, or null when nothing with that title exists yet. Never creates one. */
async function findCollection(context: AppContext, name: string): Promise<Page | null> {
  const pages = await rootPages(context);
  return pages.find((page) => page.title === name) ?? null;
}

/**
 * A root collection by name, created empty the first time it is needed. The
 * well-known-table pattern (`findOrCreateTable` in `attachments.ts`) applied
 * to a page: a person naming a root page exactly `Templates`, `Daily
 * notes` or `Inbox` collides with this, the same accepted risk the existing well-known
 * tables already carry (ADR-075 decision 1).
 */
export async function findOrCreateCollection(context: AppContext, name: string, by: WriteContext): Promise<Page> {
  const found = await findCollection(context, name);
  if (found) return found;
  return context.pages.create(context.workspaceId, { title: name, body: "", parentId: null, tags: [], sources: [] }, by);
}

/** A child of `parentId` with this exact title, or null. */
async function findChildByTitle(context: AppContext, parentId: string, title: string): Promise<Page | null> {
  const children = await childPages(context, parentId);
  return children.find((page) => page.title === title) ?? null;
}

export interface DailyNoteResult {
  page: Page;
  /** False when today's note already existed and was returned unchanged. */
  created: boolean;
}

/**
 * Finds or creates today's daily note (ADR-075 decision 4). The Daily notes
 * collection is created eagerly, since a note is about to be filed under it
 * either way; the Templates collection is only looked up, never created by
 * this path, so asking for today's note with no template defined yet does
 * not leave behind an empty "Templates" page nobody asked for.
 */
export async function getOrCreateDailyNote(context: AppContext, by: WriteContext): Promise<DailyNoteResult> {
  const ws = context.workspaceId;
  const dailyNotes = await findOrCreateCollection(context, DAILY_NOTES_COLLECTION_NAME, by);
  const date = todayDateOnly();

  const existing = await findChildByTitle(context, dailyNotes.id, date);
  if (existing) return { page: existing, created: false };

  const templates = await findCollection(context, TEMPLATES_COLLECTION_NAME);
  const template = templates ? await findChildByTitle(context, templates.id, DAILY_NOTE_TEMPLATE_NAME) : null;
  const body = template ? substitutePlaceholders(template.body, { date, title: date }) : "";

  const page = await context.pages.create(ws, { title: date, body, parentId: dailyNotes.id, tags: [], sources: [] }, by);
  return { page, created: true };
}
