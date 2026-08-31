export type ConversationStatus = "active" | "ended";

export interface ConversationState {
  status: ConversationStatus;
  parent: string | null;
}

export interface ConversationProgress {
  lastProcessedAssistantHash: string | null;
  pendingSend: {
    text: string;
    sourceHash: string;
  } | null;
  terminalDecision: {
    sourceHash: string;
    jobs: CreateConversationJob[];
  } | null;
}

export interface CreateConversationJob {
  id: string;
  kind: "create-conversation";
  parent: string | null;
  body: string;
  sourceHash: string;
  status: "pending" | "send-uncertain";
}

export interface ControlCommand {
  action: "next" | "end";
  body?: string;
}

export interface ParsedControls {
  commands: ControlCommand[];
  invalidLines: string[];
}
