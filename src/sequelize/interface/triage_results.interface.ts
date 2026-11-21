export default interface ITriageResult {
  id?: number;
  ticket_id: number;
  category: string;
  priority: string;
  summary: string;
  model_name: string;
  prompt_version: string;
  source: string;
  created_at?: Date;
  updated_at?: Date;
}
