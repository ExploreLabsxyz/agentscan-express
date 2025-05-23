import { relations } from "drizzle-orm/relations";
import { discord_servers, discord_allowed_channels, chat_sessions, chat_messages } from "./schema";

export const discord_allowed_channelsRelations = relations(discord_allowed_channels, ({one}) => ({
	discord_server: one(discord_servers, {
		fields: [discord_allowed_channels.server_id],
		references: [discord_servers.id]
	}),
}));

export const discord_serversRelations = relations(discord_servers, ({many}) => ({
	discord_allowed_channels: many(discord_allowed_channels),
}));

export const chat_messagesRelations = relations(chat_messages, ({one}) => ({
	chat_session: one(chat_sessions, {
		fields: [chat_messages.session_id],
		references: [chat_sessions.id]
	}),
}));

export const chat_sessionsRelations = relations(chat_sessions, ({many}) => ({
	chat_messages: many(chat_messages),
}));