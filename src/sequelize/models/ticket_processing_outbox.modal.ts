import { Table, Model, Column } from 'sequelize-typescript';
import { DataTypes } from 'sequelize';
import type ITicketProcessingOutbox from '../interface/ticket_processing_outbox.interface';

@Table({ tableName: 'ticket_processing_outbox', timestamps: false, underscored: true })
export default class TicketProcessingOutbox extends Model implements ITicketProcessingOutbox {
  @Column({ type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true }) declare id: number;
  @Column({ type: DataTypes.BIGINT, allowNull: false }) declare ticket_id: number;
  @Column({ type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW })
  declare created_at: Date;
}
