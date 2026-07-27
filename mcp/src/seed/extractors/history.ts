// sg seed — git-history extractors: Regression and Decision nodes.
// Deterministic Tier 1: conventional-commit prefixes, revert detection,
// repeated-fix clustering, merge-commit bodies, ADR/RFC documents.

import type { DraftNode, Extractor, ExtractorContext, MinedCommit } from "../types.js";
import { makeNodeId, normalizeForDedupe } from "../ids.js";

const FIX_SUBJECT = /^(fix|hotfix|bugfix)(\(|!|:|\s)/i;
const REVERT_SUBJECT = /^revert\b/i;
const REVERT_BODY_SHA = /This reverts commit ([0-9a-f]{7,40})/i;
const ISSUE_REF = /(?:#|\b(?:GH|ISSUE)-)(\d+)\b/gi;

function truncate(text: string, max = 300): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 1).trimEnd() + "…";
}

export function issueRefs(c: MinedCommit): string[] {
  const refs = new Set<string>();
  for (const m of `${c.subject}\n${c.body}`.matchAll(ISSUE_REF)) refs.add(m[1]);
  return [...refs];
}

/** Regressions: reverts (strong), fix commits (moderate), repeat-fix clusters. */
export const regressionExtractor: Extractor = {
  name: "regression-commits",
  version: "1",
  produces: ["Regression"],
  extract(ctx: ExtractorContext): DraftNode[] {
    const drafts: DraftNode[] = [];
    const shaIndex = new Map(ctx.commits.map(c => [c.sha, c]));
    const shortIndex = new Map(ctx.commits.map(c => [c.shortSha, c]));

    // ── Reverts: the strongest regression signal in a repo's history ──
    for (const c of ctx.commits) {
      if (!REVERT_SUBJECT.test(c.subject)) continue;
      const revertedSha = c.body.match(REVERT_BODY_SHA)?.[1];
      const reverted = revertedSha
        ? shaIndex.get(revertedSha) ?? shortIndex.get(revertedSha.slice(0, 7))
        : undefined;
      const what = c.subject.replace(REVERT_SUBJECT, "").replace(/^[:\s"]+|"$/g, "").trim() || "a prior change";
      drafts.push({
        id: makeNodeId("Regression", `REVERT ${what}`, c.sha),
        type: "Regression",
        label: `Reverted: ${truncate(what, 80)}`,
        summary: truncate(
          `Commit ${reverted ? reverted.shortSha : "(outside window)"} ("${what}") was reverted by ${c.shortSha}. ` +
          `A change that had to be backed out marks code where the naive approach failed once already. ` +
          (c.body ? `Revert rationale: ${truncate(c.body.replace(REVERT_BODY_SHA, "").trim(), 140)}` : ""),
          400
        ),
        tags: ["seeded", "revert"],
        files: (reverted?.files ?? c.files).slice(0, 6),
        edges: [],
        confidence: 0.9,
        lastUpdated: c.authorDate,
        provenance: {
          commits: reverted ? [c.sha, reverted.sha] : [c.sha],
          locations: [],
          extractor: "regression-commits",
          extractorVersion: "1",
        },
        regressedNTimes: 1,
      });
    }

    // ── Fix-commit clusters: same file fixed repeatedly = recurring bug ──
    const fixCommits = ctx.commits.filter(c => FIX_SUBJECT.test(c.subject) && !REVERT_SUBJECT.test(c.subject));
    const byFile = new Map<string, MinedCommit[]>();
    for (const c of fixCommits) {
      for (const f of c.files) {
        if (!byFile.has(f)) byFile.set(f, []);
        byFile.get(f)!.push(c);
      }
    }
    const clustered = new Set<string>();
    for (const [file, commits] of [...byFile.entries()].sort()) {
      if (commits.length < 2) continue;
      const key = commits.map(c => c.sha).sort().join("+");
      if (clustered.has(key)) continue; // same commit set already clustered via another file
      clustered.add(key);
      const subjects = commits.map(c => `"${truncate(c.subject, 60)}" (${c.shortSha})`);
      drafts.push({
        id: makeNodeId("Regression", `REPEAT FIX ${file}`, key),
        type: "Regression",
        label: `Repeatedly fixed: ${file}`,
        summary: truncate(
          `${file} received ${commits.length} separate fix commits in the mined window: ${subjects.join(", ")}. ` +
          `Multiple fixes to the same file suggest a recurring failure mode or a symptomatic-fix pattern worth root-causing.`,
          450
        ),
        tags: ["seeded", "repeat-fix"],
        files: [file],
        edges: [],
        confidence: 0.8,
        lastUpdated: commits[0].authorDate, // commits are newest-first
        provenance: {
          commits: commits.map(c => c.sha),
          locations: [file],
          extractor: "regression-commits",
          extractorVersion: "1",
        },
        regressedNTimes: commits.length,
      });
      commits.forEach(c => clustered.add(c.sha));
    }

    // ── Individual fix commits with substantive bodies ──
    for (const c of fixCommits) {
      if (clustered.has(c.sha)) continue; // already represented in a cluster
      const hasBody = c.body.length >= 40;
      drafts.push({
        id: makeNodeId("Regression", c.subject, c.sha),
        type: "Regression",
        label: truncate(c.subject.replace(FIX_SUBJECT, m => m).trim(), 80),
        summary: truncate(
          `Bug fixed in ${c.shortSha}: ${c.subject}. ` + (hasBody ? c.body : ""),
          400
        ),
        tags: ["seeded", "fix-commit"],
        files: c.files.slice(0, 6),
        edges: [],
        confidence: hasBody ? 0.65 : 0.55,
        lastUpdated: c.authorDate,
        provenance: {
          commits: [c.sha],
          locations: [],
          extractor: "regression-commits",
          extractorVersion: "1",
        },
        regressedNTimes: 1,
      });
    }

    return drafts;
  },
};

const ADR_PATH = /(^|\/)(adr|adrs|rfc|rfcs|decisions?|design-docs?)\//i;
const ADR_FILE = /(^|\/)(adr|rfc)[-_]?\d+.*\.md$|\.adr\.md$/i;

/** Decisions: ADR/RFC docs (strong), merge commits with substantive bodies. */
export const decisionExtractor: Extractor = {
  name: "decision-history",
  version: "1",
  produces: ["Decision"],
  extract(ctx: ExtractorContext): DraftNode[] {
    const drafts: DraftNode[] = [];

    // ── ADR / RFC / design-doc files in the working tree ──
    for (const f of ctx.worktreeFiles) {
      if (!f.endsWith(".md")) continue;
      if (!ADR_PATH.test(f) && !ADR_FILE.test(f)) continue;
      const content = ctx.readFile(f);
      if (!content.trim()) continue;
      const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? f;
      const firstPara = content
        .split(/\n\s*\n/)
        .map(p => p.replace(/^#.*$/gm, "").trim())
        .find(p => p.length > 40) ?? "";
      drafts.push({
        id: makeNodeId("Decision", title, f),
        type: "Decision",
        label: truncate(title, 80),
        summary: truncate(`Recorded decision document (${f}). ${firstPara}`, 400),
        tags: ["seeded", "adr"],
        files: [f],
        edges: [],
        confidence: 0.9,
        lastUpdated: ctx.headDate,
        provenance: {
          commits: [],
          locations: [f],
          extractor: "decision-history",
          extractorVersion: "1",
        },
      });
    }

    // ── Merge commits with substantive bodies (PR descriptions land here) ──
    for (const c of ctx.commits) {
      if (c.parents.length < 2) continue;
      const body = c.body.trim();
      if (body.length < 120) continue;
      const prRef = c.subject.match(/#(\d+)/)?.[1];
      drafts.push({
        id: makeNodeId("Decision", body.split("\n")[0] || c.subject, c.sha),
        type: "Decision",
        label: truncate(body.split("\n")[0] || c.subject, 80),
        summary: truncate(
          `Merged change (${c.shortSha}${prRef ? `, PR #${prRef}` : ""}): ${body}`,
          400
        ),
        tags: ["seeded", "merge"],
        files: c.files.slice(0, 6),
        edges: [],
        confidence: 0.6,
        lastUpdated: c.authorDate,
        provenance: {
          commits: [c.sha],
          locations: [],
          extractor: "decision-history",
          extractorVersion: "1",
        },
      });
    }

    // ── Deliberate-change commits: migrate/switch/adopt/deprecate with a body ──
    const DELIBERATE = /^(refactor|migrate|switch|adopt|deprecate|replace|drop|remove)\b/i;
    for (const c of ctx.commits) {
      if (c.parents.length >= 2) continue;
      if (!DELIBERATE.test(c.subject) || c.body.length < 60) continue;
      drafts.push({
        id: makeNodeId("Decision", c.subject, c.sha),
        type: "Decision",
        label: truncate(c.subject, 80),
        summary: truncate(`Deliberate change in ${c.shortSha}: ${c.subject}. ${c.body}`, 400),
        tags: ["seeded", "deliberate-change"],
        files: c.files.slice(0, 6),
        edges: [],
        confidence: 0.6,
        lastUpdated: c.authorDate,
        provenance: {
          commits: [c.sha],
          locations: [],
          extractor: "decision-history",
          extractorVersion: "1",
        },
      });
    }

    // Dedupe decisions whose normalized labels collide (e.g. ADR + its merge).
    const seen = new Map<string, DraftNode>();
    for (const d of drafts) {
      const key = normalizeForDedupe(d.label);
      const prior = seen.get(key);
      if (!prior || d.confidence > prior.confidence) seen.set(key, d);
    }
    return [...seen.values()];
  },
};
