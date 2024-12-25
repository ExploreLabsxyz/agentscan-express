-- Create chat persistence tables
CREATE TABLE IF NOT EXISTS chats (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id text NOT NULL,        -- Privy user ID
    created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    chat_id uuid REFERENCES chats(id) ON DELETE CASCADE,
    role text NOT NULL,           -- 'user' or 'assistant'
    content text NOT NULL,
    created_at timestamptz DEFAULT now()
);
