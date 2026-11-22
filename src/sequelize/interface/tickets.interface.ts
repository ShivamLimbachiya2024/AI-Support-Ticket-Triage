export default interface ITicket {
  id?: number;
  customer_id: number;
  subject: string;
  body: string;
  customer_email: string;
  triage_status: string;
  status_reason?: string | null;
  triage_failure_code?: string | null;
  retry_count: number;
  last_retry_at?: Date | null;
  processing_started_at?: Date | null;
  processing_attempt: number;
  duplicate_of_ticket_id?: number | null;
  completed_at?: Date | null;
  created_at?: Date;
  updated_at?: Date;
}
