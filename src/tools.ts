/**
 * src/tools.ts
 *
 * Tool implementations for the Healthcare Standards Agent.
 * Each function maps to a tool the LLM can call.
 *
 * Tools:
 *  - search_standards       → semantic vector search via $vectorSearch
 *  - get_standard_by_chapter → exact lookup by chapter ID
 *  - list_sections           → discover available chapters/sections
 */

import { MongoClient, Db } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

// ─── Config ────────────────────────────────────────────────────────────────────

const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY!;
const MONGODB_URI = process.env.MONGODB_URI!;
const DB_NAME = "niaho_standards";
const COLLECTION_NAME = "standards";
const VECTOR_INDEX_NAME = "vector_index"; // Must match the index name in Atlas UI
const VOYAGE_MODEL = "voyage-3-large";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface SearchResult {
  chunk_id: string;
  text: string;
  metadata: {
    document: string;
    section: string;
    chapter: string;
  };
  score: number;
  token_count: number;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

// ─── MongoDB Singleton ─────────────────────────────────────────────────────────

let mongoClient: MongoClient | null = null;
let db: Db | null = null;

export async function getDb(): Promise<Db> {
  if (!mongoClient || !db) {
    if (!MONGODB_URI) throw new Error("MONGODB_URI is not set in .env");
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    db = mongoClient.db(DB_NAME);
    console.log("  🔌 Connected to MongoDB Atlas");
  }
  return db;
}

export async function closeDb(): Promise<void> {
  if (mongoClient) {
    await mongoClient.close();
    mongoClient = null;
    db = null;
  }
}

// ─── Voyage AI Embedding ───────────────────────────────────────────────────────

/**
 * Generate a query embedding using Voyage AI.
 * Uses input_type: "query" for retrieval (vs "document" used at index time).
 * This asymmetric usage improves retrieval quality.
 */
export async function generateQueryEmbedding(query: string): Promise<number[]> {
  if (!VOYAGE_API_KEY) throw new Error("VOYAGE_API_KEY is not set in .env");

  const response = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: [query],
      model: VOYAGE_MODEL,
      input_type: "query", // "query" for retrieval, "document" for indexing
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Voyage AI API error ${response.status}: ${errorText}`);
  }

  const result = (await response.json()) as {
    data: Array<{ embedding: number[] }>;
  };
  return result.data[0].embedding;
}

// ─── Tool: search_standards ───────────────────────────────────────────────────

/**
 * Performs semantic vector search across all NIAHO standards.
 *
 * Flow:
 *  1. Embed the natural-language query using Voyage AI
 *  2. Run $vectorSearch aggregation against MongoDB Atlas
 *  3. Return top-k results with relevance scores
 */
export async function searchStandards(
  query: string,
  topK: number = 5
): Promise<ToolResult> {
  try {
    console.log(`  🔍 search_standards("${query}", top_k=${topK})`);

    const database = await getDb();
    const collection = database.collection(COLLECTION_NAME);

    // Step 1: Generate embedding for the query
    console.log("  🧠 Generating query embedding via Voyage AI...");
    const queryEmbedding = await generateQueryEmbedding(query);

    // Step 2: Run $vectorSearch aggregation
    const pipeline = [
      {
        $vectorSearch: {
          index: VECTOR_INDEX_NAME,
          path: "embedding",
          queryVector: queryEmbedding,
          numCandidates: topK * 10, // Broader candidate pool for better accuracy
          limit: topK,
        },
      },
      {
        $project: {
          _id: 0,
          chunk_id: 1,
          text: 1,
          metadata: 1,
          token_count: 1,
          score: { $meta: "vectorSearchScore" },
        },
      },
    ];

    const results = await collection
      .aggregate<SearchResult>(pipeline)
      .toArray();

    if (results.length === 0) {
      return {
        success: true,
        data: {
          message: "No relevant standards found for this query.",
          results: [],
        },
      };
    }

    console.log(`  ✓ Found ${results.length} results`);

    return {
      success: true,
      data: {
        query,
        total_results: results.length,
        results: results.map((r) => ({
          chapter: r.metadata.chapter,
          section: r.metadata.section,
          relevance_score: r.score.toFixed(4),
          text: r.text,
          chunk_id: r.chunk_id,
        })),
      },
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`  ❌ search_standards error: ${msg}`);
    return { success: false, error: msg };
  }
}

// ─── Tool: get_standard_by_chapter ────────────────────────────────────────────

/**
 * Exact lookup by chapter identifier (e.g., "QM.1", "IC.3").
 *
 * First attempts exact match on metadata.chapter.
 * If not found, falls back to prefix search (e.g., "QM" returns all QM.* chapters).
 * If still not found, falls back to semantic search.
 */
export async function getStandardByChapter(
  chapterId: string
): Promise<ToolResult> {
  try {
    // Normalize input: trim whitespace, uppercase prefix
    const normalized = chapterId.trim();
    console.log(`  📖 get_standard_by_chapter("${normalized}")`);

    const database = await getDb();
    const collection = database.collection(COLLECTION_NAME);

    // Attempt 1: Exact match
    const exactResults = await collection
      .find(
        { "metadata.chapter": normalized },
        {
          projection: { _id: 0, chunk_id: 1, text: 1, metadata: 1, token_count: 1 },
        }
      )
      .toArray();

    if (exactResults.length > 0) {
      console.log(`  ✓ Exact match found (${exactResults.length} chunk(s))`);
      return {
        success: true,
        data: {
          lookup_type: "exact",
          chapter_id: normalized,
          results: exactResults,
        },
      };
    }

    // Attempt 2: Prefix match — e.g., "QM" returns QM.1, QM.2, etc.
    // Also handles sub-chapter lookups like "QM.1" returning QM.1.1, QM.1.2
    const prefixRegex = new RegExp(`^${normalized.replace(".", "\\.")}`, "i");
    const prefixResults = await collection
      .find(
        { "metadata.chapter": { $regex: prefixRegex } },
        {
          projection: { _id: 0, chunk_id: 1, text: 1, metadata: 1, token_count: 1 },
        }
      )
      .sort({ "metadata.chapter": 1 })
      .toArray();

    if (prefixResults.length > 0) {
      console.log(
        `  ✓ Prefix match found (${prefixResults.length} chunk(s)) for "${normalized}"`
      );
      return {
        success: true,
        data: {
          lookup_type: "prefix",
          chapter_id: normalized,
          message: `Exact chapter "${normalized}" not found. Showing all chapters starting with "${normalized}":`,
          results: prefixResults,
        },
      };
    }

    // Attempt 3: Semantic fallback
    console.log(
      `  ⚠ Chapter "${normalized}" not found. Falling back to semantic search...`
    );
    const semanticResult = await searchStandards(
      `${normalized} healthcare standards`,
      3
    );

    return {
      success: true,
      data: {
        lookup_type: "semantic_fallback",
        chapter_id: normalized,
        message: `Chapter "${normalized}" was not found in the knowledge base. Here are semantically related standards:`,
        ...(semanticResult.data as object),
      },
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`  ❌ get_standard_by_chapter error: ${msg}`);
    return { success: false, error: msg };
  }
}

// ─── Tool: list_sections ──────────────────────────────────────────────────────

/**
 * Lists all available sections and chapters in the knowledge base.
 * Optional section_filter narrows results to a specific section prefix (e.g., "QM", "IC").
 */
export async function listSections(
  sectionFilter?: string
): Promise<ToolResult> {
  try {
    console.log(
      `  📋 list_sections(${sectionFilter ? `"${sectionFilter}"` : "all"})`
    );

    const database = await getDb();
    const collection = database.collection(COLLECTION_NAME);

    // Build the match stage
    const matchStage = sectionFilter
      ? {
          $match: {
            $or: [
              { "metadata.section": { $regex: sectionFilter, $options: "i" } },
              {
                "metadata.chapter": {
                  $regex: `^${sectionFilter}`,
                  $options: "i",
                },
              },
            ],
          },
        }
      : { $match: {} };

    // Aggregate unique chapters grouped by section
    const pipeline = [
      matchStage,
      {
        $group: {
          _id: {
            section: "$metadata.section",
            chapter: "$metadata.chapter",
          },
          chunk_count: { $sum: 1 },
        },
      },
      {
        $sort: {
          "_id.section": 1,
          "_id.chapter": 1,
        },
      },
      {
        $group: {
          _id: "$_id.section",
          chapters: {
            $push: {
              chapter_id: "$_id.chapter",
              chunk_count: "$chunk_count",
            },
          },
        },
      },
      { $sort: { _id: 1 } },
    ];

    const sectionGroups = await collection.aggregate(pipeline).toArray();

    if (sectionGroups.length === 0) {
      return {
        success: true,
        data: {
          message: sectionFilter
            ? `No sections found matching "${sectionFilter}"`
            : "No sections found in the knowledge base.",
          sections: [],
        },
      };
    }

    const totalChapters = sectionGroups.reduce(
      (sum, s) => sum + s.chapters.length,
      0
    );

    console.log(
      `  ✓ Found ${sectionGroups.length} section(s), ${totalChapters} chapter(s)`
    );

    return {
      success: true,
      data: {
        filter: sectionFilter ?? "none",
        total_sections: sectionGroups.length,
        total_chapters: totalChapters,
        sections: sectionGroups.map((s) => ({
          section_name: s._id,
          chapters: s.chapters,
        })),
      },
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`  ❌ list_sections error: ${msg}`);
    return { success: false, error: msg };
  }
}
