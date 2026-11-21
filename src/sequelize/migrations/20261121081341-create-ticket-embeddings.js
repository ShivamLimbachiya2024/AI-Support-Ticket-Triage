'use strict';
require('pgvector/sequelize');
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('ticket_embeddings', {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true, allowNull: false },
      ticket_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'tickets', key: 'id' },
        onDelete: 'CASCADE',
      },
      embedding_model: { type: Sequelize.STRING(100), allowNull: false },
      embedding: { type: Sequelize.VECTOR(1536), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('ticket_embeddings', ['ticket_id'], { unique: true });
    await queryInterface.addIndex(
      'ticket_embeddings',
      [{ name: 'embedding', operator: 'vector_cosine_ops' }],
      { name: 'ticket_embeddings_embedding_hnsw', using: 'hnsw' }
    );
  },
  async down(queryInterface) {
    await queryInterface.dropTable('ticket_embeddings');
  },
};
