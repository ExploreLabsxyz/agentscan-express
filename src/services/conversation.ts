import { pool } from "../initalizers/postgres";
import { redis } from "../initalizers/redis";
import openai from "../initalizers/openai";
import {
  generateChatResponseWithRetry,
  generateEmbeddingWithRetry,
} from "./openai";
import { withRetry } from "./crawler";
import { getInstanceData, getTransactions } from "./transactions";

const STAKING_PATTERNS = [
  "stake olas",
  "staking olas",
  "how to stake",
  "easiest way to stake",
  "want to stake",
  "can i stake",
  "help me stake",
  "guide to staking",
  "staking guide",
  "stake my olas",
  "run olas",
  "running olas",
  "how to run",
  "to run",
  "easiest way to run",
  "want to run",
  "can i run",
  "help me run",
  "guide to running",
  "run my own",
  "running guide",
  "run agent",
  "running agent",
  "run an agent",
  "start agent",
  "starting agent",
  "deploy agent",
  "deploying agent",
  "non technical",

  "easy",
  "simple way",
  "beginner",
  "beginner friendly",
  "don't know how to code",
  "no coding",
  "without coding",
  "not a developer",
  "not technical",
  "simple guide",
  "step by step",
  "how can i",
  "what's the easiest",
  "what is the easiest",
  "best way to",
  "quickest way to",
  "help with",
  "where do i start",
  "getting started",
  "make my own",
  "make my own agent",
  "set up",
  "set up agent",
  "set up my own",
].map((pattern) => `%${pattern}%`);

export type PromptType = "general" | "agent" | "code";

const TEAM_CACHE_TTL = 30 * 60;

interface TeamData {
  system_prompt_name: string;
  name: string;
  user_type: string;
  [key: string]: any;
}

interface RelevantContext {
  content: string;
  name: string;
  location: string;
  type: string;
  similarity?: number;
  score?: number;
}

interface ChatResponse {
  content: string;
  done?: boolean;
  error?: string;
}

interface SurroundingMessage {
  content: string;
  author: string;
  isReplyTo?: boolean;
}

export async function getTeamData(teamId: string): Promise<TeamData> {
  const teamCacheKey = `team:${teamId}`;

  try {
    const cachedTeam = await redis.get(teamCacheKey);
    if (cachedTeam) {
      return JSON.parse(cachedTeam);
    }

    const teamData = await fetchTeamFromDB(teamId);
    await redis.set(teamCacheKey, JSON.stringify(teamData), {
      EX: TEAM_CACHE_TTL,
    });

    return teamData;
  } catch (error) {
    console.error("Error with team cache:", error);
    return await fetchTeamFromDB(teamId);
  }
}

async function fetchTeamFromDB(teamId: string): Promise<TeamData> {
  const teamQuery = await pool.query(
    "SELECT * FROM teams WHERE id = $1 AND deleted_at IS NULL",
    [teamId]
  );

  if (teamQuery.rows.length === 0) {
    throw new Error("Team not found");
  }

  return teamQuery.rows[0];
}

