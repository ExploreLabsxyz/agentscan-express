-- Create chat sessions table for persistent storage of user chat history
CREATE TABLE IF NOT EXISTS chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  session_title TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create chat messages table to store individual messages within sessions
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Add index for faster retrieval of recent sessions by user
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_created 
ON chat_sessions(user_id, created_at DESC);

-- Add index for faster message retrieval within a session
CREATE INDEX IF NOT EXISTS idx_chat_messages_session 
ON chat_messages(session_id, created_at);
