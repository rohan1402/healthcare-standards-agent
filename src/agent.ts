/**
 * src/agent.ts
 *
 * Healthcare Standards Agent — Path B (Tool-Calling Agent)
 *
 * Orchestrates the full agentic loop:
 *   user input → Claude (tool decision) → tool execution → Claude (final answer)
 *
 * Supports:
 *  - Q&A mode (semantic search)
 *  - Citation mode (exact chapter lookup)
 *  - Hybrid mode (both in one query)
 *  - Conversation memory across turns
 *
 * Run with: npm run agent
 */

import Anthropic from "@anthropic-ai/sdk";
import * as readline from "readline";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import {
  searchStandards,
  getStandardByChapter,
  listSections,
  closeDb,
} from "./tools.js";

// dotenv already configured above with explicit path

// ─── Config ────────────────────────────────────────────────────────────────────

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;
const MODEL = "claude-sonnet-4-20250514";
const MAX_TOKENS = 4096;
const TOP_K = parseInt(process.env.TOP_K ?? "5");

// ─── Tool Definitions (JSON Schema for Claude) ─────────────────────────────────

const tools: Anthropic.Tool[] = [
  {
    name: "search_standards",
    description: `Perform a semantic vector search across NIAHO healthcare accreditation standards.
Use this tool for:
- General questions about requirements (e.g., "What are the infection control requirements?")
- Topic-based searches (e.g., "fire safety", "medication errors", "patient rights")
- When the user asks about a concept without citing a specific chapter ID
Returns the top-k most semantically relevant chunks with chapter citations and relevance scores.`,
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The natural language search query. Be specific for better results.",
        },
        top_k: {
          type: "number",
          description: "Number of results to return (default: 5, max: 10)",
          default: TOP_K,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_standard_by_chapter",
    description: `Retrieve the exact verbatim text of a specific NIAHO chapter by its ID.
Use this tool when:
- The user asks for a specific chapter by ID (e.g., "Show me QM.1", "What does IC.3 say?")
- The user explicitly asks for exact/verbatim text or a citation
- The user uses phrases like "cite", "show me exactly", "give me the text of"
Returns the complete, unmodified text of the chapter — no paraphrasing or summarization.
Handles prefix searches (e.g., "QM" returns all QM.* chapters).`,
    input_schema: {
      type: "object",
      properties: {
        chapter_id: {
          type: "string",
          description:
            'The chapter identifier (e.g., "QM.1", "IC.3", "LS.2.1"). Case-insensitive.',
        },
      },
      required: ["chapter_id"],
    },
  },
  {
    name: "list_sections",
    description: `List all available sections and chapters in the NIAHO knowledge base.
Use this tool when:
- The user wants to browse or discover what topics are available
- The user asks "what chapters are there?" or "what sections exist?"
- The user asks to see all chapters in a section (e.g., "list all QM chapters")
- Before searching, to understand the scope of available content
Returns sections grouped by category with chapter IDs.`,
    input_schema: {
      type: "object",
      properties: {
        section_filter: {
          type: "string",
          description:
            'Optional filter by section name or chapter prefix (e.g., "QM", "Infection Control", "IC")',
        },
      },
      required: [],
    },
  },
];

// ─── System Prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a Healthcare Standards Expert Agent specializing in NIAHO (National Integrated Accreditation for Healthcare Organizations) accreditation standards.

Your knowledge base is stored in MongoDB Atlas and you have access to three tools to query it.

## Tool Selection Rules

1. **search_standards** — Use for any general or conversational question about healthcare requirements.
   - "What are the infection control requirements?"
   - "How should medication errors be handled?"
   - "Tell me about patient rights"

2. **get_standard_by_chapter** — Use when the user explicitly requests a specific chapter by ID OR asks for exact/verbatim text.
   - "Show me chapter QM.1"
   - "What does IC.3 say exactly?"
   - "Give me the verbatim text of MM.2"
   - "Cite LS.2"

3. **list_sections** — Use when the user wants to browse, discover, or get an overview of available content.
   - "What topics are covered?"
   - "List all chapters"
   - "Show me all QM chapters"

## Hybrid Queries
If a user asks both a conceptual question AND requests exact text in one message, call BOTH tools:
- First call search_standards for the conceptual answer
- Then call get_standard_by_chapter for the exact citation
- Combine both results in your response

## Response Format

### For Q&A (semantic search):
- Provide a clear, synthesized answer using the retrieved context
- Always cite sources: **[Chapter X.Y — Section Name]**
- Include relevance scores where helpful
- If multiple chapters are relevant, organize your answer by chapter