export async function findRelevantContext(
  decodedQuestion: string,
  teamName: string,
  promptType: PromptType,
  agentId?: string | null,
  transactions?: any[],
  surroundingMessages?: SurroundingMessage[]
): Promise<RelevantContext[]> {
  const deploymentId = process.env.RAILWAY_DEPLOYMENT_ID || "local";

  // Create a context-aware cache key
  const cacheKey = `relevantContext:${deploymentId}:${teamName}:${promptType}:${
    agentId || "none"
  }:${Buffer.from(decodedQuestion).toString("base64")}`;

  // Cache check logic...
  if (deploymentId !== "local") {
    try {
      const cachedContext = await redis.get(cacheKey);
      if (cachedContext) {
        return JSON.parse(cachedContext);
      }
    } catch (cacheError) {
      console.error("Cache error in findRelevantContext:", cacheError);
    }
  }

  const questionEmbedding = await generateEmbeddingWithRetry(decodedQuestion);

  let codeEmbeddings;
  if (promptType === "agent") {
    codeEmbeddings = await fetchCodeEmbeddingsAgent(
      questionEmbedding,
      teamName,
      decodedQuestion,
      agentId,
      transactions
    );
  } else if (promptType === "code") {
    codeEmbeddings = await fetchCodeEmbeddingsCode(
      questionEmbedding,
      teamName,
      decodedQuestion
    );
  } else {
    codeEmbeddings = await fetchCodeEmbeddingsGeneral(
      questionEmbedding,
      teamName,
      decodedQuestion
    );
  }

  // Modified to include surrounding messages in scoring
  const relevantEmbeddings = await scoreEmbeddings(
    codeEmbeddings,
    decodedQuestion,
    surroundingMessages
  );
  //look for yaml content

  const result = await filterAndSortContext(codeEmbeddings, relevantEmbeddings);
  if (deploymentId !== "local") {
    try {
      await redis.set(cacheKey, JSON.stringify(result), {
        EX: 30 * 60,
      });
    } catch (cacheError) {
      console.error("Error caching relevant context:", cacheError);
    }
  }

  return result;
}

async function fetchCodeEmbeddingsGeneral(
  questionEmbedding: any,
  teamName: string,
  decodedQuestion: string
) {
  const lowerQuestion = decodedQuestion.toLowerCase();
  const hasStakingPattern = STAKING_PATTERNS.some((pattern) =>
    lowerQuestion.includes(pattern.replace(/%/g, ""))
  );

  const baseQuery = `
    WITH ranked_matches AS (
      SELECT 
        content, 
        name, 
        location,
        original_location,
        type, 
        (embedding <=> $1) as similarity
      FROM context_embeddings 
      WHERE company_id = $2 
      AND type = 'adev'
      AND (embedding <=> $1) < 0.8
      ORDER BY similarity
    )
    SELECT *,
      CASE 
        ${
          hasStakingPattern
            ? "WHEN LOWER(content) LIKE '%pearl%' AND LOWER($3) LIKE ANY(SELECT UNNEST($4::text[])) THEN similarity * 0.3"
            : ""
        }
        WHEN LOWER(content) LIKE $3 THEN similarity * 0.7
        WHEN LOWER(name) LIKE $3 THEN similarity * 0.8
        ELSE similarity
      END as adjusted_similarity
    FROM ranked_matches
    ORDER BY adjusted_similarity
    LIMIT 15
  `;

  const params = hasStakingPattern
    ? [questionEmbedding, teamName, `%${lowerQuestion}%`, STAKING_PATTERNS]
    : [questionEmbedding, teamName, `%${lowerQuestion}%`];

  const query = await pool.query(baseQuery, params);

  return query.rows;
}

async function fetchCodeEmbeddingsAgent(
  questionEmbedding: any,
  teamName: string,
  decodedQuestion: string,
  agentId?: string | null,
  transactions?: any[]
) {
  try {
    if (!agentId) {
      console.log("No agent ID provided");
      return [];
    }

    const addresses = new Set<string>();
    if (transactions) {
      transactions?.forEach((tx) => {
        if (tx.transaction.to) addresses.add(tx.transaction.to.toLowerCase());
        tx.transaction.logs.forEach((log: any) => {
          if (log.address) addresses.add(log.address.toLowerCase());
        });
      });
    }

    const addressesArray = Array.from(addresses);

    const query = await pool.query(
      `WITH ranked_matches AS (
        SELECT id, content, name, location, type, original_location, (embedding <=> $1) as similarity
        FROM context_embeddings 
        WHERE company_id = $2 
        AND type = 'adev'
        AND (
          (LOWER(id) LIKE $4)
          OR (LOWER(name) LIKE ANY($5::text[]))
        )
        ORDER BY similarity
      )
      SELECT *,
        CASE 
          WHEN LOWER(content) LIKE $3 THEN similarity * 0.7
          WHEN LOWER(name) LIKE $3 THEN similarity * 0.8
          ELSE similarity
        END as adjusted_similarity
      FROM ranked_matches
      ORDER BY adjusted_similarity
      `,
      [
        questionEmbedding,
        teamName,
        `%${decodedQuestion.toLowerCase()}%`,
        `${agentId?.toLowerCase()}%`,
        addressesArray,
      ]
    );

    return query.rows.slice(0, 15);
  } catch (error) {
    console.error("Error in fetchCodeEmbeddingsAgent:", error);
    return fetchCodeEmbeddingsBasic(
      questionEmbedding,
      teamName,
      decodedQuestion
    );
  }
}

