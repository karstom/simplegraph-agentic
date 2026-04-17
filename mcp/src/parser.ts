// simplegraph-agentic: markdown node parser
// Parses ## NODE: blocks from graph markdown files.

export interface GraphNode {
  id: string;
  type: string;
  priority: string;
  label: string;
  summary: string;
  regressedNTimes?: number;
  edges: string[];
  files: string[];
  lastUpdated: string;
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

    // Edges block: lines between **Edges:** and the next **Field:** or ---
    const edgesBlock =
      section.match(/\*\*Edges:\*\*\n([\s\S]*?)(?=\n\*\*[A-Za-z]|\n---)/)?.[1] ?? "";
    const edges = (edgesBlock.match(/- .+/g) ?? []).map(e => e.trim());

    // Files: strip backticks
    const filesStr = get("Files");
    const files = (filesStr.match(/`[^`]+`/g) ?? []).map(f => f.slice(1, -1));

    const regressedMatch = section.match(/\*\*REGRESSED_N_TIMES:\*\*\s*(\d+)/);

    return [{
      id: idMatch[1],
      type: get("Type"),
      priority: get("Priority"),
      label: get("Label"),
      summary: get("Summary"),
      regressedNTimes: regressedMatch ? parseInt(regressedMatch[1], 10) : undefined,
      edges,
      files,
      lastUpdated: get("LastUpdated"),
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
  ];
  if (node.regressedNTimes !== undefined) {
    lines.push(`**REGRESSED_N_TIMES:** ${node.regressedNTimes}`);
  }
  lines.push(`**Edges:**`);
  for (const edge of node.edges) {
    lines.push(`- ${edge.startsWith("- ") ? edge.slice(2) : edge}`);
  }
  lines.push(`**Files:** ${node.files.map(f => `\`${f}\``).join(", ")}`);
  lines.push(`**LastUpdated:** ${node.lastUpdated}`);
  return lines.join("\n");
}