### For Citation lookups:
- Return the VERBATIM text exactly as stored — do NOT paraphrase or summarize
- Clearly label: "**Chapter [ID] — [Section Name]**"
- Include all metadata: document name, section, chapter ID

### For "not found" scenarios:
- Clearly state the chapter was not found
- Offer semantically related alternatives from the knowledge base
- Suggest similar chapter IDs the user might be looking for

### For out-of-scope questions:
- Politely indicate the question falls outside the NIAHO standards knowledge base
- Suggest what types of questions you CAN answer

## General Guidelines
- Always cite chapter IDs in your answers (e.g., **QM.1**, **IC.3**)
- Be precise and professional — this is healthcare compliance information
- If uncertain, always defer to the exact text from the knowledge base rather than generating content
- Keep responses well-organized with headers for complex multi-part answers`;

// ─── Agent Loop ────────────────────────────────────────────────────────────────

type Message = Anthropic.MessageParam;

/**
 * Execute a tool call requested by the model.
 * Returns the result as a string to feed back into the conversation.
 */
async function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<string> {
  let result;

  switch (toolName) {
    case "search_standards":
      result = await searchStandards(
        toolInput.query as string,
        (toolInput.top_k as number) ?? TOP_K
      );
      break;

    case "get_standard_by_chapter":
      result = await getStandardByChapter(toolInput.chapter_id as string);
      break;

    case "list_sections":
      result = await listSections(toolInput.section_filter as string | undefined);
      break;

    default:
      return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }

  return JSON.stringify(result, null, 2);
}

/**
 * Main agent loop for a single user query.
 * Handles multi-step tool calls until the model returns a final text response.
 *
 * @param client       Anthropic SDK client
 * @param userMessage  The current user input
 * @param history      Conversation history (mutated in place)
 * @returns            The final text response from the model
 */
async function runAgentTurn(
  client: Anthropic,
  userMessage: string,
  history: Message[]
): Promise<string> {
  // Append the user's message to history
  history.push({ role: "user", content: userMessage });

  // Agent loop — keeps iterating as long as the model wants to call tools
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools,
      messages: history,
    });

    // Append assistant's response to history
    history.push({ role: "assistant", content: response.content });

    // Case 1: Model wants to call tool(s)
    if (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
      );

      // Execute all requested tools (model may request multiple in parallel)
      const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
        toolUseBlocks.map(async (toolUse) => {
          console.log(`\n  🔧 Tool call: ${toolUse.name}`);
          console.log(`     Input: ${JSON.stringify(toolUse.input)}`);

          const resultStr = await executeTool(
            toolUse.name,
            toolUse.input as Record<string, unknown>
          );

          console.log(
            `     Result: ${resultStr.substring(0, 150)}${resultStr.length > 150 ? "..." : ""}`
          );

          return {
            type: "tool_result" as const,
            tool_use_id: toolUse.id,
            content: resultStr,
          };
        })
      );

      // Feed tool results back to the model
      history.push({ role: "user", content: toolResults });
      // Loop continues — model will process results and either call more tools or give final answer
      continue;
    }

    // Case 2: Model has a final text response
    if (response.stop_reason === "end_turn") {
      const textBlock = response.content.find(
        (block): block is Anthropic.TextBlock => block.type === "text"
      );
      return textBlock?.text ?? "(No response generated)";
    }

    // Unexpected stop reason
    return `(Unexpected stop reason: ${response.stop_reason})`;
  }
}

// ─── CLI Chat Interface ────────────────────────────────────────────────────────

async function main() {
  if (!ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set in .env");
  }

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  // Conversation history — persists across turns within a session
  const history: Message[] = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║        Healthcare Standards Agent (NIAHO)            ║");
  console.log("║    Powered by Claude + MongoDB Atlas Vector Search   ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log('\nType your question below. Type "exit" to quit.\n');
  console.log("Example queries:");
  console.log('  • "What are the infection control requirements?"');
  console.log('  • "Show me chapter QM.1"');
  console.log('  • "List all available sections"\n');

  const askQuestion = (): void => {
    rl.question("You: ", async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        askQuestion();
        return;
      }

      if (trimmed.toLowerCase() === "exit" || trimmed.toLowerCase() === "quit") {
        console.log("\nGoodbye! Closing connections...");
        await closeDb();
        rl.close();
        process.exit(0);
      }

      try {
        console.log("\nAgent: thinking...");
        const response = await runAgentTurn(client, trimmed, history);
        console.log(`\nAgent: ${response}\n`);
        console.log("─".repeat(60) + "\n");
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`\nAgent Error: ${msg}\n`);
      }

      askQuestion();
    });
  };

  askQuestion();
}

main().catch((err) => {
  console.error("❌ Agent startup failed:", err.message);
  process.exit(1);
});
