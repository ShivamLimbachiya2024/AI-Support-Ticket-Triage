'use strict';
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('triage_cache', {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false },
      text_hash: { type: Sequelize.STRING(64), allowNull: false },
      model_name: { type: Sequelize.STRING(100), allowNull: false },
      prompt_version: { type: Sequelize.STRING(100), allowNull: false },
      category: { type: Sequelize.STRING(30), allowNull: false },
      priority: { type: Sequelize.STRING(30), allowNull: false },
      summary: { type: Sequelize.TEXT, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('triage_cache', ['text_hash', 'model_name', 'prompt_version'], {
      unique: true,
    });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('triage_cache');
  },
};
