import { SessionDetails, SessionHistoryMessage, SessionSummary } from "../types.js";

export class SessionRegistry {
  private loadedThreads = new Map<string, string>(); // threadId -> cwd

  public registerLoadedThread(threadId: string, cwd: string): void {
    this.loadedThreads.set(threadId, cwd);
  }

  public isLoaded(threadId: string): boolean {
    return this.loadedThreads.has(threadId);
  }

  public getCwd(threadId: string): string | undefined {
    return this.loadedThreads.get(threadId);
  }

  public removeLoaded(threadId: string): void {
    this.loadedThreads.delete(threadId);
  }

  public clearLoaded(): void {
    this.loadedThreads.clear();
  }

  public parseSessionSummaries(rawThreads: any[]): SessionSummary[] {
    if (!Array.isArray(rawThreads)) return [];
    return rawThreads.map((t) => ({
      threadId: t.id || "",
      title: t.name || t.preview || t.title || "",
      cwd: t.cwd || "",
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      model: t.model,
      sourceKind: t.source || t.sourceKind,
    }));
  }

  public parseSessionDetails(readRes: any): SessionDetails {
    const thread = readRes?.thread || {};
    const summary: SessionSummary = {
      threadId: thread.id || "",
      title: thread.preview || thread.title || "",
      cwd: thread.cwd || "",
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      model: thread.model,
      sourceKind: thread.sourceKind,
    };

    const messages: SessionHistoryMessage[] = [];
    const turns = Array.isArray(thread?.turns)
      ? thread.turns
      : Array.isArray(readRes?.turns)
      ? readRes.turns
      : [];

    for (const turn of turns) {
      const items = Array.isArray(turn?.items) ? turn.items : [];
      for (const item of items) {
        if (item.type === "userMessage") {
          const text = this.extractTextFromContent(item.content || item.text);
          if (text) {
            messages.push({
              role: "user",
              text,
              timestamp: item.createdAt || turn.startedAt,
            });
          }
        } else if (item.type === "agentMessage") {
          const text = item.text || this.extractTextFromContent(item.content);
          if (text) {
            messages.push({
              role: "assistant",
              text,
              timestamp: item.createdAt || turn.completedAt,
            });
          }
        }
      }
    }

    return {
      summary,
      messages,
    };
  }

  private extractTextFromContent(content: any): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === "string") return part;
          if (part && typeof part.text === "string") return part.text;
          return "";
        })
        .join("")
        .trim();
    }
    return "";
  }
}
