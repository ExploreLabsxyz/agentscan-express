import { Router } from "express";
import supabase from "../../initalizers/supabaseClient";

const router = Router();

// GET /chats - fetch user's existing chats
router.get("/", async (req: any, res) => {
  try {
    const userId = req.user?.privy_did;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { data: chats, error } = await supabase
      .from("chats")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error fetching chats:", error);
      return res.status(500).json({ message: "Error fetching chats" });
    }

    return res.json(chats);
  } catch (error) {
    console.error("Error in GET /chats:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

// POST /chats - create a new chat entry
router.post("/", async (req: any, res) => {
  try {
    const userId = req.user?.privy_did;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { data: chat, error } = await supabase
      .from("chats")
      .insert([{ user_id: userId }])
      .select()
      .single();

    if (error) {
      console.error("Error creating chat:", error);
      return res.status(500).json({ message: "Error creating chat" });
    }

    return res.status(201).json(chat);
  } catch (error) {
    console.error("Error in POST /chats:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

// GET /chats/:chatId/messages - fetch messages for a chat
router.get("/:chatId/messages", async (req: any, res) => {
  try {
    const userId = req.user?.privy_did;
    const { chatId } = req.params;

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // First verify the chat belongs to the user
    const { data: chat, error: chatError } = await supabase
      .from("chats")
      .select("*")
      .eq("id", chatId)
      .eq("user_id", userId)
      .single();

    if (chatError || !chat) {
      return res.status(404).json({ message: "Chat not found" });
    }

    const { data: messages, error } = await supabase
      .from("chat_messages")
      .select("*")
      .eq("chat_id", chatId)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("Error fetching messages:", error);
      return res.status(500).json({ message: "Error fetching messages" });
    }

    return res.json(messages);
  } catch (error) {
    console.error("Error in GET /chats/:chatId/messages:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

// POST /chats/:chatId/messages - append new message
router.post("/:chatId/messages", async (req: any, res) => {
  try {
    const userId = req.user?.privy_did;
    const { chatId } = req.params;
    const { role, content } = req.body;

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (!role || !content) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // First verify the chat belongs to the user
    const { data: chat, error: chatError } = await supabase
      .from("chats")
      .select("*")
      .eq("id", chatId)
      .eq("user_id", userId)
      .single();

    if (chatError || !chat) {
      return res.status(404).json({ message: "Chat not found" });
    }

    const { data: message, error } = await supabase
      .from("chat_messages")
      .insert([
        {
          chat_id: chatId,
          role,
          content
        }
      ])
      .select()
      .single();

    if (error) {
      console.error("Error creating message:", error);
      return res.status(500).json({ message: "Error creating message" });
    }

    return res.status(201).json(message);
  } catch (error) {
    console.error("Error in POST /chats/:chatId/messages:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
