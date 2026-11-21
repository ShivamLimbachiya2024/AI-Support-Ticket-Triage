import { TICKET_CATEGORY, TICKET_PRIORITY } from '../../modules/tickets/enum';

export interface TriageOutput {
  category: TICKET_CATEGORY;
  priority: TICKET_PRIORITY;
  summary: string;
  confidence?: number;
}

export interface TriageCandidate extends TriageOutput {
  evidence: string[];
  confidence: number;
}

export interface TriageJudgeResult {
  accepted: boolean;
  reason: string;
}

export interface TriageTicket {
  subject: string;
  body: string;
}

export interface GeminiSchemaTypes {
  OBJECT: string;
  STRING: string;
  ARRAY: string;
  BOOLEAN: string;
  NUMBER: string;
}

export interface GeminiClient {
  models: {
    generateContent: (request: any) => Promise<{ text?: string }>;
  };
}

export interface VerifiedTriageInput {
  ticket: TriageTicket;
  generateCandidate: (input: {
    ticket: TriageTicket;
    correctionReason?: string;
  }) => Promise<unknown>;
  judgeCandidate: (input: {
    ticket: TriageTicket;
    candidate: TriageCandidate;
  }) => Promise<TriageJudgeResult>;
}

export interface GeminiTriageInput {
  input: TriageTicket;
  ai: GeminiClient;
  type: GeminiSchemaTypes;
}
