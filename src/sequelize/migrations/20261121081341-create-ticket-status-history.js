'use strict';
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('ticket_status_history', {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false },
      ticket_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'tickets', key: 'id' },
        onDelete: 'CASCADE',
      },
      previous_status: { type: Sequelize.STRING(30), allowNull: true },
      new_status: { type: Sequelize.STRING(30), allowNull: false },
      reason: { type: Sequelize.TEXT, allowNull: false },
      retry_count: { type: Sequelize.INTEGER, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('ticket_status_history', ['ticket_id', 'created_at'], {
      unique: false,
    });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('ticket_status_history');
  },
};