async function fetchCodeEmbeddingsBasic(
  questionEmbedding: any,
  teamName: string,
  decodedQuestion: string
) {
  const query = await pool.query(
    `WITH ranked_matches AS (
      SELECT content, name, location, type, original_location, (embedding <=> $1) as similarity
      FROM context_embeddings 
      WHERE company_id = $2 
      AND type = 'adev'
      AND (embedding <=> $1) < 0.8
      ORDER BY similarity
    )
    SELECT *,
      CASE 
        WHEN LOWER(content) LIKE $3 THEN similarity * 0.7
        WHEN LOWER(name) LIKE $3 THEN similarity * 0.8
        ELSE similarity
      END as adjusted_similarity
    FROM ranked_matches
    ORDER BY adjusted_similarity
    `,
    [questionEmbedding, teamName, `%${decodedQuestion.toLowerCase()}%`]
  );

  return query.rows.slice(0, 15);
}

async function fetchCodeEmbeddingsCode(
  questionEmbedding: any,
  teamName: string,
  decodedQuestion: string
) {
  const deploymentId = process.env.RAILWAY_DEPLOYMENT_ID || "local";
  const cacheKey = `adev_commands:${teamName}`;

  try {
    const cachedCommands = await redis.get(cacheKey);
    if (cachedCommands && deploymentId !== "local") {
      const parsed = JSON.parse(cachedCommands);
      if (parsed && parsed.length > 0) {
        return parsed;
      }
    }
  } catch (error) {
    console.error("Cache error in fetchCodeEmbeddingsCode:", error);
  }

  const criticalDocsQuery = await pool.query(
    `WITH all_commands AS (
      SELECT 
        content, 
        name,
        location,
        original_location,
        type,
        0 as similarity,
        TRUE as is_critical
      FROM context_embeddings 
      WHERE company_id = $2 
      AND type = 'adev'
      AND location ILIKE '%https://8ball030.github.io/auto_dev/commands%'
    ),
    critical_docs AS (
      SELECT 
        content, 
        name,
        location,
        original_location,
        type,
        (embedding <=> $1) as similarity,
        TRUE as is_critical
      FROM context_embeddings 
      WHERE company_id = $2 
      AND type = 'adev'
      AND (
        original_location = 'https://github.com/8ball030/auto_dev/blob/main/README.md'
        OR location ILIKE '%create_new_agent_from_fsm.yaml%'
      )
      ORDER BY CASE 
        WHEN location LIKE '%#chunk%' 
        THEN CAST(SUBSTRING(location FROM '#chunk([0-9]+)' FOR '#') AS INTEGER)
        ELSE 999999
      END
    )
    SELECT * FROM all_commands UNION ALL SELECT * FROM critical_docs`,
    [questionEmbedding, teamName]
  );

  const adevQuery = await pool.query(
    `WITH ranked_matches AS (
      SELECT 
        content, 
        name,
        location,
        original_location,
        type,
        (embedding <=> $1) as similarity,
        FALSE as is_critical
      FROM context_embeddings 
      WHERE company_id = $2 
      AND type = 'adev'
      AND original_location NOT IN (
        'https://github.com/8ball030/auto_dev/blob/main//README.md',
        'https://github.com/8ball030/auto_dev/blob/main/auto_dev/data/workflows/create_new_agent_from_fsm.yaml'
      )
      AND location NOT ILIKE '%/commands%'
      AND (embedding <=> $1) < 0.8
      ORDER BY similarity
      LIMIT 10
    )
    SELECT *,
      CASE 
        WHEN LOWER(content) LIKE $3 THEN similarity * 0.7
        WHEN LOWER(name) LIKE $3 THEN similarity * 0.8
        ELSE similarity
      END as adjusted_similarity,
      FALSE as is_critical
    FROM ranked_matches
    ORDER BY adjusted_similarity`,
    [questionEmbedding, teamName, `%${decodedQuestion.toLowerCase()}%`]
  );

  const combinedDocs = [...criticalDocsQuery.rows, ...adevQuery.rows];
  console.log("combinedDocs", combinedDocs.length);
  // Only cache if we have results
  if (combinedDocs.length > 0 && deploymentId !== "local") {
    try {
      await redis.set(cacheKey, JSON.stringify(combinedDocs), {
        EX: 24 * 60 * 60,
      });
    } catch (error) {
      console.error("Error caching docs:", error);
    }
  }

  //check if https://github.com/8ball030/auto_dev/blob/main/auto_dev/data/workflows/create_new_agent_from_fsm.yaml is in the critical docs
  const isWorkflowInCriticalDocs = combinedDocs.find(
    (row) =>
      row.location ===
      "https://github.com/8ball030/auto_dev/blob/main/auto_dev/data/workflows/create_new_agent_from_fsm.yaml"
  );
  if (isWorkflowInCriticalDocs) {
    console.log("Workflow found in critical docs", isWorkflowInCriticalDocs);
  } else {
    console.log("Workflow not found in critical docs");
  }

  return combinedDocs;
}

