import { Table, Model, Column } from 'sequelize-typescript';
import { DataTypes } from 'sequelize';
import type ITicketEmbedding from '../interface/ticket_embeddings.interface';

require('pgvector/sequelize');

@Table({ tableName: 'ticket_embeddings', underscored: true })
export default class TicketEmbedding extends Model implements ITicketEmbedding {
  @Column({ type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true }) declare id: number;
  @Column({ type: DataTypes.BIGINT, allowNull: false }) declare ticket_id: number;
  @Column({ type: DataTypes.STRING, allowNull: false }) declare embedding_model: string;
  @Column({ type: (DataTypes as any).VECTOR(1536), allowNull: false }) declare embedding: number[];
}
