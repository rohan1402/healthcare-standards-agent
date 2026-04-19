# Healthcare Standards Agent

An **agentic RAG (Retrieval-Augmented Generation)** system that answers natural-language queries about NIAHO healthcare accreditation standards using **MongoDB Atlas Vector Search**, **Voyage AI embeddings**, and **Anthropic Claude**.

---

## Architecture

```
User Query
    │
    ▼
┌─────────────────────┐
│   src/agent.ts      │  ← CLI chat loop + agent orchestration (Claude)
│   Agent Loop        │
│  (prompt → tool →   │
│   result → answer)  │
└─────────┬───────────┘
          │ tool calls
          ▼
┌─────────────────────┐
│   src/tools.ts      │  ← Tool implementations
│                     │
│  search_standards   │──→ Voyage AI (embed query) ──→ MongoDB $vectorSearch
│  get_by_chapter     │──→ MongoDB exact/prefix match
│  list_sections      │──→ MongoDB aggregation
└─────────────────────┘
          │
          ▼
┌─────────────────────┐
│  MongoDB Atlas M0   │  ← Vector database
│  niaho_standards    │     1024-dim cosine index
│  .standards         │     (Voyage AI voyage-3-large)
└─────────────────────┘
```

### How It Works

1. **Data Layer (seed-database.ts):** The NIAHO standards PDF is parsed, split into chapter-level chunks, embedded using Voyage AI (`voyage-3-large`, 1024 dimensions), and stored in MongoDB Atlas.

2. **Vector Search Index:** An Atlas Vector Search index enables `$vectorSearch` aggregation — finding semantically similar chunks even when the exact words don't match.

3. **Agent Loop (src/agent.ts):** User input is sent to Claude. Claude decides which tool to call based on the system prompt rules. Tool results are fed back to Claude, which synthesizes a final answer.

4. **Dual-Mode Queries:**
   - **Q&A Mode** → `search_standards` → semantic vector search → synthesized answer
   - **Citation Mode** → `get_standard_by_chapter` → exact text lookup → verbatim return

---

## Prerequisites

- Node.js 18+
- MongoDB Atlas free-tier (M0) account
- Voyage AI API key (free — from Atlas UI → AI Models)
- Anthropic API key

---

## Setup

### 1. Clone & Install

```bash
git clone https://github.com/rohan1402/healthcare-standards-agent.git
cd healthcare-standards-agent
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
MONGODB_URI=mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/?retryWrites=true&w=majority
VOYAGE_API_KEY=pa-xxxxxxxxxxxxxxxx
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxx
TOP_K=5
```

### 3. MongoDB Atlas Setup

