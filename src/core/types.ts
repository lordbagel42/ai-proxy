export type Protocol = "anthropic" | "chat" | "responses";
export type JsonObject = Record<string, unknown>;
export type Part =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "call"; id: string; name: string; arguments: string }
  | { type: "result"; id: string; content: string; isError?: boolean };
export interface Message { role: "user" | "assistant"; content: Part[] }
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
  stream: boolean;
}
export type Event =
  | { type: "text_start"; index: number }
  | { type: "text_delta"; index: number; text: string }
  | { type: "tool_start"; index: number; id: string; name: string }
  | { type: "tool_delta"; index: number; arguments: string }
  | { type: "block_stop"; index: number }
  | { type: "usage"; input: number; output: number; cached?: number }
  | { type: "finish"; reason: "stop" | "length" | "tool_calls" };
export interface Completion {
  id: string;
  model: string;
  created: number;
  blocks: ({ type: "text"; text: string } | { type: "tool"; id: string; name: string; arguments: string })[];
  usage: { input: number; output: number; cached: number };
  reason: "stop" | "length" | "tool_calls";
}
