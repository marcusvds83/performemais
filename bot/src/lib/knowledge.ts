/**
 * Loads the Performe+ knowledge base and exposes
 * a simple keyword-based retrieval (RAG) for the bot.
 */

import knowledgeJson from "./performe-data/knowledge.json";

export type KnowledgeDoc = {
  url: string;
  title: string;
  text: string;
};

const DOCS: KnowledgeDoc[] = (knowledgeJson as KnowledgeDoc[]).filter(
  (d) => d && d.text && !d.title.toLowerCase().includes("page not found")
);

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOPWORDS = new Set([
  "de", "da", "do", "das", "dos", "e", "ou", "para", "por", "com", "a", "o",
  "as", "os", "um", "uma", "uns", "umas", "no", "na", "nos", "nas", "em",
  "que", "se", "sao", "e", "ao", "the", "of", "to", "in", "on", "for",
  "and", "or", "is", "are",
]);

function tokenize(query: string): string[] {
  return normalize(query)
    .split(" ")
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

export function retrieve(query: string, topK = 4): KnowledgeDoc[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return DOCS.slice(0, topK);
  const scored = DOCS.map((doc) => {
    const norm = normalize(doc.text + " " + doc.title);
    let score = 0;
    for (const tok of tokens) {
      let idx = norm.indexOf(tok);
      while (idx !== -1) {
        score += 1;
        idx = norm.indexOf(tok, idx + tok.length);
      }
    }
    const titleNorm = normalize(doc.title);
    for (const tok of tokens) {
      if (titleNorm.includes(tok)) score += 3;
    }
    return { doc, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((s) => s.doc);
}

export function contextForQuery(query: string, maxChars = 6000): string {
  const docs = retrieve(query, 4);
  let out = "";
  for (const d of docs) {
    const block = `## ${d.title}\nURL: ${d.url}\n${d.text.slice(0, 2000)}\n\n`;
    if (out.length + block.length > maxChars) break;
    out += block;
  }
  return out.trim();
}
