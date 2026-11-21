'use strict';
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('tickets', {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false },
      customer_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onDelete: 'CASCADE',
      },
      subject: { type: Sequelize.STRING(255), allowNull: false },
      body: { type: Sequelize.TEXT, allowNull: false },
      customer_email: { type: Sequelize.STRING(255), allowNull: false },
      triage_status: { type: Sequelize.STRING(30), allowNull: false },
      status_reason: { type: Sequelize.TEXT, allowNull: true },
      retry_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      last_retry_at: { type: Sequelize.DATE, allowNull: true },
      processing_started_at: { type: Sequelize.DATE, allowNull: true },
      processing_attempt: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      duplicate_of_ticket_id: { type: Sequelize.BIGINT, allowNull: true },
      completed_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('tickets', ['customer_id', 'created_at'], { unique: false });
    await queryInterface.addIndex('tickets', ['triage_status', 'created_at'], { unique: false });
    await queryInterface.addConstraint('tickets', {
      fields: ['duplicate_of_ticket_id'],
      type: 'foreign key',
      name: 'tickets_duplicate_of_ticket_id_fkey',
      references: { table: 'tickets', field: 'id' },
      onDelete: 'SET NULL',
    });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('tickets');
  },
};