async function scoreEmbeddings(
  codeEmbeddings: any[],
  decodedQuestion: string,
  surroundingMessages?: {
    content: string;
    author: string;
    isReplyTo?: boolean;
  }[]
) {
  const BATCH_SIZE = 5;
  const results: Array<{ score: number; index: number }> = [];

  // First, add critical documents with max score
  codeEmbeddings.forEach((embedding, index) => {
    if (embedding.is_critical) {
      results.push({ score: 10, index });
    }
  });

  // Then score non-critical documents
  const nonCriticalEmbeddings = codeEmbeddings.filter((e) => !e.is_critical);

  const conversationContext = surroundingMessages
    ? "\n\nConversation Context:\n" +
      surroundingMessages
        .map(
          (m) =>
            `${m.author}: ${m.content}${m.isReplyTo ? " (replied to)" : ""}`
        )
        .join("\n")
    : "";

  for (let i = 0; i < nonCriticalEmbeddings.length; i += BATCH_SIZE) {
    const batch = nonCriticalEmbeddings.slice(i, i + BATCH_SIZE);

    await withRetry(
      async () => {
        const messages = [
          {
            role: "user" as const,
            content: batch
              .map(
                (embedding, i) =>
                  `Context ${i + 1}:\n${
                    embedding.content
                  }\n\nQuestion: "${decodedQuestion}"${conversationContext}\nRate 0-10:`
              )
              .join("\n\n"),
          },
        ];

        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system" as const,
              content:
                'You are an Autonolas (Olas) support bot expert. Your task is to rate how relevant each context is for answering questions about Olas. Score each context from 0-10 based on these rules:\n\n1. STRICT ZERO (0) FOR:\n- Single word messages\n- Exclamations without questions\n- Random project names\n- Off-topic conversation\n- Non-questions without technical context\n- Trading/price discussion/questions about price\n\n2. HIGH SCORES (7-10) FOR:\n- Questions about Olas founders, team members, and advisors\n- Questions about project history and origins\n- Technical questions about architecture\n- Error messages from Olas tools/quickstart\n- Installation/setup problems\n- Development and deployment issues\n- Questions about protocols and systems\n\n3. MEDIUM SCORES (3-6) FOR:\n- General blockchain questions related to Olas\n- Basic conceptual questions\n- General ecosystem questions\n\nEXAMPLES:\nGood Questions (High Score):\n- "How do I set up a local development environment for Olas?"\n- "I\'m getting an error when deploying my agent: [error details]. How can I fix this?"\n- "Can you explain the architecture of the Olas protocol?"\n- "Who are the founders of Autonolas?"\n\nBad Questions (Zero Score):\n- "wen moon?"\n- "price prediction?"\n- "gm"\n- "what\'s the best crypto to buy?"\n- "Is Kevin a dawg dev"\n\nIMPORTANT:\n- Team and founder questions are highly relevant\n- Error messages and technical problems are highly relevant\n- Installation issues should get high scores\n- Consider if it\'s a genuine question about Olas\n\nRESPOND ONLY WITH NUMBERS 0-10 SEPARATED BY COMMAS. Example:\n0,3,7,0,4',
            },
            ...messages,
          ],
          max_tokens: 50,
          temperature: 0.1,
        });

        const scores = completion.choices[0].message.content
          ?.split(",")
          .map((score) => parseInt(score.trim()))
          .filter((score) => !isNaN(score) && score >= 0 && score <= 10);

        if (!scores || scores.length !== batch.length) {
          throw new Error("Invalid score format or count");
        }

        scores.forEach((score, batchIndex) => {
          const originalIndex = codeEmbeddings.findIndex(
            (e) => e === batch[batchIndex]
          );
          results.push({
            score,
            index: originalIndex,
          });
        });
      },
      { maxRetries: 3, initialDelay: 1000 }
    );
  }

  return results;
}

