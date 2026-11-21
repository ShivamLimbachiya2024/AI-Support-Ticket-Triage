'use strict';
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('triage_results', {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false },
      ticket_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'tickets', key: 'id' },
        onDelete: 'CASCADE',
      },
      category: { type: Sequelize.STRING(30), allowNull: false },
      priority: { type: Sequelize.STRING(30), allowNull: false },
      summary: { type: Sequelize.TEXT, allowNull: false },
      model_name: { type: Sequelize.STRING(100), allowNull: false },
      prompt_version: { type: Sequelize.STRING(100), allowNull: false },
      source: { type: Sequelize.STRING(20), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('triage_results', ['ticket_id'], { unique: true });
    await queryInterface.addIndex('triage_results', ['category', 'priority'], { unique: false });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('triage_results');
  },
};
