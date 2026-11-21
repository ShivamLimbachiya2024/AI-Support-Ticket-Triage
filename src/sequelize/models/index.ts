import { Sequelize } from 'sequelize-typescript';
import { DATABASE_URL } from '../../config';
import User from './users.modal';
import Ticket from './tickets.modal';
import TriageResult from './triage_results.modal';
import TriageCache from './triage_cache.modal';
import TicketEmbedding from './ticket_embeddings.modal';
import TicketStatusHistory from './ticket_status_history.modal';
const db = new Sequelize(DATABASE_URL, {
  dialect: 'postgres',
  logging: false,
  models: [User, Ticket, TriageResult, TriageCache, TicketEmbedding, TicketStatusHistory],
});
Ticket.hasOne(TriageResult, { foreignKey: 'ticket_id', as: 'triage_result' });
TriageResult.belongsTo(Ticket, { foreignKey: 'ticket_id' });
export default db;