async function filterAndSortContext(
  codeEmbeddings: any[],
  relevantEmbeddings: Array<{ score: number; index: number }>
): Promise<RelevantContext[]> {
  // Separate critical and non-critical embeddings
  const criticalEmbeddings = codeEmbeddings.filter((e) => e.is_critical);
  const nonCriticalIndices = codeEmbeddings
    .map((e, i) => ({ embedding: e, index: i }))
    .filter((e) => !e.embedding.is_critical)
    .map((e) => e.index);

  // Sort and filter non-critical embeddings
  const sortedNonCriticalEmbeddings = relevantEmbeddings
    .filter(({ index }) => nonCriticalIndices.includes(index))
    .sort((a, b) => b.score - a.score);

  const relevantNonCriticalIndices = sortedNonCriticalEmbeddings
    .slice(0, 5) // Take exactly 5 non-critical items
    .filter(({ score }) => score >= 4)
    .map(({ index }) => index);

  // Combine critical and filtered non-critical embeddings
  let relevantContext = [
    ...criticalEmbeddings.map((embedding) => ({
      content: embedding.content,
      name: embedding.name,
      location: embedding.location || "",
      type: embedding.type || "component",
      score: 10, // Critical embeddings get max score
    })),
    ...codeEmbeddings
      .filter((_, index) => relevantNonCriticalIndices.includes(index))
      .map((embedding) => ({
        content: embedding.content,
        name: embedding.name,
        location: embedding.location || "",
        type: embedding.type || "component",
        score:
          relevantEmbeddings.find(({ index }) => index === index)?.score || 0,
      })),
  ];

  // Check if any of the relevant context items are chunks
  const hasChunks = relevantContext.some((ctx) =>
    ctx.location.includes("#chunk")
  );

  // If chunks are found, fetch all chunks from the same document
  if (hasChunks) {
    const query = await pool.query(
      `WITH chunk_docs AS (
        SELECT DISTINCT original_location 
        FROM context_embeddings 
        WHERE location LIKE '%#chunk%'
        AND original_location IN (
          SELECT original_location 
          FROM context_embeddings 
          WHERE location = ANY($1)
        )
      )
      SELECT 
        content,
        name,
        location,
        type,
        original_location
      FROM context_embeddings 
      WHERE original_location IN (SELECT original_location FROM chunk_docs)
      ORDER BY 
        original_location,
        CASE 
          WHEN location LIKE '%#chunk%' 
          THEN CAST(SUBSTRING(location FROM '#chunk([0-9]+)' FOR '#') AS INTEGER)
          ELSE 999999
        END`,
      [relevantContext.map((ctx) => ctx.location)]
    );

    // Group chunks by original_location
    const chunksByDoc = query.rows.reduce((acc: any, row) => {
      if (!acc[row.original_location]) {
        acc[row.original_location] = [];
      }
      acc[row.original_location].push(row);
      return acc;
    }, {});

    // Replace individual chunks with complete documents
    relevantContext = relevantContext.map((ctx) => {
      if (ctx.location.includes("#chunk")) {
        const originalLocation = ctx.location.split("#")[0];
        const chunks = chunksByDoc[originalLocation];
        if (chunks) {
          return {
            content: chunks.map((c: any) => c.content).join("\n\n"),
            name: chunks[0].name,
            location: originalLocation,
            type: chunks[0].type,
            score: ctx.score,
          };
        }
      }
      return ctx;
    });

    // Remove duplicates
    relevantContext = relevantContext.filter(
      (ctx, index, self) =>
        index === self.findIndex((t) => t.location === ctx.location)
    );
  }

  return relevantContext
    .sort((a: any, b: any) => b.similarity - a.similarity)
    .slice(0, criticalEmbeddings.length + 5); // Return critical context plus exactly 5 non-critical items
}

