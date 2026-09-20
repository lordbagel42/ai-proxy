export type Protocol = "anthropic" | "chat" | "responses";
export type JsonObject = Record<string, unknown>;
export type MessagePhase = "commentary" | "final_answer" | null;
export type Part =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "call"; id: string; name: string; arguments: string }
  | { type: "result"; id: string; content: string; isError?: boolean };
export interface Message { role: "user" | "assistant"; content: Part[]; phase?: MessagePhase }
export interface Tool { name: string; description?: string; parameters: JsonObject; custom?: boolean; clientName?: string; namespace?: string }
export interface GenerationRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: Tool[];
  toolChoice?: "auto" | "none" | "required" | { name: string };
  parallelTools?: boolean;
  maxTokens: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  reasoning?: { effort?: string; summary?: "auto" | "concise" | "detailed" | "none"; context?: "auto" | "current_turn" | "all_turns" };
  stream: boolean;
}
export type Event =
  | { type: "text_start"; index: number; phase?: MessagePhase }
  | { type: "text_delta"; index: number; text: string }
  | { type: "tool_start"; index: number; id: string; name: string }
  | { type: "tool_delta"; index: number; arguments: string }
  | { type: "block_stop"; index: number; phase?: MessagePhase }
  | { type: "usage"; input: number; output: number; cached?: number }
  | { type: "finish"; reason: "stop" | "length" | "tool_calls" };
export interface Completion {
  id: string;
  model: string;
  created: number;
  blocks: ({ type: "text"; text: string; phase?: MessagePhase } | { type: "tool"; id: string; name: string; arguments: string })[];
  usage: { input: number; output: number; cached: number };
  reason: "stop" | "length" | "tool_calls";
}
