/* The documentation the AI is allowed to answer from.

   Not a generic RAG: FRONTPAGE/index.html is already carved into exactly the
   units a retrieval needs. Every node is one <h4 data-node="…"> followed by its
   prose and its spec table, and — this is the gift — every one of those h4
   carries a data-keys attribute holding keywords someone already wrote by hand
   ("otsu threshold between class variance isotopologue…"). So the chunking is
   free, and the only real work is scoring.

   BM25 rather than embeddings, deliberately. An embedding model would be a
   second multi-hundred-megabyte resident next to the coder model on the same
   box, would cost a second of latency per question, and would buy very little
   on a corpus of sixteen technical cards whose own author already listed the
   synonyms we need. Term scoring with a French->English bridge answers "comment
   je détecte mes pics" correctly and instantly.

   And a hard rule: nothing outside these chunks is ever handed to the model.
   If the documentation does not cover it, the AI says so. An assistant that
   invents a parameter that does not exist is worse than one that admits it
   cannot answer. */

const fs = require("fs");
const path = require("path");

/* ---- tunables ------------------------------------------------------------ */

const TOP_K = 3;
/* How much of the question's vocabulary a chunk must cover to count as an
   answer. Coverage, not raw score: a BM25 score means nothing on its own,
   while "the chunk covers half of what you asked" is checkable. */
const MIN_COVERAGE = 0.5;
/* BM25 parameters, the usual defaults for short documents. */
const K1 = 1.5;
const B = 0.75;

/* Weight of the authored fields against the prose. A term the author typed into
   data-keys is a declaration of relevance; the same term buried in a paragraph
   is an accident. */
const WEIGHT_TITLE = 4;
const WEIGHT_NODE = 4;
const WEIGHT_KEYS = 2;
const WEIGHT_MENU = 2;
const WEIGHT_BADGE = 2;
const WEIGHT_TEXT = 1;
/* A node card outranks a prose section that mentions the same word. Small on
   purpose: enough to break a tie, not enough to make an irrelevant card win a
   question the prose section actually answers. */
const NODE_AUTHORITY = 1.25;

/* ---- where the documentation lives --------------------------------------- */

/* The AI files are deployed in the server root next to the site, but from the
   repository they sit in a subfolder. Rather than force one layout, probe the
   plausible ones and let FRONTPAGE_PATH win over all of them. */
