// sg seed — find commits that may record an architectural decision.
//
// The history extractor only mints a Decision when a commit subject starts with
// an explicit verb (refactor/migrate/adopt/deprecate/...) or when an ADR file
// exists. Most real decisions do not announce themselves that way — they are
// recorded in the *body* of an ordinary commit, in prose. Seeding this repo
// found 2 Decisions across 43 commits for exactly that reason.
//
// This module does the deterministic half of closing that gap: pick out the
// commits worth a human or agent reading. The judgment half — is there actually
// a rationale here, and what should the node say — belongs to whichever model
// the user already has connected, via the simplegraph_seed_candidates MCP tool.
// Nothing here calls a model or needs an API key.
//
// Seeding is structurally lossy for decisions: where the "why" was never
// written down it cannot be recovered, and inventing one is worse than a
// missing node. The filter therefore favours commits that plausibly contain
// reasoning, and the reviewing agent is told it may decline.

import type { ExtractorContext, MinedCommit } from "./types.js";
import { makeNodeId } from "./ids.js";

/**
 * Git trailers and bot boilerplate: metadata, not rationale.
 *
 * Squash-merge repositories often carry a long trailer block and nothing else.
 * Vizro's history is the clear case — 1,192 of its 1,284 non-merge commits have
 * no prose body, yet eight `Co-authored-by:` lines clear any length floor, so
 * every candidate the filter offered was pure trailer noise. Strip these before
 * measuring a body or searching it for reasoning.
 */
const TRAILER_LINE =
  /^\s*(?:[A-Za-z][A-Za-z-]*-by|Cc|Change-Id|Signed-off|Fixes|Closes|Refs|Reviewed|Reported|Suggested|Acked|Tested|Reviewed-on)\s*:/i;

/** The part of a commit message that is actually prose. */
export function proseBody(body: string): string {
  return body
    .split("\n")
    .filter(line => !TRAILER_LINE.test(line))
    .join("\n")
    .trim();
}

/** Minimum body length before a commit is worth a model call. */
const MIN_BODY_CHARS = 120;

/**
 * Absolute floor for the no-connective fallback: a repository whose messages
 * are uniformly short should surface none of them on length alone.
 */
const MIN_SUBSTANTIAL_BODY_CHARS = 400;

/**
 * A body with no connective marker is still worth reviewing when it is long
 * *for this repository* — the reviewing agent is the precision filter, so this
 * gate exists to bound the queue, not to judge quality. Tuning it for precision
 * loses real decisions: this repo's Root-Cause Gate commit records the choice of
 * a hard block over an advisory warning, and names the tradeoff, without once
 * writing "because".
 *
 * The threshold is repo-relative because an absolute one does not travel. At a
 * flat 400 characters this filter offered half of Zerofeed's 718 commits, whose
 * messages are disciplined and long (median eligible body: 637 characters).
 * Taking the 75th percentile instead lands both that repository and this one at
 * roughly a quarter of their history. The comparison is strictly greater-than,
 * so a repository whose messages are all the same length offers none of them —
 * there is no signal to rank on.
 *
 * A percentile needs a population: below MIN_SAMPLE eligible commits the
 * absolute floor is used instead, so a young repository with one long,
 * decision-bearing commit still surfaces it.
 */
const MIN_SAMPLE = 8;

function substantialBodyThreshold(bodyLengths: number[]): number {
  if (bodyLengths.length < MIN_SAMPLE) return MIN_SUBSTANTIAL_BODY_CHARS - 1;
  const sorted = [...bodyLengths].sort((a, b) => a - b);
  const p75 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))];
  return Math.max(p75, MIN_SUBSTANTIAL_BODY_CHARS);
}

/**
 * Prose that indicates a rationale was actually recorded, rather than a
 * description of what changed. This is the cheap deterministic gate that keeps
 * the API bill proportional to the reasoning in the history.
 */
const REASONING_MARKERS =
  /\b(because|instead of|rather than|as opposed to|in favou?r of|we chose|chose to|we decided|decided to|the reason|why we|trade[- ]?off|alternative|downside|otherwise|so that|avoids?|prevents?)\b/i;

/** Subjects the deterministic Decision extractor already claims. */
const ALREADY_EXTRACTED =
  /^(refactor|migrate|switch|adopt|deprecate|replace|drop|remove)\b/i;

// ── Candidate selection (deterministic, no API) ───────────────────────────────

export interface CandidateSelection {
  candidates: MinedCommit[];
  /** Candidates dropped by the budget cap — reported, never silently trimmed. */
  dropped: number;
}

/**
 * Choose the commits worth asking about: ordinary (non-merge) commits carrying
 * a substantive body with explicit rationale, that the deterministic extractor
 * has not already claimed.
 *
 * Ordering is by body length descending then SHA, so the same repository always
 * produces the same candidate list and the same cap boundary.
 */
