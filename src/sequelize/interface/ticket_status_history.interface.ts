export default interface ITicketStatusHistory {
  id?: number;
  ticket_id: number;
  previous_status?: string | null;
  new_status: string;
  reason: string;
  retry_count: number;
  created_at?: Date;
  updated_at?: Date;
}
