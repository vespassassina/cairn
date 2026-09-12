import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { closeContext, createContext, loadConfig, type AppContext } from "@cairn/api";
import type { CollectionInput, PageInput } from "@cairn/core";

/**
 * Seed a local Cairn from the peptide wiki's source data.
 *
 * The wiki is a static site generated from `data/peptides.json` and
 * `data/categories.json`, so this reads the JSON rather than scraping HTML.
 * It exercises every PoC feature at once:
 *
 * 1. A page per category, and a page per peptide beneath its first category.
 * 2. `related` becomes `[[page-id]]` links, so backlinks and neighbours have a
 *    real graph to walk.
 * 3. A Peptides collection with one row per peptide, for query_collection.
 *
 * Idempotent. Ids are derived from the wiki's slugs, and existing records are
 * updated with their current version, so re-running it after the wiki changes
 * updates in place.
 *
 * Usage: pnpm --filter @cairn/example-peptide-wiki seed <path-to-peptide-wiki>
 */

interface Peptide {
  name: string;
  full_name: string;
  aliases: string[];
  categories: string[];
  tagline: string;
  status: string;
  origin: string;
  mechanism: string;
  research_summary: string;
  reported_benefits: string[];
  dosing_protocols: Array<{ route: string; protocol: string }>;
  side_effects: string[];
  safety_notes: string;
  community_notes: string;
  related: string[];
}

interface Category {
  name: string;
  icon: string;
  summary: string;
  primer: string;
}

const peptidePageId = (slug: string): string => `pg_${slug}`;
const categoryPageId = (slug: string): string => `pg_cat_${slug}`;
const COLLECTION_ID = "col_peptides";

function bullets(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function peptideBody(peptide: Peptide, all: Record<string, Peptide>): string {
  const related = peptide.related
    .map((slug) => `- [[${peptidePageId(slug)}|${all[slug]?.name ?? slug}]]`)
    .join("\n");
  const dosing = peptide.dosing_protocols
    .map((dose) => `### ${dose.route}\n\n${dose.protocol}`)
    .join("\n\n");

  return [
    `_${peptide.tagline}_`,
    `**Full name:** ${peptide.full_name}`,
    peptide.aliases.length > 0 ? `**Also known as:** ${peptide.aliases.join(", ")}` : "",
    `## Status\n\n${peptide.status}`,
    `## Origin\n\n${peptide.origin}`,
    `## Mechanism\n\n${peptide.mechanism}`,
    `## Research summary\n\n${peptide.research_summary}`,
    `## Reported benefits\n\n${bullets(peptide.reported_benefits)}`,
    `## Dosing protocols\n\n${dosing}`,
    `## Side effects\n\n${bullets(peptide.side_effects)}`,
    `## Safety notes\n\n${peptide.safety_notes}`,
    `## Community notes\n\n${peptide.community_notes}`,
    `## Related\n\n${related}`,
  ]
    .filter((section) => section !== "")
    .join("\n\n");
}

function categoryBody(
  slug: string,
  category: Category,
  peptides: Record<string, Peptide>,
): string {
  const members = Object.entries(peptides)
    .filter(([, peptide]) => peptide.categories.includes(slug))
    .map(([peptideSlug, peptide]) => `- [[${peptidePageId(peptideSlug)}|${peptide.name}]]`)
    .join("\n");
  return [
    category.summary,
    `## Primer\n\n${category.primer}`,
    `## Peptides\n\n${members}`,
  ].join("\n\n");
}

/** Create, or update with the current version. The seed never conflicts with itself. */
async function upsertPage(
  context: AppContext,
  id: string,
  input: PageInput,
): Promise<"created" | "updated"> {
  const existing = await context.store.getPage(context.workspaceId, id);
  if (existing) {
    await context.pages.update(context.workspaceId, id, input, existing.version);
    return "updated";
  }
  await context.pages.create(context.workspaceId, input, id);
  return "created";
}

async function main(): Promise<void> {
  const wiki = process.argv[2];
  if (!wiki) {
    process.stderr.write("usage: pnpm seed <path-to-peptide-wiki>\n");
    process.exit(2);
  }

  const peptides = JSON.parse(
    await readFile(join(wiki, "data", "peptides.json"), "utf8"),
  ) as Record<string, Peptide>;
  const categories = JSON.parse(
    await readFile(join(wiki, "data", "categories.json"), "utf8"),
  ) as Record<string, Category>;

  const config = loadConfig();
  const context = await createContext(config);
  const ws = context.workspaceId;
  const counts = { created: 0, updated: 0 };

  try {
    // Categories first, so peptide pages have a parent to point at.
    for (const [slug, category] of Object.entries(categories)) {
      counts[
        await upsertPage(context, categoryPageId(slug), {
          title: category.name,
          body: categoryBody(slug, category, peptides),
          parentId: null,
          tags: ["category", slug],
        })
      ] += 1;
    }

    for (const [slug, peptide] of Object.entries(peptides)) {
      const primary = peptide.categories[0];
      counts[
        await upsertPage(context, peptidePageId(slug), {
          title: peptide.name,
          body: peptideBody(peptide, peptides),
          parentId: primary ? categoryPageId(primary) : null,
          tags: ["peptide", ...peptide.categories],
        })
      ] += 1;
    }

    const schema: CollectionInput = {
      name: "Peptides",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "full_name", type: "text" },
        { name: "aliases", type: "text" },
        { name: "categories", type: "multi_select", options: Object.keys(categories) },
        { name: "status", type: "text" },
        { name: "benefit_count", type: "number" },
        { name: "side_effect_count", type: "number" },
        { name: "page", type: "relation" },
      ],
    };
    const existingCollection = await context.store.getCollection(ws, COLLECTION_ID);
    if (existingCollection) {
      await context.collections.update(ws, COLLECTION_ID, schema, existingCollection.version);
    } else {
      await context.collections.create(ws, schema, COLLECTION_ID);
    }

    let rows = 0;
    for (const [slug, peptide] of Object.entries(peptides)) {
      const rowId = `row_${slug}`;
      const existing = await context.store.getRow(ws, COLLECTION_ID, rowId);
      await context.collections.upsertRow(
        ws,
        COLLECTION_ID,
        {
          values: {
            name: peptide.name,
            full_name: peptide.full_name,
            aliases: peptide.aliases.join("; "),
            categories: peptide.categories,
            status: peptide.status,
            benefit_count: peptide.reported_benefits.length,
            side_effect_count: peptide.side_effects.length,
            page: peptidePageId(slug),
          },
        },
        { id: rowId, expectedVersion: existing?.version ?? null },
      );
      rows += 1;
    }

    process.stdout.write(
      `seeded ${config.database}\n` +
        `  pages   ${counts.created} created, ${counts.updated} updated ` +
        `(${Object.keys(categories).length} categories, ${Object.keys(peptides).length} peptides)\n` +
        `  rows    ${rows} in collection ${COLLECTION_ID}\n`,
    );
  } finally {
    await closeContext(context);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
