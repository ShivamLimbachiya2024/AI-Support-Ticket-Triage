export default interface ITriageCache {
  id?: number;
  text_hash: string;
  model_name: string;
  prompt_version: string;
  category: string;
  priority: string;
  summary: string;
  created_at?: Date;
  updated_at?: Date;
}
