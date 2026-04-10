/**
 * seed-database.ts
 *
 * Ingestion pipeline: NIAHO Standards PDF → text chunks → Voyage AI embeddings → MongoDB Atlas
 *
 * Run with: npm run seed
 */

import * as fs from "fs";
import * as path from "path";
import { MongoClient } from "mongodb";
import pdfParse from "pdf-parse";
import dotenv from "dotenv";

dotenv.config();

// ─── Config ────────────────────────────────────────────────────────────────────

const MONGODB_URI = process.env.MONGODB_URI!;
const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY!;
const DB_NAME = "niaho_standards";
const COLLECTION_NAME = "standards";
const VOYAGE_MODEL = "voyage-3-large";
const EMBEDDING_DIMENSIONS = 1024;

// Approximate max tokens per chunk (Voyage AI context window is 32k, keeping chunks manageable)
const MAX_CHUNK_TOKENS = 800;

// ─── Types ─────────────────────────────────────────────────────────────────────

interface StandardDocument {
  chunk_id: string;
  text: string;
  metadata: {
    document: string;
    section: string;
    chapter: string;
  };
  embedding: number[];
  token_count: number;
}

interface VoyageEmbeddingResponse {
  data: Array<{ embedding: number[] }>;
  usage: { total_tokens: number };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Rough token estimator (1 token ≈ 4 characters for English text)
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Generate embeddings using Voyage AI API
 * Batches requests to avoid rate limits
 */
async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const response = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: texts,
      model: VOYAGE_MODEL,
      input_type: "document",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Voyage AI API error ${response.status}: ${errorText}`
    );
  }

  const result = (await response.json()) as VoyageEmbeddingResponse;
  console.log(`  ✓ Used ${result.usage.total_tokens} tokens for this batch`);
  return result.data.map((d) => d.embedding);
}

/**
 * Map section codes to human-readable section names
 */
function getSectionName(chapterCode: string): string {
  const sectionMap: Record<string, string> = {
    QM: "Quality Management",
    LS: "Life Safety",
    IC: "Infection Control",
    PE: "Patient Experience",
    MM: "Medication Management",
    NR: "Nursing",
    SR: "Surgical Requirements",
    AP: "Anesthesia and Pain Management",
    RC: "Records and Communications",
    HR: "Human Resources",
    EC: "Environment of Care",
    PI: "Performance Improvement",
    RI: "Rights and Responsibilities",
    TX: "Treatment",
    SC: "Staffing and Competency",
    LD: "Leadership",
    PC: "Patient Care",
    MS: "Medical Staff",
  };

  const prefix = chapterCode.split(".")[0].toUpperCase();
  return sectionMap[prefix] ?? `Section ${prefix}`;
}

/**
 * Parse the NIAHO PDF and split into logical chunks by chapter/section.
 *
 * Strategy:
 * 1. Extract full text from PDF
 * 2. Split on chapter header patterns like "QM.1", "LS.2.3", etc.
 * 3. Further split overly large chunks by paragraph
 */
async function extractChunks(
  pdfPath: string
): Promise<Array<{ text: string; chapter: string; section: string }>> {
  console.log(`📄 Reading PDF: ${pdfPath}`);

  const pdfBuffer = fs.readFileSync(pdfPath);
  const pdfData = await pdfParse(pdfBuffer);
  const rawText = pdfData.text;

  console.log(
    `  ✓ Extracted ${rawText.length} characters, ~${estimateTokens(rawText)} tokens`
  );

  // Regex to detect NIAHO chapter headers like: QM.1, LS.2, IC.3.1, MM.2.3.4
  // Matches patterns at the start of a line or after whitespace
  const chapterHeaderRegex =
    /(?:^|\n)(([A-Z]{2,4})\.(\d+(?:\.\d+)*))\s*[\-–—]?\s*(.{0,120})/gm;

  const segments: Array<{
    chapter: string;
    section: string;
    startIndex: number;
    headerLine: string;
  }> = [];

  let match: RegExpExecArray | null;
  while ((match = chapterHeaderRegex.exec(rawText)) !== null) {
    const chapterCode = match[1]; // e.g., "QM.1"
    const sectionPrefix = match[2]; // e.g., "QM"
    const startIndex = match.index;
    const headerLine = match[0].trim();

    segments.push({
      chapter: chapterCode,
      section: getSectionName(sectionPrefix),
      startIndex,
      headerLine,
    });
  }

  console.log(`  ✓ Found ${segments.length} chapter segments`);

  if (segments.length === 0) {
    // Fallback: split by double-newlines if no chapter headers found
    console.warn(
      "  ⚠ No chapter headers detected. Falling back to paragraph splitting."
    );
    const paragraphs = rawText
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter((p) => p.length > 100);

    return paragraphs.map((text, i) => ({
      text,
      chapter: `PARA_${String(i + 1).padStart(3, "0")}`,
      section: "General",
    }));
  }

  // Build chunks from segment boundaries
  const chunks: Array<{ text: string; chapter: string; section: string }> = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const nextSeg = segments[i + 1];

    const chunkText = rawText
      .slice(seg.startIndex, nextSeg?.startIndex ?? rawText.length)
      .trim();

    if (!chunkText || chunkText.length < 50) continue;

    // If the chunk is too large, sub-split by paragraphs
    if (estimateTokens(chunkText) > MAX_CHUNK_TOKENS) {
      const subParagraphs = chunkText
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter((p) => p.length > 50);

      subParagraphs.forEach((subText, subIdx) => {
        chunks.push({
          text: subText,
          chapter: `${seg.chapter}.${subIdx + 1}`,
          section: seg.section,
        });
      });
    } else {
      chunks.push({
        text: chunkText,
        chapter: seg.chapter,
        section: seg.section,
      });
    }
  }

  console.log(`  ✓ Created ${chunks.length} final chunks`);
  return chunks;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Validate environment
  if (!MONGODB_URI) throw new Error("MONGODB_URI is not set in .env");
  if (!VOYAGE_API_KEY) throw new Error("VOYAGE_API_KEY is not set in .env");

  // Find PDF file
  const pdfCandidates = [
    path.join(__dirname, "niaho-standards.pdf"),
    path.join(__dirname, "NIAHO_Standards.pdf"),
    path.join(__dirname, "data", "niaho-standards.pdf"),
  ];

  const pdfPath = pdfCandidates.find((p) => fs.existsSync(p));
  if (!pdfPath) {
    throw new Error(
      `NIAHO Standards PDF not found. Place it at one of these paths:\n${pdfCandidates.join("\n")}`
    );
  }

  // Connect to MongoDB
  console.log("\n🔌 Connecting to MongoDB Atlas...");
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  const collection = db.collection<StandardDocument>(COLLECTION_NAME);

  // Clear existing documents (re-seed from scratch)
  const existingCount = await collection.countDocuments();
  if (existingCount > 0) {
    console.log(`  ⚠ Found ${existingCount} existing documents — clearing collection for fresh seed`);
    await collection.deleteMany({});
  }

  try {
    // Extract chunks from PDF
    console.log("\n📚 Extracting text chunks from PDF...");
    const chunks = await extractChunks(pdfPath);

    // Process in batches to respect Voyage AI rate limits
    const BATCH_SIZE = 10;
    const documents: StandardDocument[] = [];

    console.log(
      `\n🧠 Generating embeddings with Voyage AI (${VOYAGE_MODEL})...`
    );
    console.log(
      `  Processing ${chunks.length} chunks in batches of ${BATCH_SIZE}`
    );

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const batchTexts = batch.map((c) => c.text);

      console.log(
        `  Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(chunks.length / BATCH_SIZE)}...`
      );

      // Generate embeddings for this batch
      const embeddings = await generateEmbeddings(batchTexts);

      // Build MongoDB documents
      batch.forEach((chunk, j) => {
        const chunkIndex = i + j + 1;
        documents.push({
          chunk_id: `${chunk.chapter.replace(/\./g, "_")}_${String(chunkIndex).padStart(3, "0")}`,
          text: chunk.text,
          metadata: {
            document: "NIAHO Standards",
            section: chunk.section,
            chapter: chunk.chapter,
          },
          embedding: embeddings[j],
          token_count: estimateTokens(chunk.text),
        });
      });

      // Small delay between batches to be respectful of rate limits
      if (i + BATCH_SIZE < chunks.length) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    // Validate embedding dimensions
    const sampleEmbedding = documents[0]?.embedding;
    if (sampleEmbedding && sampleEmbedding.length !== EMBEDDING_DIMENSIONS) {
      console.warn(
        `  ⚠ Unexpected embedding dimension: ${sampleEmbedding.length} (expected ${EMBEDDING_DIMENSIONS})`
      );
    }

    // Insert all documents into MongoDB
    console.log(`\n💾 Inserting ${documents.length} documents into MongoDB...`);
    const result = await collection.insertMany(documents);
    console.log(`  ✓ Inserted ${result.insertedCount} documents`);

    // Print summary statistics
    console.log("\n📊 Seeding Summary:");
    console.log(`  Database:   ${DB_NAME}`);
    console.log(`  Collection: ${COLLECTION_NAME}`);
    console.log(`  Documents:  ${documents.length}`);
    console.log(
      `  Avg tokens: ${Math.round(documents.reduce((s, d) => s + d.token_count, 0) / documents.length)}`
    );
    console.log(`  Embedding:  ${VOYAGE_MODEL} (${EMBEDDING_DIMENSIONS}-dim)`);

    const uniqueSections = [...new Set(documents.map((d) => d.metadata.section))];
    console.log(`\n  Sections (${uniqueSections.length}):`);
    uniqueSections.forEach((s) => {
      const count = documents.filter((d) => d.metadata.section === s).length;
      console.log(`    • ${s}: ${count} chunks`);
    });

    console.log("\n✅ Database seeding complete!");
    console.log(
      "\n⚡ Next step: Create the Atlas Vector Search index in the MongoDB UI."
    );
    console.log("   Use this index definition:");
    console.log(
      JSON.stringify(
        {
          fields: [
            {
              type: "vector",
              path: "embedding",
              numDimensions: EMBEDDING_DIMENSIONS,
              similarity: "cosine",
            },
            {
              type: "filter",
              path: "metadata.chapter",
            },
          ],
        },
        null,
        2
      )
    );
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("❌ Seeding failed:", err.message);
  process.exit(1);
});
