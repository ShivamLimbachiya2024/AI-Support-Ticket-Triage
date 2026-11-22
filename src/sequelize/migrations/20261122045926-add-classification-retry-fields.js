'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.addColumn(
        'tickets',
        'triage_failure_code',
        {
          type: Sequelize.STRING,
          allowNull: true,
        },
        { transaction }
      );
      await queryInterface.addColumn(
        'ticket_status_history',
        'actor_user_id',
        {
          type: Sequelize.BIGINT,
          allowNull: true,
        },
        { transaction }
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeColumn('ticket_status_history', 'actor_user_id', { transaction });
      await queryInterface.removeColumn('tickets', 'triage_failure_code', { transaction });
    });
  },
};