export async function* generateConversationResponse(
  question: string,
  messages: any[],
  teamData: TeamData,
  promptType: PromptType,
  agentInstance?: string | null,
  useSleep: boolean = true
): AsyncGenerator<ChatResponse> {
  try {
    const decodedQuestion = decodeURIComponent(question);
    let { system_prompt_name, name: teamName } = teamData;
    const deploymentId = process.env.RAILWAY_DEPLOYMENT_ID || "local";
    const cacheKey = `conversation:${deploymentId}:${
      teamData.id
    }:${promptType}:${agentInstance || "none"}:${Buffer.from(
      decodedQuestion
    ).toString("base64")}`;

    try {
      const cachedResponse = await redis.get(cacheKey);
      if (cachedResponse && deploymentId !== "local") {
        const chunks = JSON.parse(cachedResponse);

        await sleep(500);

        for (const chunk of chunks) {
          if (useSleep) {
            await sleep(70 + Math.random() * 50);
          }
          yield { content: chunk };
        }
        yield { content: "", done: true };
        return;
      }
    } catch (cacheError) {
      console.error("Cache error:", cacheError);
      yield { content: "", error: "Cache error occurred" };
    }

    //get agent id
    let agent;
    let transactions: any[] = [];
    if (agentInstance && promptType === "agent") {
      agent = await getInstanceData(agentInstance);
      let { transactions: txs } = await getTransactions(agentInstance || "");
      transactions = txs;
    }

    const limitedContext = await findRelevantContext(
      decodedQuestion,
      teamName,
      promptType,
      agent?.agent?.id,
      transactions
    );

    const responseChunks: string[] = [];

    try {
      let chunkCount = 0;
      for await (const chunk of generateChatResponseWithRetry(
        limitedContext,
        messages,
        system_prompt_name,
        promptType as any,
        agent
          ? {
              name: agent.agent.originalName,
              description: agent.agent.description,
            }
          : null,
        transactions
      )) {
        chunkCount++;
        responseChunks.push(chunk);

        if (chunkCount % 50 === 0) {
          console.log(`Streamed ${chunkCount} chunks so far`);
        }

        if (useSleep) {
          await sleep(70 + Math.random() * 50);
        }
        yield { content: chunk };
      }

      // Cache the response
      try {
        await redis.set(cacheKey, JSON.stringify(responseChunks), {
          EX: CODE_CACHE_TTL,
        });
      } catch (cacheError) {
        console.error("Error caching response:", cacheError);
      }

      yield { content: "", done: true };
    } catch (error) {
      console.error("Streaming error:", error);
      yield { content: "", error: "Streaming failed" };
    }
  } catch (error) {
    console.error("Error generating conversation response:", error);
    yield { content: "", error: "Failed to generate response" };
  }
}

// Helper function for sleep
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Add cache TTL constant
const CODE_CACHE_TTL = 2 * 24 * 60 * 60; // 2 days in seconds
