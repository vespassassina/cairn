import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { closeContext, createContext, loadConfig, ownerVia, userPath, type AppContext } from "@cairn/api";
import type { TableInput, PageInput, WriteContext } from "@cairn/core";

/**
 * Seed a local Cairn from the peptide wiki's source data.
 *
 * The wiki is a static site generated from `data/peptides.json`,
 * `data/categories.json` and `data/stacks.json`, so this reads the JSON rather
 * than scraping HTML. It exercises every feature at once:
 *
 * 1. A page per category, and a page per peptide beneath its first category.
 * 2. A Stacks page, with a page per stack beneath it.
 * 3. `related`, stack components and mixing notes become `[[page-id]]` links,
 *    so backlinks and neighbours have a real graph to walk.
 * 4. Peptides and Stacks tables, one row each, for query_table.
 *
 * Idempotent. Ids are derived from the wiki's slugs, and existing records are
 * updated with their current version, so re-running it after the wiki changes
 * updates in place.
 *
 * Usage: pnpm --filter @cairn/example-peptide-wiki seed <path-to-peptide-wiki>
 */

interface Citation {
  title: string;
  authors_year?: string;
  pubmed_url?: string;
}

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
  citations?: Citation[];
  mixing_notes?: { clinic_combos?: string[]; anecdotal_combos?: string[]; reported_avoid?: string[] };
  mixing_caution?: string;
  variant_note?: string;
}

interface Stack {
  title: string;
  component_slugs: string[];
  tagline: string;
  rationale: string;
  evidence_level: string;
  citations?: Citation[];
  typical_community_protocol?: string;
  safety_notes?: string;
  community_notes?: string;
  aka?: string[];
  mechanism_pk?: string;
}

interface Category {
  name: string;
  icon: string;
  summary: string;
  primer: string;
}

const peptidePageId = (slug: string): string => `pg_${slug}`;
const categoryPageId = (slug: string): string => `pg_cat_${slug}`;
const stackPageId = (slug: string): string => `pg_stack_${slug}`;
const STACKS_PAGE_ID = "pg_stacks";
const TABLE_ID = "col_peptides";
const STACKS_TABLE_ID = "col_stacks";

/** Every seed write says where it came from, so history reads sensibly. */
const BY: WriteContext = {
  actor: ownerVia("peptide wiki seed"),
  note: "Seeded from peptide-wiki/data",
};

