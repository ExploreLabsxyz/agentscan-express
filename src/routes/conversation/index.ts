import { Router } from "express";
import {
  getTeamData,
  generateConversationResponse,
  PromptType,
} from "../../services/conversation";
import { executeQuery } from "../../services/postgres";
import { PoolClient } from "pg";
import { authMiddleware } from "../../middleware/auth";

interface ChatResponse {
  content?: string;
  error?: string;
  done?: boolean;
}

const router = Router();

// Get recent chat sessions for authenticated user
// Get messages for a specific chat session
router.get("/messages/:sessionId", authMiddleware, async (req: any, res) => {
  const userId = req.user.id;
  const { sessionId } = req.params;

  try {
    // Verify session ownership
    const messages = await executeQuery(async (client: PoolClient) => {
      // First verify ownership
      const sessionResult = await client.query(
        "SELECT id FROM chat_sessions WHERE id = $1 AND user_id = $2",
        [sessionId, userId]
      );
      
      if (sessionResult.rows.length === 0) {
        return res.status(403).json({ message: "Session not found or unauthorized" });
      }

      // Fetch messages
      const result = await client.query(
        "SELECT role, content, created_at FROM chat_messages WHERE session_id = $1 ORDER BY created_at ASC",
        [sessionId]
      );
      return result.rows;
    });
    return res.json({ messages });
  } catch (error) {
    console.error("Error fetching messages:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/sessions", authMiddleware, async (req: any, res) => {
  const userId = req.user.id;
  try {
    const sessions = await executeQuery(async (client: PoolClient) => {
      const result = await client.query(
        "SELECT id, session_title, created_at FROM chat_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5",
        [userId]
      );
      return result.rows;
    });
    return res.json({ sessions });
  } catch (error) {
    console.error("Error fetching sessions:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/", authMiddleware, async (req: any, res) => {
  let {
    question,
    messages,
    teamId,
    type = "general",
    instance = null,
    sessionId = null,
    sessionTitle = null,
  } = req.body;
  
  const userId = req.user.id;

  if (instance) {
    instance = instance.toLowerCase();
  }

  if (!["general", "agent"].includes(type)) {
    return res.status(400).json({
      message: "Invalid type. Must be either 'general' or 'agent'.",
    });
  }

  if (!question) {
    return res.status(400).json({ message: "question is required." });
  }

  try {
    // Create or get session
    let currentSessionId = sessionId;
    if (currentSessionId) {
      // Verify session ownership
      const sessionExists = await executeQuery(async (client: PoolClient) => {
        const result = await client.query(
          "SELECT id FROM chat_sessions WHERE id = $1 AND user_id = $2",
          [currentSessionId, userId]
        );
        return result.rows.length > 0;
      });
      
      if (!sessionExists) {
        return res.status(403).json({ message: "Session not found or unauthorized" });
      }
    } else {
      currentSessionId = await executeQuery(async (client: PoolClient) => {
        const title = sessionTitle || `Chat started at ${new Date().toISOString()}`;
        const result = await client.query(
          "INSERT INTO chat_sessions (user_id, session_title) VALUES ($1, $2) RETURNING id",
          [userId, title]
        );
        return result.rows[0].id;
      });
    }

    // Store user's message
    await executeQuery(async (client: PoolClient) => {
      await client.query(
        "INSERT INTO chat_messages (session_id, role, content) VALUES ($1, $2, $3)",
        [currentSessionId, "user", question]
      );
    });

    const teamData = await getTeamData(teamId);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    
    // Add sessionId to the first response
    res.write(`${JSON.stringify({ sessionId: currentSessionId })}\n\n`);

    for await (const response of generateConversationResponse(
      question,
      messages,
      teamData,
      type as PromptType,
      instance
    )) {
      res.write(`${JSON.stringify(response)}\n\n`);

      if (response.error) {
        break;
      }

      // Store assistant's message if it's a complete response
      if (!response.loading && response.content) {
        await executeQuery(async (client: PoolClient) => {
          await client.query(
            "INSERT INTO chat_messages (session_id, role, content) VALUES ($1, $2, $3)",
            [currentSessionId, "assistant", response.content]
          );
        });
      }
    }

    res.end();
  } catch (error: any) {
    if (error.message === "Team not found") {
      return res.status(404).json({ message: "Team not found" });
    }
    console.error("Error processing request:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