function findFrontpage() {
  if (process.env.FRONTPAGE_PATH) {
    return process.env.FRONTPAGE_PATH;
  }
  const candidates = [
    path.join(__dirname, "FRONTPAGE", "index.html"),
    path.join(__dirname, "..", "FRONTPAGE", "index.html"),
    path.join(process.cwd(), "FRONTPAGE", "index.html"),
    path.join(process.cwd(), "..", "FRONTPAGE", "index.html")
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

/* ---- French -> English bridge -------------------------------------------- */

/* The documentation is written in English, the questions arrive in French.
   Without this bridge "comment je trouve mes pics" retrieves nothing at all —
   not a bad ranking, a total miss, because no chunk contains the word "pic".
   Each entry expands one French word into the English terms the cards actually
   use. It is a vocabulary, not a translator: only the domain words, which is
   exactly the set that cannot be guessed. */
const FRENCH_TERMS = {
  pic: ["peak"], pics: ["peak"], Detecter: ["peak", "picking"], detection: ["peak", "picking"],
  detecte: ["peak", "picking"], Creux: ["valley"], signal: ["signal"], signaux: ["signal"],
  bruit: ["noise"], seuil: ["threshold"], seuils: ["threshold"], resolution: ["resolution"],
  ligne: ["line"], lignes: ["line"], courbe: ["curve"], Courbes: ["curve"], tracer: ["plot", "trace"],
  Tracé: ["plot", "trace"], tracage: ["plot", "trace"], graphique: ["plot", "graph"],
  affichage: ["display", "plot"], afficher: ["display", "plot"], visualisation: ["display", "plot"],
  visualiser: ["display", "plot"], Couleur: ["colour", "color"], couleurs: ["colour", "color"],
  zoom: ["zoom"], deplacer: ["pan"], Couper: ["trim", "crop"], couper: ["trim", "crop"],
  rogner: ["trim", "crop"], debut: ["start"], fin: ["end"], Debut: ["start"], Fin: ["end"],
  Debut: ["start"],
  masse: ["mass"], masses: ["mass"], ponderer: ["weighted"], Atomique: ["atomic"],
  isotope: ["isotope"], isotopes: ["isotope"], isotopique: ["isotope"],
  isotopologue: ["isotopologue"], isotopologues: ["isotopologue"],
  enveloppe: ["envelope"], Charge: ["charge"], charge: ["charge"],
  formule: ["formula"], Formules: ["formula"], formule: ["formula"],
  attribution: ["attribution"], attribuer: ["attribution"],
  calibration: ["calibration"], calibrage: ["calibration"], calibrate: ["calibration"],
  derive: ["drift"], derivee: ["drift"], Residus: ["residual"], residu: ["residual"],
  Erreur: ["error"], erreurs: ["error"], ppm: ["ppm"],
  regression: ["regression", "least", "squares"], droite: ["line"], pente: ["slope"],
  Graphe: ["graph"], graphes: ["graph"], reseau: ["network"], Reseau: ["network"],
  foret: ["forest"], foret: ["forest"], lien: ["link"], liens: ["link"],
  noeud: ["node"], Noeud: ["node"], noeuds: ["node"], Noeuds: ["node"],
  parametre: ["parameter"], parametres: ["parameter"], Parametre: ["parameter"],
  Parametres: ["parameter"], entree: ["input"], entrees: ["input"], sortie: ["output"],
  sorties: ["output"],
  importer: ["import"], importation: ["import"], export: ["export"],
  exporter: ["export"], fichier: ["file"], fichiers: ["file"], Texte: ["text"],
  colonnes: ["column"], separateur: ["separator"], separateur: ["separator"],
  csv: ["csv"], tsv: ["tsv"],
  moyenne: ["average"], mediane: ["median"], median: ["median"],
  probabilite: ["probability"], variance: ["variance"],
  grouper: ["cluster", "clustering"], regroupement: ["cluster", "clustering"],
  cluster: ["cluster", "clustering"], clustering: ["cluster", "clustering"],
  molécule: ["molecule"], molecule: ["molecule"], plicature: ["folding"],
  note: ["note"], notes: ["note"], collection: ["collection"], collections: ["collection"],
  parcour: ["browse"], parcourir: ["browse"],
  calcul: ["compute"], Calcul: ["compute"], calculateur: ["calculator"],
  Calculateur: ["calculator"], Multicouche: ["worker"], tache: ["worker"],
  rapide: ["fast"], lent: ["slow"], bloquant: ["blocking"],
  sauvegarde: ["session"], Sessions: ["session"], session: ["session"],
  exporter: ["export"], Restaurer: ["restore"], restaurer: ["restore"],
  conversation: ["chat", "room"], salon: ["room", "chat"], salons: ["room", "chat"],
  discussion: ["chat"], pseudo: ["nick"], connexion: ["connect"],
  reconnexion: ["reconnect"],
  triangle: ["triangle"], planaire: ["plane"], plan: ["plane"], plans: ["plane"],
  vote: ["vote"], votes: ["vote"], voter: ["vote"],
  detection: ["peak", "picking"], pentes: ["slope"], largeur: ["width"],
  hauteur: ["height"], debut: ["start"],
  probleme: ["issue"], installation: ["install"], version: ["version"],
  documentation: ["documentation"], manuel: ["documentation"],
  aide: ["help"]
};

/* ---- tokenisation -------------------------------------------------------- */

/* Both languages, because a question may be in either and the cards are in
   English. Words of one or two letters carry no retrieval signal here, and
   "on", "in", "y", "si", "je" would otherwise match everything. */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "is", "are", "was",
  "were", "be", "it", "its", "this", "that", "these", "those", "with", "by", "at",
  "from", "as", "i", "you", "we", "my", "your", "me", "do", "does", "can", "how",
  "what", "which", "when", "why", "if", "so", "not", "no", "yes", "there", "then",
  "than", "but", "out", "up", "into", "about", "also", "more", "most", "any",
  "le", "la", "les", "de", "des", "du", "un", "une", "et", "ou", "a", "au",
  "aux", "en", "dans", "sur", "pour", "par", "avec", "sans", "est", "sont", "etait",
  "je", "tu", "il", "elle", "nous", "vous", "ils", "elles", "ce", "cet", "cette",
  "ces", "mon", "ma", "mes", "ton", "ta", "tes", "son", "sa", "ses", "notre",
  "vos", "leur", "qui", "que", "quoi", "dont", "ou", "comment", "pourquoi", "quand",
  "estce", "ca", "cela", "ceci", "on", "je", "y", "en", "si", "ne", "pas", "plus",
  "mais", "donc", "car", "aussi", "bien", "tout", "tous", "toute", "tres", "peu",
  "peut", "peux", "faire", "faut", "veut", "savoir", "utiliser", "utilise",
  "utilises", "utilisee", "fonctionne", "fonctionnement", "possible", "peuvent",
  /* Possessives carry no retrieval signal and would each cost a chunk one
     unit of coverage out of three. */
  "mon", "ma", "mes", "ton", "ta", "tes", "son", "sa", "ses", "notre", "nos",
  "votre", "vos", "leur", "leurs", "avec", "pour", "faire", "cette", "meme"
]);

