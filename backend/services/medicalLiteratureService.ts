import crypto from "node:crypto";

export interface CitationCandidate {
  id: string;
  rawText: string;
  sourceDocumentId?: string;
  sourceDocumentName?: string;
  titleGuess?: string;
  journalGuess?: string;
  year?: number;
}

export interface ResolvedLiteratureItem {
  id: string;
  title: string;
  abstract?: string;
  journal?: string;
  year?: number;
  authors?: string[];
  url?: string;
  source: "semantic-scholar" | "crossref";
  matchedCitation: CitationCandidate;
}

export interface LiteratureSearchResult {
  resolved: ResolvedLiteratureItem[];
  unresolved: CitationCandidate[];
}

interface DetectionOptions {
  limit?: number;
  sourceDocumentId?: string;
  sourceDocumentName?: string;
}

interface ResolveOptions {
  limit?: number;
  semanticScholarApiKey?: string;
}

const DEFAULT_DETECTION_LIMIT = 6;
const DEFAULT_RESOLVE_LIMIT = 8;
const SEMANTIC_SCHOLAR_API_KEY = process.env.SEMANTIC_SCHOLAR_API_KEY;

const normalizeWhitespace = (value: string) => value.replace(/\s+/g, " ").trim();

const guessTitleFromCitation = (value: string): string | undefined => {
  const quoted = value.match(/“([^”]+)”|"([^"]+)"|‘([^’]+)’|'([^']+)'/);
  if (quoted) {
    return quoted[1] ?? quoted[2] ?? quoted[3] ?? quoted[4];
  }
  const afterYear = value.match(/\)\s*([^\.]+)\./);
  if (afterYear && afterYear[1]?.length > 8) {
    return normalizeWhitespace(afterYear[1]);
  }
  return undefined;
};

export const detectReferenceCandidates = (text: string | null | undefined, options?: DetectionOptions): CitationCandidate[] => {
  if (!text) {
    return [];
  }

  const limit = options?.limit ?? DEFAULT_DETECTION_LIMIT;
  const lines = text
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const yearRegex = /\b(19|20)\d{2}\b/;
  const candidates: CitationCandidate[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (candidates.length >= limit) {
      break;
    }

    const line = lines[index];
    if (!yearRegex.test(line) || line.length < 20) {
      continue;
    }

    const titleGuess = guessTitleFromCitation(line);
    const yearMatch = line.match(yearRegex);
    const candidate: CitationCandidate = {
      id: `${options?.sourceDocumentId ?? "doc"}-${index}-${crypto.randomUUID()}`,
      rawText: line,
      sourceDocumentId: options?.sourceDocumentId,
      sourceDocumentName: options?.sourceDocumentName,
      titleGuess,
      year: yearMatch ? Number.parseInt(yearMatch[0], 10) : undefined,
    };

    const journalMatch = line.match(/\.?\s*([A-Z][A-Za-z\s&-]+)\s+\d{4}/);
    if (journalMatch && journalMatch[1] && journalMatch[1].length > 5) {
      candidate.journalGuess = normalizeWhitespace(journalMatch[1]);
    }

    candidates.push(candidate);
  }

  return candidates;
};

const buildQueryFromCitation = (candidate: CitationCandidate): string => {
  if (candidate.titleGuess) {
    return candidate.titleGuess;
  }
  if (candidate.journalGuess && candidate.year) {
    return `${candidate.journalGuess} ${candidate.year}`;
  }
  return candidate.rawText.slice(0, 240);
};

const querySemanticScholar = async (query: string, candidate: CitationCandidate, apiKey?: string): Promise<ResolvedLiteratureItem | null> => {
  const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
  url.searchParams.set("query", query);
  url.searchParams.set("limit", "1");
  url.searchParams.set("fields", "title,abstract,year,venue,publicationVenue,authors,url,externalIds");

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as { data?: Array<Record<string, any>> };
  const first = data?.data?.[0];
  if (!first) {
    return null;
  }

  const doi = first.externalIds?.DOI;
  const authors: string[] | undefined = Array.isArray(first.authors)
    ? first.authors.map((author: any) => author.name).filter((name: string | undefined): name is string => Boolean(name))
    : undefined;

  return {
    id: first.paperId ?? doi ?? crypto.randomUUID(),
    title: first.title ?? query,
    abstract: first.abstract ?? undefined,
    journal: first.venue ?? first.publicationVenue?.name,
    year: first.year ?? candidate.year,
    authors,
    url: first.url ?? (doi ? `https://doi.org/${doi}` : undefined),
    source: "semantic-scholar",
    matchedCitation: candidate,
  };
};

const queryCrossref = async (query: string, candidate: CitationCandidate): Promise<ResolvedLiteratureItem | null> => {
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("rows", "1");
  url.searchParams.set("select", "DOI,title,author,issued,container-title,abstract,URL");
  url.searchParams.set("query.bibliographic", query);

  const response = await fetch(url);
  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as { message?: { items?: Array<Record<string, any>> } };
  const first = data?.message?.items?.[0];
  if (!first) {
    return null;
  }

  const authors: string[] | undefined = Array.isArray(first.author)
    ? first.author
        .map((author: any) => [author.given, author.family].filter(Boolean).join(" ").trim())
        .filter((name: string) => Boolean(name))
    : undefined;

  const issuedYear = first.issued?.["date-parts"]?.[0]?.[0];

  return {
    id: first.DOI ?? crypto.randomUUID(),
    title: Array.isArray(first.title) && first.title.length > 0 ? first.title[0] : candidate.titleGuess ?? query,
    abstract: typeof first.abstract === "string" ? first.abstract.replace(/<\/?jats:[^>]+>/g, "") : undefined,
    journal:
      (Array.isArray(first["container-title"]) && first["container-title"][0]) ||
      candidate.journalGuess,
    year: issuedYear ?? candidate.year,
    authors,
    url: first.URL ?? (first.DOI ? `https://doi.org/${first.DOI}` : undefined),
    source: "crossref",
    matchedCitation: candidate,
  };
};

export const resolveLiteratureReferences = async (
  citations: CitationCandidate[],
  options?: ResolveOptions
): Promise<LiteratureSearchResult> => {
  if (!citations.length) {
    return { resolved: [], unresolved: [] };
  }

  const limit = options?.limit ?? DEFAULT_RESOLVE_LIMIT;
  const scopedCitations = citations.slice(0, limit);
  const resolved: ResolvedLiteratureItem[] = [];
  const handledIds = new Set<string>();

  for (const candidate of scopedCitations) {
    const query = buildQueryFromCitation(candidate);

    try {
      const semanticResult = await querySemanticScholar(query, candidate, options?.semanticScholarApiKey ?? SEMANTIC_SCHOLAR_API_KEY);
      if (semanticResult) {
        resolved.push(semanticResult);
        handledIds.add(candidate.id);
        continue;
      }
    } catch (error) {
      console.warn("Semantic Scholar lookup failed:", error);
    }

    try {
      const crossrefResult = await queryCrossref(query, candidate);
      if (crossrefResult) {
        resolved.push(crossrefResult);
        handledIds.add(candidate.id);
        continue;
      }
    } catch (error) {
      console.warn("CrossRef lookup failed:", error);
    }
  }

  const unresolved = scopedCitations.filter((citation) => !handledIds.has(citation.id));

  return { resolved, unresolved };
};


