export default interface ITicketEmbedding {
  id?: number;
  ticket_id: number;
  embedding_model: string;
  embedding: number[];
  created_at?: Date;
  updated_at?: Date;
}
