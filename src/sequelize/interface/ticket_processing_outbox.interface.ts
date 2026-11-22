export default interface ITicketProcessingOutbox {
  id?: number;
  ticket_id: number;
  created_at?: Date;
}
