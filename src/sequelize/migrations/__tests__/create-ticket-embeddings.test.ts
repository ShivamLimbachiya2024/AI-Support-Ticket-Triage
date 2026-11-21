jest.mock('pgvector/sequelize', () => ({}));

const migration = require('../20261121081341-create-ticket-embeddings');

test('creates the ticket embedding column at 1536 dimensions', async () => {
  const query_interface = {
    createTable: jest.fn().mockResolvedValue(undefined),
    addIndex: jest.fn().mockResolvedValue(undefined),
  };
  const sequelize_types = {
    BIGINT: 'BIGINT',
    STRING: (length: number) => `STRING(${length})`,
    VECTOR: (dimension: number) => `VECTOR(${dimension})`,
    DATE: 'DATE',
  };

  await migration.up(query_interface, sequelize_types);

  const table_definition = query_interface.createTable.mock.calls[0][1];
  expect(table_definition.embedding).toEqual({ type: 'VECTOR(1536)', allowNull: false });
});