1. Create a free **M0 cluster** at [cloud.mongodb.com](https://cloud.mongodb.com)
2. Create database `niaho_standards` with collection `standards`
3. Allow network access (your IP or `0.0.0.0/0` for dev)
4. Create a database user with read/write permissions
5. Copy the connection string to `MONGODB_URI` in `.env`

### 4. Voyage AI API Key

1. In your Atlas project → **AI Models** (left nav)
2. Click **Create model API key** → copy it
3. Set it as `VOYAGE_API_KEY` in `.env`

### 5. Seed the Database

Place the NIAHO standards PDF in the project root as `niaho-standards.pdf`, then run:

```bash
npm run seed
```

This will:
- Parse the PDF and extract chapter-level chunks
- Generate 1024-dim embeddings via Voyage AI
- Insert all documents into MongoDB Atlas

### 6. Create the Vector Search Index

After seeding, create the Atlas Vector Search index in the MongoDB UI:

1. Go to your cluster → **Atlas Search** → **Create Search Index**
2. Select **Atlas Vector Search**, choose the `standards` collection
3. Use this index definition (name it `vector_index`):

```json
{
  "fields": [
    {
      "type": "vector",
      "path": "embedding",
      "numDimensions": 1024,
      "similarity": "cosine"
    },
    {
      "type": "filter",
      "path": "metadata.chapter"
    }
  ]
}
```

### 7. Run the Agent

```bash
npm run agent
```

```
╔══════════════════════════════════════════════════════╗
║        Healthcare Standards Agent (NIAHO)            ║
║    Powered by Claude + MongoDB Atlas Vector Search   ║
╚══════════════════════════════════════════════════════╝

You: What are the infection control requirements?
Agent: [searches standards → synthesizes answer with citations]

You: Show me chapter QM.1
Agent: [exact lookup → returns verbatim text]
```

---

## Project Structure

```
healthcare-standards-agent/
├── src/
│   ├── agent.ts          # Agent loop, tool definitions, system prompt, CLI
│   └── tools.ts          # Tool implementations (MongoDB + Voyage AI)
├── seed-database.ts      # PDF ingestion pipeline
├── package.json
├── tsconfig.json
├── .env.example
├── README.md
└── TEST_RESULTS.md       # All 13+ test queries with outputs
```

---

## Document Schema (MongoDB)

```json
{
  "chunk_id": "QM_1_001",
  "text": "Full verbatim text of the chapter chunk...",
  "metadata": {
    "document": "NIAHO Standards",
    "section": "Quality Management",
    "chapter": "QM.1"
  },
  "embedding": [0.0123, -0.0456, ...],
  "token_count": 412
}
```

---

## Tool Definitions

| Tool | Description | When Used |
|------|-------------|-----------|
| `search_standards` | Semantic vector search across all standards | General Q&A, concept-based questions |
| `get_standard_by_chapter` | Exact lookup by chapter ID | "Show me QM.1", verbatim citations |
| `list_sections` | Browse available sections/chapters | Discovery, "what chapters exist?" |

---

## Technology Stack & Cost

| Component | Technology | Cost |
|-----------|-----------|------|
| Vector Database | MongoDB Atlas M0 | Free |
| Vector Search | Atlas Vector Search | Free on M0 |
| Embeddings | Voyage AI `voyage-3-large` (1024-dim) | Free (200M tokens) |
| LLM | Anthropic Claude Sonnet | ~$0.50–$2.00 total |
| Runtime | Node.js + TypeScript | Free |

**Total estimated cost: $0–$2.00**

---

## Design Decisions

### Why Voyage AI over OpenAI embeddings?
Voyage AI is MongoDB's native embedding provider (acquired 2024), deeply integrated with Atlas. The `voyage-3-large` model is purpose-built for high-quality retrieval and is completely free at 200M tokens — far more than this project requires. Using `input_type: "query"` vs `"document"` asymmetric encoding also improves retrieval quality.

### Why asymmetric embedding?
At index time, chunks are embedded with `input_type: "document"`. At query time, the query is embedded with `input_type: "query"`. Voyage AI is optimized for this asymmetric pattern, which consistently outperforms symmetric embedding for retrieval tasks.

### Why `numCandidates = topK * 10`?
MongoDB's HNSW approximate nearest neighbor search works better with a broader candidate pool. Using `10x topK` as candidates before re-ranking significantly improves the quality of the final top-k results.

### Chunk strategy
Chunks are split at NIAHO chapter boundaries (e.g., `QM.1`, `IC.3`) to preserve semantic coherence. Oversized chunks are sub-split by paragraph, with sub-chapter IDs like `QM.1.1`. This preserves the chapter hierarchy for exact lookups while keeping embedding quality high.

The chunker automatically skips table-of-contents entries (short chunks containing dot leaders `......` ending in a page number) to avoid indexing TOC references instead of actual chapter content. Some chapters (e.g., `IC.3`) appear only as TOC entries in the PDF with the actual body content embedded inline within a parent section — in these cases the agent falls back to semantic search and informs the user.

---

## Bonus Features Implemented

- ✅ **Hybrid query mode** — Detects when user wants both explanation AND exact text
- ✅ **Multi-chapter support** — Prefix search returns all matching chapters (e.g., "QM" → all QM.* chapters)
- ✅ **Section browsing** — `list_sections` with optional filter
- ✅ **Graceful fallback** — Missing chapters fall back to semantic search with suggestions
- ✅ **Conversation memory** — Full message history maintained across turns in a session