const ENTITIES = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'",
  "&nbsp;": " ", "&times;": "x", "&mdash;": "-", "&ndash;": "-", "&hellip;": "...",
  "&rsquo;": "'", "&lsquo;": "'", "&ldquo;": '"', "&rdquo;": '"', "&eacute;": "e",
  "&egrave;": "e", "&agrave;": "a", "&ccedil;": "c", "&ugrave;": "u", "&icirc;": "i",
  "&agrave;": "a", "&ecirc;": "e", "&ocirc;": "o", "&ucirc;": "u", "&acirc;": "a",
  "&icirc;": "i", "&oelig;": "oe", "&oelig;": "oe", "&amp;nbsp;": " "
};

/* Un-accent rather than delete: "detecte" and "detection" both reduce to
   "detecte", which is what lets an unaccented query reach an accented card. */
function fold(text) {
  return String(text)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function decodeEntities(text) {
  return String(text).replace(/&[#a-zA-Z0-9]+;/g, (entity) =>
    ENTITIES[entity.toLowerCase()] !== undefined ? ENTITIES[entity.toLowerCase()] : entity
  );
}

/* camelCase is split as well as kept whole: the node identifiers are camelCase,
   so "peakPicking" must be reachable by "picking" and by "peak". */
function tokenize(text) {
  const source = fold(decodeEntities(String(text))).toLowerCase();
  const tokens = [];
  for (const word of source.split(/[^a-z0-9+#-]+/)) {
    if (!word) continue;
    const parts = word.split(/(?<=[a-z])(?=[A-Z])/);
    for (const part of [word, ...parts]) {
      const token = part.replace(/^-+|-+$/g, "");
      if (token.length < 2) continue;
      if (STOPWORDS.has(token)) continue;
      tokens.push(token);
    }
  }
  return tokens;
}

/* A concept is one word of the question and every English form it might be
   written under in the documentation. Coverage is counted per concept, not per
   token: a French question has tokens that appear in NO English card, and
   scoring them as misses would make every French question fail — "detecte"
   would never be found, so a correct answer to "comment je detecte mes pics"
   scored zero.

   Grouping them is what lets the check stay honest in both directions: a
   concept counts as covered only when a chunk really contains one of its
   English forms, and a question the documentation says nothing about still
   leaves most of its concepts uncovered. */
function queryConcepts(question) {
  const tokens = tokenize(question);
  const concepts = [];
  const byToken = new Map();
  for (const token of tokens) {
    if (byToken.has(token)) continue;
    const concept = { tokens: [token], translations: [] };
    byToken.set(token, concept);
    concepts.push(concept);
  }
  for (const concept of concepts) {
    concept.translations = FRENCH_TERMS[concept.tokens[0]] || [];
  }
  return concepts;
}

/* Every token a concept can be found under, expanded once. */
function conceptTerms(concept) {
  const all = [...concept.tokens];
  for (const translation of concept.translations) {
    all.push(...tokenize(translation));
  }
  return [...new Set(all)];
}

/* ---- HTML -> chunks ------------------------------------------------------- */

function stripScriptsAndComments(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
}

/* Spec tables carry the actual parameter lists, so they are worth keeping —
   but flattened into "Item: value" lines, because a table dumped as raw text
   loses which cell was the label and which was the content. */
function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, " | ")
      .replace(/<\/tr>/gi, "\n")
      .replace(/<\/t[dh]>/gi, ": ")
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/li>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

/* Section headings are decorated with emoji in the frontpage ("🕸️ Hough
   pattern detection"). They are decoration for a human reader; in a chat
   window they are noise, and one of them ends up in front of the node name in
   every cited source. */
function stripEmoji(text) {
  return String(text)
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}]/gu, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"));
  return match ? match[1] : "";
}

/* A heading of any level opens a chunk, and the chunk runs until the next
   heading. Level 4 is where the node cards live; the level 2 and 3 headings
   give the prose sections — what Attributor is, how a pipeline is put
   together, the global conventions. Together they cover the whole page, which
   is what the AI is allowed to know. */
function parseChunks(html) {
  const source = stripScriptsAndComments(html);
  const chunks = [];

  // <h2 id>..</h2>, <h3>..</h3>, <h4 data-node>..</h4>
  const headingPattern = /<h([1-4])\b([^>]*)>([\s\S]*?)<\/h\1>/gi;
  const headings = [];
  let match;
  while ((match = headingPattern.exec(source)) !== null) {
    headings.push({
      level: Number(match[1]),
      attrs: match[2],
      innerHtml: match[3],
      start: match.index,
      end: match.index + match[0].length
    });
  }

  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const next = headings[i + 1];
    const bodyHtml = source.slice(heading.end, next ? next.start : source.length);

    const inner = htmlToText(heading.innerHtml);
    const badges = (heading.innerHtml.match(/class\s*=\s*"badge[^"]*"/gi) || []).length;
    const menu = attribute(heading.attrs, "data-menu");
    const node = attribute(heading.attrs, "data-node");
    const keys = attribute(heading.attrs, "data-keys");
    /* The heading text still carries the badges, which read as "H0", "Otsu",
       "no .NET" — exactly the kind of detail worth surfacing. */
    const title = stripEmoji(
      inner
        .split(/\s+/)
        .filter((word) => word && !/^(h0|h1|otsu|kendrick|import|native|tools|display|warn|no|\.net)$/i.test(word))
        .join(" ")
        .trim() || inner
    );

    const text = htmlToText(bodyHtml);
    if (!text && !keys && !node) {
      continue;
    }

    chunks.push({
      id: node ? `node-${node}` : `section-${i}`,
      title,
      level: heading.level,
      node: node || null,
      menu: menu || null,
      keys,
      badgeCount: badges,
      text,
      /* The frontpage gives every node card the id "node-<name>", so a cited
         card is a link the user can click through to. */
      anchor: node ? `#node-${node}` : null
    });
  }

  return chunks;
}

/* ---- BM25 ---------------------------------------------------------------- */

class Index {
  constructor(chunks) {
    this.chunks = chunks;
    this.postings = new Map();  // term -> Map(chunkIndex -> weighted frequency)
    this.lengths = [];
    this.averageLength = 0;

    chunks.forEach((chunk, i) => {
      const terms = this.chunkTerms(chunk);
      this.lengths[i] = terms.length;
      const frequencies = new Map();
      for (const term of terms) {
        frequencies.set(term, (frequencies.get(term) || 0) + 1);
      }
      for (const [term, count] of frequencies) {
        if (!this.postings.has(term)) {
          this.postings.set(term, new Map());
        }
        this.postings.get(term).set(i, count);
      }
    });

    this.averageLength = this.lengths.length
      ? this.lengths.reduce((sum, length) => sum + length, 0) / this.lengths.length
      : 0;
  }

  /* The authored fields are repeated rather than weighted at query time: term
     frequency already saturates, so repeating a title four times is the same
     thing as weighting it four, and it keeps the scoring textbook-simple. */
  chunkTerms(chunk) {
    const repeat = (text, times) => {
      const tokens = tokenize(text);
      const out = [];
      for (let i = 0; i < times; i++) {
        out.push(...tokens);
      }
      return out;
    };
    return [
      ...repeat(chunk.title, WEIGHT_TITLE),
      ...repeat(chunk.node, WEIGHT_NODE),
      ...repeat(chunk.keys, WEIGHT_KEYS),
      ...repeat(chunk.menu, WEIGHT_MENU),
      ...repeat(chunk.badgeCount ? "badge" : "", WEIGHT_BADGE),
      ...repeat(chunk.text, WEIGHT_TEXT)
    ];
  }

  idf(term) {
    const posting = this.postings.get(term);
    const n = posting ? posting.size : 0;
    const total = this.chunks.length;
    if (!n) return 0;
    return Math.log(1 + (total - n + 0.5) / (n + 0.5));
  }

  /* Rank the chunks against a question. Returns null when nothing in the
     documentation covers it — the caller must treat that as "say you do not
     know", never as "answer from what you remember". */
  search(question, limit = TOP_K) {
    if (!this.chunks.length) {
      return null;
    }
    const concepts = queryConcepts(question);
    if (!concepts.length) {
      return null;
    }
    const expanded = concepts.map(conceptTerms);

    const total = this.chunks.length;
    const scores = new Float64Array(total);
    /* For each chunk, which of the concepts it answers. A concept is covered
       when ANY of its forms is present — that is the whole point of grouping. */
    const covered = Array.from({ length: total }, () => new Uint8Array(concepts.length));

    expanded.forEach((terms, conceptIndex) => {
      for (const term of terms) {
        const posting = this.postings.get(term);
        if (!posting) continue;
        const idf = this.idf(term);
        for (const [i, frequency] of posting) {
          const length = this.lengths[i] || 1;
          const denominator = frequency + K1 * (1 - B + B * (length / (this.averageLength || 1)));
          scores[i] += idf * (frequency * (K1 + 1)) / (denominator || 1);
          covered[i][conceptIndex] = 1;
        }
      }
    });

    const ranked = [];
    for (let i = 0; i < total; i++) {
      if (scores[i] <= 0) continue;
      const hits = covered[i].reduce((sum, flag) => sum + flag, 0);
      const coverage = hits / concepts.length;
      /* A node card is the authoritative reference for its subject; a prose
         section that merely mentions the same word is a worse answer. This is
         what makes "kendrick" land on the F-KMD card rather than on the
         features list that happens to mention it. */
      const authority = this.chunks[i].node ? NODE_AUTHORITY : 1;
      ranked.push({
        chunk: this.chunks[i],
        score: scores[i] * authority,
        coverage
      });
    }

    if (!ranked.length) {
      return null;
    }
    /* Coverage first: a chunk that answers two thirds of the question beats
       one that repeats a rare word five times. */
    ranked.sort((a, b) => (b.coverage - a.coverage) || (b.score - a.score));

    const best = ranked.slice(0, limit);
    if (best[0].coverage < MIN_COVERAGE) {
      /* Below the bar the documentation has no real answer to give. */
      return null;
    }
    return best;
  }
}

/* ---- the module ---------------------------------------------------------- */

let cache = null;

function build() {
  const file = findFrontpage();
  if (!file) {
    console.warn("[Docs] FRONTPAGE/index.html not found — the AI will only say it does not know.");
    return null;
  }
  let html;
  try {
    html = fs.readFileSync(file, "utf8");
  } catch (error) {
    console.warn(`[Docs] Cannot read ${file}: ${error.message}`);
    return null;
  }
  const chunks = parseChunks(html);
  const nodes = chunks.filter((chunk) => chunk.node).length;
  console.log(`[Docs] Indexed ${chunks.length} sections (${nodes} nodes) from ${file}`);
  return { file, mtimeMs: safeMtime(file), index: new Index(chunks) };
}

function safeMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/* Rebuilt on demand rather than watched: a stat per question is free, and a
   documentation page edited on the server is picked up without a restart. */
function get() {
  const file = findFrontpage();
  if (!file) {
    return null;
  }
  if (cache && cache.file === file && cache.mtimeMs === safeMtime(file)) {
    return cache;
  }
  cache = build();
  return cache;
}

/* What the model is shown for one question: a bounded excerpt of the cards
   that matched, with the field names preserved because those are what the user
   will type into the node. */
function toContext(results, question) {
  if (!results) {
    return null;
  }
  const parts = results.map(({ chunk, coverage }) => {
    const header = [
      chunk.node ? `Node "${chunk.node}" (menu: ${chunk.menu})` : `Section "${chunk.title}"`,
      `FRONTPAGE anchor: ${chunk.anchor || "#"}`,
      `matched ${Math.round(coverage * 100)}% of the question`
    ].join(" — ");
    const body = chunk.text.length > 2600 ? `${chunk.text.slice(0, 2600)}…` : chunk.text;
    return `${header}\n${body}`;
  });

  return [
    `Documentation Attributor — excerpts retrieved for the question "${question}".`,
    "This is the ONLY source you may use. It is written in English; answer in the",
    "language the question was asked in, keeping node identifiers, parameter names",
    "and menu names in their original form.",
    "Do not invent a parameter, a node or a feature that is not written below. If the",
    "excerpts do not contain the answer, say plainly that Attributor's documentation",
    "does not cover it, and suggest what the user could look at instead.",
    "",
    ...parts
  ].join("\n");
}

module.exports = {
  search(question) {
    const store = get();
    if (!store) return null;
    return store.index.search(question);
  },
  context: toContext,
  describe() {
    const store = get();
    return store ? { file: store.file, chunks: store.index.chunks.length } : null;
  },
  _internals: { parseChunks, Index, tokenize, queryConcepts, build }
};
