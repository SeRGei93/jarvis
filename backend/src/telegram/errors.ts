/**
 * Error carrying a user-facing (Russian) message safe to show in chat. The bot's
 * global `bot.catch` and command handlers surface `userMessage`; any other error
 * falls back to a generic message. Replaces Go's `promptguard.UserMessenger`
 * interface (the TS `validateUserMessage` returns a result object instead of throwing).
 */
export class TelegramReplyError extends Error {
  constructor(public readonly userMessage: string) {
    super(userMessage);
    this.name = "TelegramReplyError";
  }
}
