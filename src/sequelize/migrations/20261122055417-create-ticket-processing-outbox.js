'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        'ticket_processing_outbox',
        {
          id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false },
          ticket_id: {
            type: Sequelize.BIGINT,
            allowNull: false,
            references: { model: 'tickets', key: 'id' },
            onDelete: 'CASCADE',
          },
          created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        },
        { transaction }
      );

      const Ticket = queryInterface.sequelize.define(
        'TicketProcessingOutboxBackfill',
        {
          id: { type: Sequelize.BIGINT, primaryKey: true },
          triage_status: { type: Sequelize.STRING },
        },
        { tableName: 'tickets', timestamps: false }
      );
      const pendingTickets = await Ticket.findAll({
        attributes: ['id'],
        where: { triage_status: 'pending' },
        raw: true,
        transaction,
      });
      if (pendingTickets.length > 0) {
        await queryInterface.bulkInsert(
          'ticket_processing_outbox',
          pendingTickets.map((ticket) => ({ ticket_id: ticket.id, created_at: new Date() })),
          { transaction }
        );
      }
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable('ticket_processing_outbox', { transaction });
    });
  },
};