export function selectDecisionCandidates(
  ctx: ExtractorContext,
  limit: number
): CandidateSelection {
  // Judge the prose only: a trailer block is metadata, not a rationale.
  const prose = new Map(ctx.commits.map(c => [c.sha, proseBody(c.body)]));
  const bodyOf = (c: MinedCommit) => prose.get(c.sha) ?? "";

  // Two passes: establish what "long" means for this repository, then apply it.
  const preFiltered = ctx.commits.filter(c =>
    c.parents.length < 2 &&
    bodyOf(c).length >= MIN_BODY_CHARS &&
    !ALREADY_EXTRACTED.test(c.subject)
  );
  const threshold = substantialBodyThreshold(preFiltered.map(c => bodyOf(c).length));

  const eligible = preFiltered.filter(c =>
    REASONING_MARKERS.test(bodyOf(c)) || bodyOf(c).length > threshold
  );

  // Commits with an explicit connective rank first, so when the cap bites it
  // drops the weakest candidates rather than an arbitrary slice.
  eligible.sort((a, b) =>
    Number(REASONING_MARKERS.test(bodyOf(b))) - Number(REASONING_MARKERS.test(bodyOf(a))) ||
    bodyOf(b).length - bodyOf(a).length ||
    (a.sha < b.sha ? -1 : 1)
  );

  return {
    candidates: eligible.slice(0, limit),
    dropped: Math.max(0, eligible.length - limit),
  };
}

/**
 * The node ID a Decision mined from this commit would carry.
 *
 * Identity comes from git — the commit subject and SHA — never from whatever
 * an agent decides to call it. That makes the candidate list self-limiting: a
 * commit whose node already exists is simply not offered again, however the
 * agent worded it.
 */
export function decisionIdFor(commit: MinedCommit): string {
  return makeNodeId("Decision", commit.subject, commit.sha);
}

/** A squash-merged pull request reference, as GitHub writes it into the subject. */
const PR_REF = /\(#(\d+)\)\s*$/;

/** Prefixes that plainly do not record an architectural decision. */
const NON_DECISION_PREFIX = /^\[?(Docs?|Release|QA|CI|Chore|pre-commit)/i;

/** Source, as opposed to tests, docs and fixtures. */
const SOURCE_FILE = /\.(py|ts|tsx|js|jsx|rs|go|java|rb|kt|swift|c|cc|cpp|h|cs|php)$/i;
const TEST_PATH = /(^|\/)(tests?|spec|__tests__|e2e)(\/|$)|\.(test|spec)\./i;

export interface PullRequestTrail {
  /** Commits naming a pull request. */
  total: number;
  /** Those that plausibly changed behaviour, most recent first. */
  worthReading: { number: string; subject: string; date: string }[];
  /** How many plausible ones exist beyond the returned sample. */
  more: number;
}

/**
 * Where the reasoning went, when it is not in the commit message.
 *
 * A squash-merge workflow leaves the pull request number in the subject —
 * 1,198 of Vizro's 1,284 non-merge commits carry one — so the rationale stays
 * locatable even though git does not hold it. Vizro PR #1537 is 4,400
 * characters of exactly the reasoning a Decision node wants, against a commit
 * body of nothing but Co-authored-by lines.
 *
 * This reports references only. Fetching them needs GitHub access, which the
 * agent calling this generally has and simplegraph deliberately does not.
 *
 * The list is filtered, not ranked. Docs/release/QA changes are excluded
 * because they plainly do not record decisions; beyond that there is no honest
 * local signal for which PR holds a rationale, since that lives in text this
 * process cannot see. Ranking the remainder by files touched was tried and was
 * worse — it promotes formatting sweeps and dependency bumps over architecture,
 * and buried both of the Vizro PRs that actually carry reasoning.
 */
export function pullRequestTrail(ctx: ExtractorContext, sampleSize = 10): PullRequestTrail {
  const withPr = ctx.commits.filter(c => c.parents.length < 2 && PR_REF.test(c.subject));
  const plausible = withPr.filter(c => {
    const subject = c.subject.replace(PR_REF, "").trim();
    if (NON_DECISION_PREFIX.test(subject)) return false;
    return c.files.some(f => SOURCE_FILE.test(f) && !TEST_PATH.test(f));
  });

  return {
    total: withPr.length,
    worthReading: plausible.slice(0, sampleSize).map(c => ({
      number: c.subject.match(PR_REF)![1],
      subject: c.subject.replace(PR_REF, "").trim(),
      date: c.authorDate,
    })),
    more: Math.max(0, plausible.length - sampleSize),
  };
}
