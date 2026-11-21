import { Response } from 'express';
import db from '../../../sequelize/models';
import Ticket from '../../../sequelize/models/tickets.modal';
import TriageResult from '../../../sequelize/models/triage_results.modal';
import TicketStatusHistory from '../../../sequelize/models/ticket_status_history.modal';
import { AuthRequest } from '../../../middleware';
import { USER_ROLE } from '../../auth/enum/role';
import { TRIAGE_STATUS, TICKET_STATUS_REASON } from '../enum';
import { QueueAction, QueueName, sendToQueue } from '../../../rabbitmq';
import type { ListTicketsQuery } from '../validation-schema';
import { logger } from '../../../logger';

export const submitTicket = async (req: AuthRequest, res: Response) => {
  const requestId = req.requestId ?? 'unknown';
  const { subject, body, customer_email: submittedEmail } = req.body;
  const customerEmail = req.role === USER_ROLE.SUPPORT ? submittedEmail : req.userEmail;
  logger.info(`Request ${requestId} ticket submission started for user ${req.userId}`);

  if (
    req.role !== USER_ROLE.SUPPORT &&
    submittedEmail.toLowerCase() !== customerEmail?.toLowerCase()
  ) {
    logger.warn(
      `Request ${requestId} ticket submission rejected because the email did not match user ${req.userId}`
    );
    res.status(400).json({ message: 'Ticket email must match the authenticated account' });
    return;
  }

  logger.info(`Request ${requestId} ticket submission transaction started for user ${req.userId}`);
  const ticket = await db.transaction(async (transaction) => {
    logger.info(`Request ${requestId} creating a pending ticket for user ${req.userId}`);
    const created = await Ticket.create(
      {
        customer_id: req.userId,
        subject,
        body,
        customer_email: customerEmail,
        triage_status: TRIAGE_STATUS.PENDING,
        retry_count: 0,
        processing_attempt: 0,
      },
      { transaction }
    );

    logger.info(
      `Request ${requestId} ticket ${created.id} created with status ${TRIAGE_STATUS.PENDING}`
    );
    logger.info(
      `Request ${requestId} recording the initial status history for ticket ${created.id}`
    );
    await TicketStatusHistory.create(
      {
        ticket_id: created.id,
        new_status: TRIAGE_STATUS.PENDING,
        reason: TICKET_STATUS_REASON.SUBMITTED,
        retry_count: 0,
      },
      { transaction }
    );
    logger.info(`Request ${requestId} initial status history recorded for ticket ${created.id}`);

    // The confirmed message becomes consumable when this transaction commits.
    logger.info(
      `Request ${requestId} publishing ticket ${created.id} to ${QueueName.TICKET_PROCESSING}`
    );
    await sendToQueue({
      queueName: QueueName.TICKET_PROCESSING,
      action: QueueAction.PROCESS_TICKET,
      payload: { ticketId: Number(created.id) },
    });
    logger.info(`Request ${requestId} processing message confirmed for ticket ${created.id}`);

    return created;
  });

  logger.info(`Request ${requestId} ticket ${ticket.id} submission transaction committed`);
  res.status(202).json({ id: ticket.id, triage_status: ticket.triage_status });
  logger.info(
    `Request ${requestId} returned ticket ${ticket.id} with status ${ticket.triage_status}`
  );
};
export const getTicket = async (req: AuthRequest, res: Response) => {
  const requestId = req.requestId ?? 'unknown';
  logger.info(
    `Request ${requestId} ticket lookup started for ticket ${req.params.id} and user ${req.userId}`
  );
  const ticket = await Ticket.findByPk(req.params.id);
  logger.info(`Request ${requestId} ticket lookup completed for ticket ${req.params.id}`);

  if (!ticket || (req.role !== USER_ROLE.SUPPORT && Number(ticket.customer_id) !== req.userId)) {
    logger.warn(
      `Request ${requestId} ticket ${req.params.id} was not found or was not accessible to user ${req.userId}`
    );
    res.status(404).json({ message: 'Ticket not found' });
    return;
  }

  if (req.role !== USER_ROLE.SUPPORT) {
    logger.info(
      `Request ${requestId} returning status-only details for customer-owned ticket ${ticket.id}`
    );
    res.json({ id: ticket.id, triage_status: ticket.triage_status });
    logger.info(`Request ${requestId} returned ticket ${ticket.id} status ${ticket.triage_status}`);
    return;
  }

  logger.info(`Request ${requestId} triage result lookup started for ticket ${ticket.id}`);
  const result = await TriageResult.findOne({
    where: { ticket_id: ticket.id },
    attributes: [
      'id',
      'ticket_id',
      'category',
      'priority',
      'summary',
      'confidence',
      'model_name',
      'prompt_version',
      'source',
      'createdAt',
      'updatedAt',
    ],
  });
  logger.info(
    `Request ${requestId} triage result lookup completed for ticket ${ticket.id}: ${result ? 'result found' : 'result not available'}`
  );
  res.json({ ticket, triage_result: result });
  logger.info(`Request ${requestId} returned support details for ticket ${ticket.id}`);
};
export const listTickets = async (req: AuthRequest, res: Response) => {
  const requestId = req.requestId ?? 'unknown';
  logger.info(`Request ${requestId} ticket list started for user ${req.userId}`);
  if (req.role !== USER_ROLE.SUPPORT) {
    logger.warn(
      `Request ${requestId} ticket list rejected because user ${req.userId} is not support`
    );
    res.status(403).json({ message: 'Support access required' });
    return;
  }
  const { status, category, priority, page, limit } = req.validatedQuery as ListTicketsQuery;
  logger.info(
    `Request ${requestId} ticket list filters prepared: status ${status ?? 'any'}, category ${category ?? 'any'}, priority ${priority ?? 'any'}, page ${page}, limit ${limit}`
  );
  const resultWhere: Record<string, string> = {};
  if (category) resultWhere.category = category;
  if (priority) resultWhere.priority = priority;
  logger.info(`Request ${requestId} ticket list database query started`);
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
          'confidence',
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
  logger.info(
    `Request ${requestId} ticket list query completed with ${rows.length} rows from ${count} total`
  );
  res.json({ data: rows, page, limit, total: count });
  logger.info(`Request ${requestId} ticket list response returned`);
};
