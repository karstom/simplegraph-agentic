// simplegraph-agentic: markdown node parser
// Parses ## NODE: blocks from graph markdown files.

export interface GraphNode {
  id: string;
  type: string;
  priority: string;
  label: string;
  summary: string;
  tags: string[];
  regressedNTimes?: number;
  rootCause?: string;
  edges: string[];
  files: string[];
  lastUpdated: string;
  /** Who created the node — an agent/tool name or human, for multi-agent attribution. */
  author?: string;
  /** Session identifier the node was created in, for arbitrating concurrent writes. */
  session?: string;
  /** Present on nodes written by `sg seed`: "<extractor>@<ver> | confidence: N | hash: H". */
  seeded?: string;
  /** Present on seeded nodes: commits and file locations the node was mined from. */
  provenance?: string;
  rawContent: string;
  sourceFile: string;
}

/** Parse all ## NODE: blocks from a markdown string. */
export function parseNodes(content: string, sourceFile: string): GraphNode[] {
  // Split on any line that starts a new NODE block
  const sections = content.split(/(?=^## NODE:)/m).filter(s => /^## NODE:/m.test(s));

  return sections.flatMap((section): GraphNode[] => {
    const idMatch = section.match(/^## NODE:\s*([A-Z][A-Z0-9_]*)/m);
    if (!idMatch) return [];

    const get = (field: string): string =>
      section.match(new RegExp(`\\*\\*${field}:\\*\\*\\s*(.+)`))?.[1]?.trim() ?? "";

    // Edges block: lines between **Edges:** and the next **Field:** or --- or end of string
    const edgesBlock =
      section.match(/\*\*Edges:\*\*\n([\s\S]*?)(?=\n\*\*[A-Za-z]|\n---|$)/)?.[1] ?? "";
    const edges = (edgesBlock.match(/- .+/g) ?? []).map(e => e.trim());

    // Files: strip backticks
    const filesStr = get("Files");
    const files = (filesStr.match(/`[^`]+`/g) ?? []).map(f => f.slice(1, -1));

    // Tags: comma-separated plain text; filter placeholder
    const tagsStr = get("Tags");
    const tags = tagsStr && tagsStr !== "_(none)_"
      ? tagsStr.split(",").map(t => t.trim()).filter(Boolean)
      : [];

    const regressedMatch = section.match(/\*\*REGRESSED_N_TIMES:\*\*\s*(\d+)/);
    const rootCauseMatch = section.match(/\*\*RootCause:\*\*\s*(.+)/);

    return [{
      id: idMatch[1],
      type: get("Type"),
      priority: get("Priority"),
      label: get("Label"),
      summary: get("Summary"),
      tags,
      regressedNTimes: regressedMatch ? parseInt(regressedMatch[1], 10) : undefined,
      rootCause: rootCauseMatch ? rootCauseMatch[1].trim() : undefined,
      edges,
      files,
      lastUpdated: get("LastUpdated"),
      author: get("Author") || undefined,
      session: get("Session") || undefined,
      seeded: get("Seeded") || undefined,
      provenance: get("Provenance") || undefined,
      rawContent: section,
      sourceFile,
    }];
  });
}

/** Format a node as a markdown block ready to append to a file. */
export function formatNode(
  node: Omit<GraphNode, "rawContent" | "sourceFile">
): string {
  const lines: string[] = [
    `## NODE: ${node.id}`,
    `**Type:** ${node.type}`,
    `**Priority:** ${node.priority}`,
    `**Label:** ${node.label}`,
    `**Summary:** ${node.summary}`,
    `**Tags:** ${node.tags.length > 0 ? node.tags.join(", ") : "_(none)_"}`,
  ];
  if (node.regressedNTimes !== undefined) {
    lines.push(`**REGRESSED_N_TIMES:** ${node.regressedNTimes}`);
    if (node.rootCause) {
      lines.push(`**RootCause:** ${node.rootCause}`);
    }
  }
  if (node.edges.length > 0) {
    lines.push(`**Edges:**`);
    for (const edge of node.edges) {
      lines.push(`- ${edge.startsWith("- ") ? edge.slice(2) : edge}`);
    }
  } else {
    lines.push(`**Edges:** _(none)_`);
  }
  lines.push(`**Files:** ${node.files.length > 0 ? node.files.map(f => `\`${f}\``).join(", ") : "_(none)_"}`);
  lines.push(`**LastUpdated:** ${node.lastUpdated}`);
  if (node.author) lines.push(`**Author:** ${node.author}`);
  if (node.session) lines.push(`**Session:** ${node.session}`);
  if (node.provenance) lines.push(`**Provenance:** ${node.provenance}`);
  if (node.seeded) lines.push(`**Seeded:** ${node.seeded}`);
  return lines.join("\n");
}
