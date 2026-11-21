'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('triage_results', 'confidence', {
      type: Sequelize.FLOAT,
      allowNull: true,
    });
    await queryInterface.addColumn('triage_cache', 'confidence', {
      type: Sequelize.FLOAT,
      allowNull: true,
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('triage_cache', 'confidence');
    await queryInterface.removeColumn('triage_results', 'confidence');
  },
};
