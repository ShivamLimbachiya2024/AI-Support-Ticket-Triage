import { Response } from 'express';
import db from '../../../sequelize/models';
import Ticket from '../../../sequelize/models/tickets.modal';
import TriageResult from '../../../sequelize/models/triage_results.modal';
import TicketStatusHistory from '../../../sequelize/models/ticket_status_history.modal';
import { AuthRequest } from '../../../middleware';
import { USER_ROLE } from '../../auth/enum/role';
import { TRIAGE_STATUS } from '../enum';
import { QueueAction, QueueName, sendToQueue } from '../../../rabbitmq';
import type { ListTicketsQuery } from '../validation-schema';

export const submitTicket = async (req: AuthRequest, res: Response) => {
  const ticket = await db.transaction(async (transaction) => {
    const created = await Ticket.create(
      {
        customer_id: req.userId,
        ...req.body,
        triage_status: TRIAGE_STATUS.PENDING,
        retry_count: 0,
        processing_attempt: 0,
      },
      { transaction }
    );
    await TicketStatusHistory.create(
      {
        ticket_id: created.id,
        new_status: TRIAGE_STATUS.PENDING,
        reason: 'Ticket submitted',
        retry_count: 0,
      },
      { transaction }
    );

    // The confirmed message becomes consumable when this transaction commits.
    await sendToQueue({
      queueName: QueueName.TICKET_PROCESSING,
      action: QueueAction.PROCESS_TICKET,
      payload: { ticketId: Number(created.id) },
    });

    return created;
  });

  res.status(202).json({ id: ticket.id, triage_status: ticket.triage_status });
};
export const getTicket = async (req: AuthRequest, res: Response) => {
  const ticket = await Ticket.findByPk(req.params.id);
  if (!ticket || (req.role !== USER_ROLE.SUPPORT && Number(ticket.customer_id) !== req.userId)) {
    res.status(404).json({ message: 'Ticket not found' });
    return;
  }
  if (req.role !== USER_ROLE.SUPPORT) {
    res.json({ id: ticket.id, triage_status: ticket.triage_status });
    return;
  }
  const result = await TriageResult.findOne({ where: { ticket_id: ticket.id } });
  res.json({ ticket, triage_result: result });
};
export const listTickets = async (req: AuthRequest, res: Response) => {
  if (req.role !== USER_ROLE.SUPPORT) {
    res.status(403).json({ message: 'Support access required' });
    return;
  }
  const { status, category, priority, page, limit } = req.validatedQuery as ListTicketsQuery;
  const resultWhere: Record<string, string> = {};
  if (category) resultWhere.category = category;
  if (priority) resultWhere.priority = priority;
  const { rows, count } = await Ticket.findAndCountAll({
    where: status ? { triage_status: status } : {},
    attributes: [
      'id',
      'customer_id',
      'subject',
      'body',
      'customer_email',
      'triage_status',
      'status_reason',
      'retry_count',
      'last_retry_at',
      'processing_started_at',
      'processing_attempt',
      'duplicate_of_ticket_id',
      'completed_at',
      'createdAt',
      'updatedAt',
    ],
    include: [
      {
        model: TriageResult,
        as: 'triage_result',
        required: Boolean(category || priority),
        where: resultWhere,
        attributes: [
          'id',
          'ticket_id',
          'category',
          'priority',
          'summary',
          'model_name',
          'prompt_version',
          'source',
          'createdAt',
          'updatedAt',
        ],
      },
    ],
    distinct: true,
    order: [['created_at', 'DESC']],
    limit,
    offset: (page - 1) * limit,
  });
  res.json({ data: rows, page, limit, total: count });
};