function bullets(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

/** A link to a peptide page, or plain text for a name the wiki has no page for. */
function peptideLink(slug: string, all: Record<string, Peptide>): string {
  const peptide = all[slug];
  return peptide ? `[[${peptidePageId(slug)}|${peptide.name}]]` : slug;
}

function citationList(citations: Citation[] | undefined): string {
  if (!citations || citations.length === 0) return "";
  const lines = citations.map((citation) => {
    const who = citation.authors_year ? ` (${citation.authors_year})` : "";
    return citation.pubmed_url
      ? `- [${citation.title}](${citation.pubmed_url})${who}`
      : `- ${citation.title}${who}`;
  });
  return `## Citations\n\n${lines.join("\n")}`;
}

function mixingSection(peptide: Peptide, all: Record<string, Peptide>): string {
  const notes = peptide.mixing_notes;
  if (!notes && !peptide.mixing_caution) return "";
  const group = (label: string, slugs: string[] | undefined) =>
    slugs && slugs.length > 0 ? `**${label}:** ${slugs.map((slug) => peptideLink(slug, all)).join(", ")}` : "";
  return [
    "## Mixing notes",
    group("Combined in clinics", notes?.clinic_combos),
    group("Combined anecdotally", notes?.anecdotal_combos),
    group("Reported to avoid", notes?.reported_avoid),
    peptide.mixing_caution ?? "",
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

function peptideBody(
  slug: string,
  peptide: Peptide,
  all: Record<string, Peptide>,
  stacks: Record<string, Stack>,
): string {
  const related = peptide.related.map((other) => `- ${peptideLink(other, all)}`).join("\n");
  const dosing = peptide.dosing_protocols
    .map((dose) => `### ${dose.route}\n\n${dose.protocol}`)
    .join("\n\n");
  const inStacks = Object.entries(stacks)
    .filter(([, stack]) => stack.component_slugs.includes(slug))
    .map(([stackSlug, stack]) => `- [[${stackPageId(stackSlug)}|${stack.title}]]`)
    .join("\n");

  return [
    `_${peptide.tagline}_`,
    `**Full name:** ${peptide.full_name}`,
    peptide.aliases.length > 0 ? `**Also known as:** ${peptide.aliases.join(", ")}` : "",
    peptide.variant_note ? `**Variant note:** ${peptide.variant_note}` : "",
    `## Status\n\n${peptide.status}`,
    `## Origin\n\n${peptide.origin}`,
    `## Mechanism\n\n${peptide.mechanism}`,
    `## Research summary\n\n${peptide.research_summary}`,
    `## Reported benefits\n\n${bullets(peptide.reported_benefits)}`,
    `## Dosing protocols\n\n${dosing}`,
    `## Side effects\n\n${bullets(peptide.side_effects)}`,
    `## Safety notes\n\n${peptide.safety_notes}`,
    `## Community notes\n\n${peptide.community_notes}`,
    mixingSection(peptide, all),
    inStacks ? `## Stacks\n\n${inStacks}` : "",
    `## Related\n\n${related}`,
    citationList(peptide.citations),
  ]
    .filter((section) => section !== "")
    .join("\n\n");
}

function stackBody(stack: Stack, all: Record<string, Peptide>): string {
  return [
    `_${stack.tagline}_`,
    stack.aka && stack.aka.length > 0 ? `**Also known as:** ${stack.aka.join(", ")}` : "",
    `**Evidence level:** ${stack.evidence_level}`,
    `## Components\n\n${stack.component_slugs.map((slug) => `- ${peptideLink(slug, all)}`).join("\n")}`,
    `## Rationale\n\n${stack.rationale}`,
    stack.mechanism_pk ? `## Mechanism and pharmacokinetics\n\n${stack.mechanism_pk}` : "",
    stack.typical_community_protocol ? `## Typical community protocol\n\n${stack.typical_community_protocol}` : "",
    stack.safety_notes ? `## Safety notes\n\n${stack.safety_notes}` : "",
    stack.community_notes ? `## Community notes\n\n${stack.community_notes}` : "",
    citationList(stack.citations),
  ]
    .filter((section) => section !== "")
    .join("\n\n");
}

function stacksIndexBody(stacks: Record<string, Stack>): string {
  const lines = Object.entries(stacks).map(
    ([slug, stack]) => `- [[${stackPageId(slug)}|${stack.title}]]: ${stack.tagline}`,
  );
  return `Combinations of peptides that people run together, with the reasoning and how strong the evidence is.\n\n## Stacks\n\n${lines.join("\n")}`;
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
    await context.pages.update(context.workspaceId, id, input, existing.version, BY);
    return "updated";
  }
  await context.pages.create(context.workspaceId, input, BY, id);
  return "created";
}

async function main(): Promise<void> {
  const wiki = process.argv[2] ? userPath(process.argv[2]) : undefined;
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
  // Older copies of the wiki have no stacks file.
  const stacks = JSON.parse(
    await readFile(join(wiki, "data", "stacks.json"), "utf8").catch(() => "{}"),
  ) as Record<string, Stack>;

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
          body: peptideBody(slug, peptide, peptides, stacks),
          parentId: primary ? categoryPageId(primary) : null,
          tags: ["peptide", ...peptide.categories],
        })
      ] += 1;
    }

    if (Object.keys(stacks).length > 0) {
      counts[
        await upsertPage(context, STACKS_PAGE_ID, {
          title: "Stacks",
          body: stacksIndexBody(stacks),
          parentId: null,
          tags: ["stacks"],
        })
      ] += 1;
      for (const [slug, stack] of Object.entries(stacks)) {
        counts[
          await upsertPage(context, stackPageId(slug), {
            title: stack.title,
            body: stackBody(stack, peptides),
            parentId: STACKS_PAGE_ID,
            tags: ["stack", stack.evidence_level],
          })
        ] += 1;
      }
    }

    const schema: TableInput = {
      name: "Peptides",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "full_name", type: "text" },
        { name: "aliases", type: "text" },
        { name: "categories", type: "multi_select", options: Object.keys(categories) },
        { name: "status", type: "text" },
        { name: "benefit_count", type: "number" },
        { name: "side_effect_count", type: "number" },
        { name: "citation_count", type: "number" },
        { name: "page", type: "relation" },
      ],
    };
    const existingTable = await context.store.getTable(ws, TABLE_ID);
    if (existingTable) {
      await context.tables.update(ws, TABLE_ID, schema, existingTable.version, BY);
    } else {
      await context.tables.create(ws, schema, BY, TABLE_ID);
    }

    let rows = 0;
    for (const [slug, peptide] of Object.entries(peptides)) {
      const rowId = `row_${slug}`;
      const existing = await context.store.getRow(ws, TABLE_ID, rowId);
      await context.tables.upsertRow(
        ws,
        TABLE_ID,
        {
          values: {
            name: peptide.name,
            full_name: peptide.full_name,
            aliases: peptide.aliases.join("; "),
            categories: peptide.categories,
            status: peptide.status,
            benefit_count: peptide.reported_benefits.length,
            side_effect_count: peptide.side_effects.length,
            citation_count: peptide.citations?.length ?? 0,
            page: peptidePageId(slug),
          },
        },
        BY,
        { id: rowId, expectedVersion: existing?.version ?? null },
      );
      rows += 1;
    }

    let stackRows = 0;
    if (Object.keys(stacks).length > 0) {
      const evidence = [...new Set(Object.values(stacks).map((stack) => stack.evidence_level))].sort();
      const stackSchema: TableInput = {
        name: "Stacks",
        fields: [
          { name: "title", type: "text", required: true },
          { name: "components", type: "multi_select", options: Object.keys(peptides) },
          { name: "evidence_level", type: "select", options: evidence },
          { name: "citation_count", type: "number" },
          { name: "page", type: "relation" },
        ],
      };
      const existingStacks = await context.store.getTable(ws, STACKS_TABLE_ID);
      if (existingStacks) {
        await context.tables.update(ws, STACKS_TABLE_ID, stackSchema, existingStacks.version, BY);
      } else {
        await context.tables.create(ws, stackSchema, BY, STACKS_TABLE_ID);
      }
      for (const [slug, stack] of Object.entries(stacks)) {
        const rowId = `row_${slug}`;
        const existing = await context.store.getRow(ws, STACKS_TABLE_ID, rowId);
        await context.tables.upsertRow(
          ws,
          STACKS_TABLE_ID,
          {
            values: {
              title: stack.title,
              components: stack.component_slugs,
              evidence_level: stack.evidence_level,
              citation_count: stack.citations?.length ?? 0,
              page: stackPageId(slug),
            },
          },
          BY,
          { id: rowId, expectedVersion: existing?.version ?? null },
        );
        stackRows += 1;
      }
    }

    process.stdout.write(
      `seeded ${config.database}\n` +
        `  pages   ${counts.created} created, ${counts.updated} updated ` +
        `(${Object.keys(categories).length} categories, ${Object.keys(peptides).length} peptides, ` +
        `${Object.keys(stacks).length} stacks)\n` +
        `  rows    ${rows} in ${TABLE_ID}, ${stackRows} in ${STACKS_TABLE_ID}\n`,
    );
  } finally {
    await closeContext(context);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
